-- Grocery Voice: integration credentials and Home Assistant (Alexa) sync

-- ---------------------------------------------------------------------------
-- Scoped, revocable credentials for Siri Shortcuts and other push sources
-- ---------------------------------------------------------------------------
create table public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  -- Sources this credential may submit as.
  allowed_sources public.item_source[] not null default array['siri']::public.item_source[],
  scopes text[] not null default array['items:write'],
  -- Public lookup half of the token (gv_<prefix>_<secret>). Safe to display.
  token_prefix text not null unique check (token_prefix ~ '^[A-Za-z0-9]{8,16}$'),
  -- SHA-256 hex of the full token. Never exposed to clients.
  token_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id)
);

create index integration_credentials_household_idx
  on public.integration_credentials (household_id);

-- ---------------------------------------------------------------------------
-- Pull connections (Home Assistant exposing Alexa's shopping list)
-- ---------------------------------------------------------------------------
create type public.integration_health as enum ('unknown', 'healthy', 'degraded', 'failing', 'disabled');

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  provider text not null check (provider in ('home_assistant')),
  label text not null check (char_length(label) between 1 and 60),
  base_url text not null check (base_url ~ '^https?://'),
  entity_id text not null check (entity_id ~ '^todo\.[a-z0-9_]+$'),
  -- One-way today. 'two_way' is reserved for a future adapter capability.
  sync_direction text not null default 'inbound' check (sync_direction in ('inbound')),
  poll_interval_seconds int not null default 300 check (poll_interval_seconds between 60 and 86400),
  enabled boolean not null default true,
  health public.integration_health not null default 'unknown',
  consecutive_failures int not null default 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  next_poll_at timestamptz not null default now(),
  -- Lease so overlapping scheduler runs never sync the same connection twice.
  lease_until timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger integration_connections_touch before update on public.integration_connections
  for each row execute function public.touch_updated_at();

-- Encrypted Home Assistant long-lived access token. Server-only.
create table public.integration_connection_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  encrypted_token text not null,
  updated_at timestamptz not null default now()
);

-- External item -> internal item. This is the durable record that makes
-- re-reading the same Alexa list idempotent.
create table public.external_item_mappings (
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  external_id text not null,
  household_id uuid not null references public.households (id) on delete cascade,
  item_id uuid references public.shopping_items (id) on delete set null,
  external_summary text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (connection_id, external_id)
);

create table public.sync_checkpoints (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  last_successful_sync_at timestamptz,
  last_seen_count int not null default 0,
  -- Opaque adapter cursor (a content hash for Home Assistant, which has no cursor API).
  cursor text,
  updated_at timestamptz not null default now()
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  fetched int not null default 0,
  imported int not null default 0,
  already_mapped int not null default 0,
  error text
);

create index sync_runs_connection_idx on public.sync_runs (connection_id, started_at desc);

-- Claim connections that are due, with a lease. Called by the scheduler.
create or replace function public.claim_due_connections(p_limit int, p_lease_seconds int)
returns setof public.integration_connections
language sql
security definer
set search_path = ''
as $$
  update public.integration_connections c
  set lease_until = now() + make_interval(secs => p_lease_seconds)
  where c.id in (
    select id from public.integration_connections
    where enabled
      and next_poll_at <= now()
      and (lease_until is null or lease_until < now())
    order by next_poll_at
    limit p_limit
    for update skip locked
  )
  returning c.*;
$$;

revoke all on function public.claim_due_connections(int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.integration_credentials enable row level security;
alter table public.integration_connections enable row level security;
alter table public.integration_connection_secrets enable row level security;
alter table public.external_item_mappings enable row level security;
alter table public.sync_checkpoints enable row level security;
alter table public.sync_runs enable row level security;

-- Credentials: owners/admins see every credential; members see their own.
-- token_hash is withheld from client roles via column privileges.
create policy credentials_select on public.integration_credentials
  for select to authenticated
  using (
    public.is_household_member(household_id)
    and (
      created_by = auth.uid()
      or public.has_household_role(household_id, array['owner', 'admin']::public.household_role[])
    )
  );

revoke select on public.integration_credentials from anon, authenticated;
grant select (
  id, household_id, created_by, label, allowed_sources, scopes, token_prefix,
  created_at, last_used_at, revoked_at, revoked_by
) on public.integration_credentials to authenticated;
revoke insert, update, delete on public.integration_credentials from anon, authenticated;

create policy connections_select on public.integration_connections
  for select to authenticated
  using (public.is_household_member(household_id));

revoke insert, update, delete on public.integration_connections from anon, authenticated;

create policy mappings_select on public.external_item_mappings
  for select to authenticated
  using (public.is_household_member(household_id));

create policy sync_runs_select on public.sync_runs
  for select to authenticated
  using (public.is_household_member(household_id));

-- integration_connection_secrets and sync_checkpoints: no client policies.
revoke all on public.integration_connection_secrets from anon, authenticated;
