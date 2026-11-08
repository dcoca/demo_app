-- Grocery Voice: schedules, notification preferences, notification history

create table public.household_schedules (
  household_id uuid primary key references public.households (id) on delete cascade,
  enabled boolean not null default true,
  frequency text not null default 'weekly' check (frequency in ('weekly', 'custom')),
  -- weekly: 0 = Sunday ... 6 = Saturday
  shopping_weekday int not null default 0 check (shopping_weekday between 0 and 6),
  -- custom: every N days counted from anchor_date (a shopping day)
  interval_days int check (interval_days is null or interval_days between 1 and 60),
  anchor_date date,
  -- The review reminder goes out this many days before the shopping day.
  review_lead_days int not null default 1 check (review_lead_days between 0 and 6),
  review_reminder_time time not null default '18:00',
  order_cutoff_time time not null default '10:00',
  timezone text not null default 'America/New_York',
  -- Persisted, server-computed. The scheduler never relies on client timers.
  next_reminder_at timestamptz,
  next_shopping_date date,
  last_reminded_shopping_date date,
  updated_at timestamptz not null default now(),
  check (frequency = 'weekly' or (interval_days is not null and anchor_date is not null))
);

create index household_schedules_due_idx
  on public.household_schedules (next_reminder_at)
  where enabled;

create trigger household_schedules_touch before update on public.household_schedules
  for each row execute function public.touch_updated_at();

create table public.notification_preferences (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email_reminders boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create type public.notification_status as enum ('pending', 'sending', 'sent', 'failed', 'dead');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('review_reminder', 'invitation')),
  channel text not null default 'email' check (channel in ('email')),
  -- e.g. review_reminder:<household>:<shopping date>:<user>. Repeated
  -- scheduler executions collide here instead of sending twice.
  dedupe_key text not null unique,
  status public.notification_status not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  last_error text,
  subject text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index notifications_household_idx on public.notifications (household_id, created_at desc);
create index notifications_due_idx on public.notifications (next_attempt_at)
  where status in ('pending', 'failed', 'sending');

-- Claim deliverable notifications with a lease. A 'sending' row whose lease
-- expired (worker crashed mid-send) becomes claimable again.
create or replace function public.claim_notifications(p_limit int, p_lease_seconds int)
returns setof public.notifications
language sql
security definer
set search_path = ''
as $$
  update public.notifications n
  set status = 'sending',
      attempts = n.attempts + 1,
      claimed_until = now() + make_interval(secs => p_lease_seconds)
  where n.id in (
    select id from public.notifications
    where next_attempt_at <= now()
      and (
        status in ('pending', 'failed')
        or (status = 'sending' and claimed_until < now())
      )
      and attempts < max_attempts
    order by next_attempt_at
    limit p_limit
    for update skip locked
  )
  returning n.*;
$$;

revoke all on function public.claim_notifications(int, int) from public, anon, authenticated;

-- Simple named lock so overlapping cron invocations do not run the same job.
create table public.job_locks (
  job text primary key,
  locked_until timestamptz not null,
  holder text not null
);

create or replace function public.try_acquire_job_lock(p_job text, p_holder text, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  insert into public.job_locks (job, locked_until, holder)
  values (p_job, now() + make_interval(secs => p_ttl_seconds), p_holder)
  on conflict (job) do update
    set locked_until = excluded.locked_until, holder = excluded.holder
    where public.job_locks.locked_until < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_job_lock(p_job text, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.job_locks where job = p_job and holder = p_holder;
$$;

revoke all on function public.try_acquire_job_lock(text, text, int) from public, anon, authenticated;
revoke all on function public.release_job_lock(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.household_schedules enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.job_locks enable row level security;

create policy schedules_select on public.household_schedules
  for select to authenticated
  using (public.is_household_member(household_id));

create policy schedules_update on public.household_schedules
  for update to authenticated
  using (public.has_household_role(household_id, array['owner', 'admin']::public.household_role[]))
  with check (public.has_household_role(household_id, array['owner', 'admin']::public.household_role[]));

create policy prefs_select on public.notification_preferences
  for select to authenticated
  using (user_id = auth.uid() and public.is_household_member(household_id));

create policy prefs_insert on public.notification_preferences
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_household_member(household_id));

create policy prefs_update on public.notification_preferences
  for update to authenticated
  using (user_id = auth.uid() and public.is_household_member(household_id))
  with check (user_id = auth.uid() and public.is_household_member(household_id));

-- Notification history is visible to the household.
create policy notifications_select on public.notifications
  for select to authenticated
  using (public.is_household_member(household_id));
