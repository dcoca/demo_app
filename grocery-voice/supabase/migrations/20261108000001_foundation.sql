-- Grocery Voice: foundation (profiles, households, membership, invitations)
--
-- Conventions
--   * Every household-owned table carries household_id and has RLS enabled.
--   * Membership checks go through SECURITY DEFINER helpers so policies on
--     household_members do not recurse into themselves.
--   * Helpers pin search_path = '' and fully qualify every name.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(coalesce(new.email, 'member'), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Households and membership
-- ---------------------------------------------------------------------------
create type public.household_role as enum ('owner', 'admin', 'member');

-- How an explicit add of an item that already exists (same normalized name
-- and unit, still active in the open cycle) is handled.
create type public.duplicate_policy as enum ('increase_quantity', 'separate_item');

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  duplicate_policy public.duplicate_policy not null default 'increase_quantity',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.household_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index household_members_user_idx on public.household_members (user_id);

-- True for trusted server callers. Checks the JWT role claim and, as a
-- fallback, the Postgres role PostgREST switched to (client roles cannot
-- assume service_role).
create or replace function public.is_service_caller()
returns boolean
language sql
stable
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or coalesce(current_setting('role', true), '') = 'service_role';
$$;

create or replace function public.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = p_household_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_household_role(
  p_household_id uuid,
  p_roles public.household_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = p_household_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- A household must always keep at least one owner.
create or replace function public.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_remaining int;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  -- Allow cascading deletes when the household itself is being removed.
  if not exists (select 1 from public.households h where h.id = old.household_id) then
    return coalesce(new, old);
  end if;

  select count(*) into v_remaining
  from public.household_members m
  where m.household_id = old.household_id
    and m.role = 'owner'
    and m.user_id <> old.user_id;

  if v_remaining = 0 then
    raise exception 'A household must keep at least one owner'
      using errcode = 'GV422';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger household_members_protect_last_owner
  before update or delete on public.household_members
  for each row execute function public.protect_last_owner();

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
create table public.household_invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role public.household_role not null default 'member' check (role <> 'owner'),
  -- SHA-256 of the invitation token. The raw token is only ever emailed.
  token_hash text not null unique,
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at timestamptz
);

create index household_invitations_household_idx
  on public.household_invitations (household_id);

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger households_touch before update on public.households
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invitations enable row level security;

-- Profiles: yourself, plus people you share a household with.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.household_members mine
      join public.household_members theirs
        on theirs.household_id = mine.household_id
      where mine.user_id = auth.uid()
        and theirs.user_id = profiles.id
    )
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Households: members read, owners/admins rename, owners delete.
-- Creation goes through create_household() so the creator becomes owner atomically.
create policy households_select on public.households
  for select to authenticated
  using (public.is_household_member(id));

create policy households_update on public.households
  for update to authenticated
  using (public.has_household_role(id, array['owner', 'admin']::public.household_role[]))
  with check (public.has_household_role(id, array['owner', 'admin']::public.household_role[]));

create policy households_delete on public.households
  for delete to authenticated
  using (public.has_household_role(id, array['owner']::public.household_role[]));

-- Members: visible to co-members. Owners change roles and remove anyone;
-- anyone may remove themselves (leave). Joining goes through accept_invitation().
create policy members_select on public.household_members
  for select to authenticated
  using (public.is_household_member(household_id));

create policy members_update_owner on public.household_members
  for update to authenticated
  using (public.has_household_role(household_id, array['owner']::public.household_role[]))
  with check (public.has_household_role(household_id, array['owner']::public.household_role[]));

create policy members_delete on public.household_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or public.has_household_role(household_id, array['owner']::public.household_role[])
  );

-- Invitations: owners and admins manage them.
create policy invitations_select on public.household_invitations
  for select to authenticated
  using (public.has_household_role(household_id, array['owner', 'admin']::public.household_role[]));

create policy invitations_insert on public.household_invitations
  for insert to authenticated
  with check (
    invited_by = auth.uid()
    and public.has_household_role(household_id, array['owner', 'admin']::public.household_role[])
  );

create policy invitations_update on public.household_invitations
  for update to authenticated
  using (public.has_household_role(household_id, array['owner', 'admin']::public.household_role[]))
  with check (public.has_household_role(household_id, array['owner', 'admin']::public.household_role[]));

-- Invitation acceptance: token proves possession, signed-in email must match.
create or replace function public.accept_invitation(p_token_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.household_invitations;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'GV401';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();

  select * into v_inv
  from public.household_invitations i
  where i.token_hash = p_token_hash
  for update;

  if not found or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'Invitation is invalid or expired' using errcode = 'GV404';
  end if;

  if v_inv.accepted_at is not null then
    if v_inv.accepted_by = auth.uid() then
      return v_inv.household_id; -- idempotent re-accept
    end if;
    raise exception 'Invitation is invalid or expired' using errcode = 'GV404';
  end if;

  if v_inv.email <> v_email then
    raise exception 'This invitation was sent to a different email address'
      using errcode = 'GV403';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (v_inv.household_id, auth.uid(), v_inv.role)
  on conflict (household_id, user_id) do nothing;

  update public.household_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_inv.id;

  return v_inv.household_id;
end;
$$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
