-- Grocery Voice: shopping cycles, items, idempotent item creation

create type public.cycle_status as enum ('open', 'closed');
create type public.item_status as enum ('active', 'completed', 'removed');
create type public.item_source as enum ('web', 'siri', 'alexa', 'home_assistant', 'api');

create table public.shopping_cycles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  sequence int not null,
  status public.cycle_status not null default 'open',
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (household_id, sequence)
);

-- Exactly one open cycle per household.
create unique index shopping_cycles_one_open
  on public.shopping_cycles (household_id)
  where status = 'open';

create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  cycle_id uuid not null references public.shopping_cycles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- Produced by the application's normalizeItemName(); used for duplicate detection.
  normalized_name text not null check (char_length(normalized_name) between 1 and 120),
  quantity numeric(10, 3) check (quantity is null or quantity > 0),
  unit text check (unit is null or char_length(unit) between 1 and 32),
  brand text check (brand is null or char_length(brand) between 1 and 80),
  notes text check (notes is null or char_length(notes) <= 500),
  organic boolean not null default false,
  upc text check (upc is null or upc ~ '^[0-9]{8,14}$'),
  status public.item_status not null default 'active',
  source public.item_source not null default 'web',
  added_by uuid references auth.users (id) on delete set null,
  -- Human label for non-user sources, e.g. "Siri (Dana's iPhone)".
  added_by_label text,
  -- clock_timestamp() so items added in one request keep their spoken order.
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  removed_at timestamptz,
  version int not null default 1
);

create index shopping_items_cycle_idx on public.shopping_items (cycle_id, status);
create index shopping_items_household_idx on public.shopping_items (household_id);
create index shopping_items_dup_idx
  on public.shopping_items (cycle_id, normalized_name)
  where status = 'active';

-- Immutable columns, status timestamps, optimistic-concurrency version.
create or replace function public.shopping_items_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.household_id <> old.household_id
     or new.added_by is distinct from old.added_by
     or new.source <> old.source
     or new.created_at <> old.created_at then
    raise exception 'Immutable item column changed' using errcode = 'GV422';
  end if;

  -- Items may only move between cycles of the same household (carry-over).
  if new.cycle_id <> old.cycle_id and not exists (
    select 1 from public.shopping_cycles c
    where c.id = new.cycle_id and c.household_id = new.household_id
  ) then
    raise exception 'Cycle belongs to another household' using errcode = 'GV422';
  end if;

  if new.status <> old.status then
    new.completed_at := case when new.status = 'completed' then now() else null end;
    new.removed_at := case when new.status = 'removed' then now() else null end;
  end if;

  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger shopping_items_before_update
  before update on public.shopping_items
  for each row execute function public.shopping_items_before_update();

-- Idempotency records for write APIs. A replay with the same key returns the
-- stored response; the same key with a different payload is rejected.
create table public.idempotency_keys (
  household_id uuid not null references public.households (id) on delete cascade,
  scope text not null,
  key text not null check (char_length(key) between 1 and 200),
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (household_id, scope, key)
);

-- Audit of every accepted voice/integration event.
create table public.ingestion_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  source public.item_source not null,
  external_event_id text not null,
  credential_id uuid,
  connection_id uuid,
  item_count int not null,
  created_at timestamptz not null default now(),
  unique (household_id, source, external_event_id)
);

-- ---------------------------------------------------------------------------
-- Cycle helper
-- ---------------------------------------------------------------------------
create or replace function public.ensure_open_cycle(p_household_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_seq int;
begin
  select id into v_id
  from public.shopping_cycles
  where household_id = p_household_id and status = 'open';
  if found then
    return v_id;
  end if;

  select coalesce(max(sequence), 0) + 1 into v_seq
  from public.shopping_cycles where household_id = p_household_id;

  insert into public.shopping_cycles (household_id, sequence)
  values (p_household_id, v_seq)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then -- lost a race; the other transaction created it
    select id into v_id
    from public.shopping_cycles
    where household_id = p_household_id and status = 'open';
  end if;
  return v_id;
end;
$$;

revoke all on function public.ensure_open_cycle(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- add_items: the single write path for new items (web, voice, sync)
-- ---------------------------------------------------------------------------
-- p_items: [{ name, normalized_name, quantity?, unit?, brand?, notes?, organic?, upc? }]
--
-- Duplicate rule (explicit, per household setting):
--   An incoming item matches an existing one when both are active in the open
--   cycle with the same normalized_name and the same unit (NULL = NULL).
--   increase_quantity: add the incoming quantity (missing quantity counts as 1).
--   separate_item:     always insert a new row.
--   "organic milk" vs "almond milk" never match because names differ.
--
-- Transport retries never change quantity: callers pass an idempotency key,
-- and a replay returns the first response without touching any rows.
create or replace function public.add_items(
  p_household_id uuid,
  p_source public.item_source,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_actor_user_id uuid default null,
  p_actor_label text default null,
  p_external_event_id text default null,
  p_credential_id uuid default null,
  p_connection_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_service boolean := public.is_service_caller();
  v_scope text := p_source::text;
  v_existing public.idempotency_keys;
  v_policy public.duplicate_policy;
  v_cycle uuid;
  v_item jsonb;
  v_idx int := 0;
  v_match public.shopping_items;
  v_id uuid;
  v_qty numeric;
  v_results jsonb := '[]'::jsonb;
  v_response jsonb;
begin
  -- Authorization. Service callers (route handlers) have already authenticated
  -- an integration credential or a user. Direct user callers may only add as
  -- themselves, from the web source, to a household they belong to.
  if not v_is_service then
    if auth.uid() is null or not public.is_household_member(p_household_id) then
      raise exception 'Not a member of this household' using errcode = 'GV403';
    end if;
    if p_source <> 'web' or p_actor_user_id is distinct from auth.uid()
       or p_credential_id is not null or p_connection_id is not null then
      raise exception 'Users may only add items as themselves' using errcode = 'GV403';
    end if;
  end if;

  if p_idempotency_key is null or char_length(p_idempotency_key) = 0 then
    raise exception 'Idempotency key required' using errcode = 'GV400';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'Between 1 and 50 items required' using errcode = 'GV400';
  end if;

  -- Serialize concurrent requests carrying the same key.
  perform pg_advisory_xact_lock(
    hashtextextended(p_household_id::text || '|' || v_scope || '|' || p_idempotency_key, 0)
  );

  select * into v_existing
  from public.idempotency_keys
  where household_id = p_household_id and scope = v_scope and key = p_idempotency_key;

  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception 'Idempotency key reused with a different payload'
        using errcode = 'GV409';
    end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;

  select duplicate_policy into v_policy
  from public.households where id = p_household_id;
  if not found then
    raise exception 'Household not found' using errcode = 'GV404';
  end if;

  v_cycle := public.ensure_open_cycle(p_household_id);

  -- Serialize item writes per cycle so two concurrent adds of "milk" cannot
  -- both miss each other and create two rows under increase_quantity.
  perform pg_advisory_xact_lock(hashtextextended('cycle|' || v_cycle::text, 0));

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := nullif(v_item ->> 'quantity', '')::numeric;
    v_match := null;

    if v_policy = 'increase_quantity' then
      select * into v_match
      from public.shopping_items s
      where s.cycle_id = v_cycle
        and s.status = 'active'
        and s.normalized_name = v_item ->> 'normalized_name'
        and s.unit is not distinct from nullif(v_item ->> 'unit', '')
      order by s.created_at
      limit 1
      for update;
    end if;

    if v_match.id is not null then
      update public.shopping_items
      set quantity = coalesce(quantity, 1) + coalesce(v_qty, 1),
          notes = case
            when nullif(v_item ->> 'notes', '') is null then notes
            when notes is null then v_item ->> 'notes'
            when position(v_item ->> 'notes' in notes) > 0 then notes
            else left(notes || '; ' || (v_item ->> 'notes'), 500)
          end
      where id = v_match.id
      returning id, quantity into v_id, v_qty;

      v_results := v_results || jsonb_build_object(
        'index', v_idx, 'action', 'merged', 'itemId', v_id,
        'name', v_match.name, 'quantity', v_qty);
    else
      insert into public.shopping_items (
        household_id, cycle_id, name, normalized_name, quantity, unit,
        brand, notes, organic, upc, source, added_by, added_by_label
      ) values (
        p_household_id, v_cycle,
        v_item ->> 'name',
        v_item ->> 'normalized_name',
        v_qty,
        nullif(v_item ->> 'unit', ''),
        nullif(v_item ->> 'brand', ''),
        nullif(v_item ->> 'notes', ''),
        coalesce((v_item ->> 'organic')::boolean, false),
        nullif(v_item ->> 'upc', ''),
        p_source,
        p_actor_user_id,
        p_actor_label
      )
      returning id into v_id;

      v_results := v_results || jsonb_build_object(
        'index', v_idx, 'action', 'created', 'itemId', v_id,
        'name', v_item ->> 'name', 'quantity', v_qty);
    end if;
    v_idx := v_idx + 1;
  end loop;

  if p_external_event_id is not null then
    insert into public.ingestion_events (
      household_id, source, external_event_id, credential_id, connection_id, item_count
    ) values (
      p_household_id, p_source, p_external_event_id, p_credential_id,
      p_connection_id, jsonb_array_length(p_items)
    );
  end if;

  v_response := jsonb_build_object('cycleId', v_cycle, 'results', v_results);

  insert into public.idempotency_keys (household_id, scope, key, request_hash, response)
  values (p_household_id, v_scope, p_idempotency_key, p_request_hash, v_response);

  return v_response || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.add_items(uuid, public.item_source, jsonb, text, text, uuid, text, text, uuid, uuid)
  from public, anon;
grant execute on function public.add_items(uuid, public.item_source, jsonb, text, text, uuid, text, text, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shopping_cycles enable row level security;
alter table public.shopping_items enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.ingestion_events enable row level security;

create policy cycles_select on public.shopping_cycles
  for select to authenticated
  using (public.is_household_member(household_id));

create policy items_select on public.shopping_items
  for select to authenticated
  using (public.is_household_member(household_id));

-- Members edit, complete, restore and soft-remove items. Inserts go through
-- add_items(); hard deletes are not allowed so history is preserved.
create policy items_update on public.shopping_items
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

create policy ingestion_events_select on public.ingestion_events
  for select to authenticated
  using (public.is_household_member(household_id));

-- idempotency_keys: no policies. Only add_items() (definer) and service_role.
