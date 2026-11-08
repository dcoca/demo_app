-- Grocery Voice: orders, snapshots, ordering-provider links, cycle rollover

create type public.order_status as enum (
  'draft',
  'ready_for_review',
  'approved',
  'link_generated',
  'handoff_opened',
  'completed_unverified',
  'archived'
);

-- One order per shopping cycle.
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  cycle_id uuid not null unique references public.shopping_cycles (id) on delete cascade,
  status public.order_status not null default 'draft',
  provider text not null default 'instacart',
  current_snapshot_id uuid,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  -- Set only on explicit user confirmation. Instacart's shopping-list link API
  -- gives no checkout signal, so this is never set from provider data today.
  completed_by uuid references auth.users (id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_household_idx on public.orders (household_id, created_at desc);

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- Versioned, immutable copy of exactly what was sent to the provider.
create table public.order_snapshots (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  version int not null,
  content_hash text not null,
  items jsonb not null,
  item_count int not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (order_id, version),
  unique (order_id, content_hash)
);

alter table public.orders
  add constraint orders_current_snapshot_fk
  foreign key (current_snapshot_id) references public.order_snapshots (id);

create type public.link_status as enum ('pending', 'ready', 'failed');

create table public.shopping_links (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  snapshot_id uuid not null references public.order_snapshots (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  provider text not null,
  status public.link_status not null default 'pending',
  url text,
  is_mock boolean not null default false,
  expires_at timestamptz,
  attempts int not null default 1,
  claimed_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  -- At most one link per snapshot and provider: retries reuse it.
  unique (snapshot_id, provider)
);

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  actor_id uuid references auth.users (id),
  note text,
  created_at timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, created_at);

-- ---------------------------------------------------------------------------
-- State machine (authoritative). Mirrored in src/features/orders/status.ts.
-- ---------------------------------------------------------------------------
create or replace function public.order_transition_allowed(
  p_from public.order_status,
  p_to public.order_status
)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('draft', 'ready_for_review'),
    ('draft', 'approved'),
    ('ready_for_review', 'approved'),
    ('ready_for_review', 'draft'),
    ('approved', 'link_generated'),
    ('approved', 'ready_for_review'),
    ('link_generated', 'link_generated'),
    ('link_generated', 'handoff_opened'),
    ('link_generated', 'approved'),
    ('handoff_opened', 'handoff_opened'),
    ('handoff_opened', 'link_generated'),
    ('handoff_opened', 'completed_unverified'),
    ('handoff_opened', 'approved'),
    ('completed_unverified', 'handoff_opened'),
    ('completed_unverified', 'archived')
  );
$$;

-- Compare-and-set transition with an audit event. Members only.
create or replace function public.transition_order(
  p_order_id uuid,
  p_to public.order_status,
  p_expected_from public.order_status[] default null,
  p_actor_id uuid default null,
  p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_service boolean := public.is_service_caller();
  v_actor uuid := case when v_is_service then p_actor_id else auth.uid() end;
  v_order public.orders;
  v_from public.order_status;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'GV404';
  end if;
  if not v_is_service and not public.is_household_member(v_order.household_id) then
    raise exception 'Order not found' using errcode = 'GV404';
  end if;
  if p_to = 'archived' then
    raise exception 'Use close_cycle to archive an order' using errcode = 'GV422';
  end if;

  v_from := v_order.status;
  if p_expected_from is not null and not (v_from = any (p_expected_from)) then
    raise exception 'Order is % (expected one of %)', v_from, p_expected_from
      using errcode = 'GV409';
  end if;
  if not public.order_transition_allowed(v_from, p_to) then
    raise exception 'Cannot move order from % to %', v_from, p_to using errcode = 'GV409';
  end if;

  update public.orders
  set status = p_to,
      approved_by = case when p_to = 'approved' then v_actor else approved_by end,
      approved_at = case when p_to = 'approved' then now() else approved_at end,
      completed_by = case
        when p_to = 'completed_unverified' then v_actor
        when v_from = 'completed_unverified' then null
        else completed_by end,
      completed_at = case
        when p_to = 'completed_unverified' then now()
        when v_from = 'completed_unverified' then null
        else completed_at end
  where id = p_order_id
  returning * into v_order;

  if v_from <> p_to then
    insert into public.order_events (order_id, household_id, from_status, to_status, actor_id, note)
    values (p_order_id, v_order.household_id, v_from, p_to, v_actor, p_note);
  end if;

  return v_order;
end;
$$;

revoke all on function public.transition_order(uuid, public.order_status, public.order_status[], uuid, text) from public, anon;
grant execute on function public.transition_order(uuid, public.order_status, public.order_status[], uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cycle rollover: archive the confirmed order, open the next cycle, and carry
-- over every active item that was NOT part of the ordered snapshot (for
-- example, "eggs" added through Alexa after the link was generated).
-- ---------------------------------------------------------------------------
create or replace function public.close_cycle(p_order_id uuid, p_actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_service boolean := public.is_service_caller();
  v_actor uuid := case when v_is_service then p_actor_id else auth.uid() end;
  v_order public.orders;
  v_new_cycle uuid;
  v_new_order uuid;
  v_seq int;
  v_carried int;
  v_snapshot_ids uuid[];
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or (not v_is_service and not public.is_household_member(v_order.household_id)) then
    raise exception 'Order not found' using errcode = 'GV404';
  end if;

  if v_order.status = 'archived' then
    -- Idempotent: return the cycle that replaced this one.
    select c.id into v_new_cycle from public.shopping_cycles c
    where c.household_id = v_order.household_id and c.status = 'open';
    return jsonb_build_object('newCycleId', v_new_cycle, 'carriedOver', 0, 'replayed', true);
  end if;
  if v_order.status <> 'completed_unverified' then
    raise exception 'Confirm the order was placed before closing the cycle'
      using errcode = 'GV409';
  end if;

  select coalesce(array_agg((e ->> 'itemId')::uuid), '{}') into v_snapshot_ids
  from public.order_snapshots s, jsonb_array_elements(s.items) e
  where s.id = v_order.current_snapshot_id;

  update public.shopping_cycles
  set status = 'closed', closed_at = now()
  where id = v_order.cycle_id;

  select max(sequence) + 1 into v_seq
  from public.shopping_cycles where household_id = v_order.household_id;

  insert into public.shopping_cycles (household_id, sequence)
  values (v_order.household_id, v_seq)
  returning id into v_new_cycle;

  insert into public.orders (household_id, cycle_id, provider)
  values (v_order.household_id, v_new_cycle, v_order.provider)
  returning id into v_new_order;

  insert into public.order_events (order_id, household_id, from_status, to_status, actor_id, note)
  values (v_new_order, v_order.household_id, null, 'draft', v_actor, 'New shopping cycle');

  update public.shopping_items
  set cycle_id = v_new_cycle
  where cycle_id = v_order.cycle_id
    and status = 'active'
    and not (id = any (v_snapshot_ids));
  get diagnostics v_carried = row_count;

  update public.orders set status = 'archived' where id = p_order_id;
  insert into public.order_events (order_id, household_id, from_status, to_status, actor_id, note)
  values (p_order_id, v_order.household_id, 'completed_unverified', 'archived', v_actor,
          format('Cycle closed; %s item(s) carried over', v_carried));

  return jsonb_build_object(
    'newCycleId', v_new_cycle, 'newOrderId', v_new_order,
    'carriedOver', v_carried, 'replayed', false);
end;
$$;

revoke all on function public.close_cycle(uuid, uuid) from public, anon;
grant execute on function public.close_cycle(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Household bootstrap: household + owner + open cycle + draft order + schedule
-- ---------------------------------------------------------------------------
create or replace function public.create_household(p_name text, p_timezone text default 'America/New_York')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_cycle uuid;
  v_order uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'GV401';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception 'Unknown timezone %', p_timezone using errcode = 'GV400';
  end if;

  insert into public.households (name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_household;

  insert into public.household_members (household_id, user_id, role)
  values (v_household, auth.uid(), 'owner');

  insert into public.shopping_cycles (household_id, sequence)
  values (v_household, 1)
  returning id into v_cycle;

  insert into public.orders (household_id, cycle_id)
  values (v_household, v_cycle)
  returning id into v_order;

  insert into public.order_events (order_id, household_id, to_status, actor_id, note)
  values (v_order, v_household, 'draft', auth.uid(), 'Household created');

  insert into public.household_schedules (household_id, timezone, enabled)
  values (v_household, p_timezone, false);

  -- notification_preferences for the owner come from the member trigger below.
  return v_household;
end;
$$;

revoke all on function public.create_household(text, text) from public, anon;
grant execute on function public.create_household(text, text) to authenticated;

-- Joining members get default notification preferences.
create or replace function public.member_default_prefs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_preferences (household_id, user_id)
  values (new.household_id, new.user_id)
  on conflict do nothing;
  return new;
end;
$$;

create trigger household_members_default_prefs
  after insert on public.household_members
  for each row execute function public.member_default_prefs();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.order_snapshots enable row level security;
alter table public.shopping_links enable row level security;
alter table public.order_events enable row level security;

-- Read-only to members; all writes go through definer functions or the server.
create policy orders_select on public.orders
  for select to authenticated using (public.is_household_member(household_id));
create policy snapshots_select on public.order_snapshots
  for select to authenticated using (public.is_household_member(household_id));
create policy links_select on public.shopping_links
  for select to authenticated using (public.is_household_member(household_id));
create policy order_events_select on public.order_events
  for select to authenticated using (public.is_household_member(household_id));

revoke insert, update, delete on public.orders, public.order_snapshots,
  public.shopping_links, public.order_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: members receive item and order changes (RLS applies).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.shopping_items, public.orders;
  end if;
end;
$$;
