-- Supabase Cron schedule. Run ONCE per environment in the SQL editor (not a
-- migration: the app URL and secret differ per environment).
--
-- Prerequisites (Dashboard → Integrations): enable "Cron" (pg_cron) and
-- "pg_net". Replace the two placeholders below first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the app URL and shared secret in Vault, not in the job text.
select vault.create_secret('https://YOUR-APP.vercel.app', 'grocery_voice_app_url');
select vault.create_secret('REPLACE-WITH-CRON_SECRET', 'grocery_voice_cron_secret');

create or replace function public.grocery_voice_call(p_path text)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'grocery_voice_app_url') || p_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'grocery_voice_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$;

revoke all on function public.grocery_voice_call(text) from public, anon, authenticated;

-- Reminders + email delivery every 5 minutes. Handlers are idempotent, so
-- overlapping or repeated runs cannot double-send.
select cron.schedule('grocery-voice-reminders', '*/5 * * * *', $$select public.grocery_voice_call('/api/cron/reminders')$$);

-- Home Assistant polling every minute; each connection keeps its own interval.
select cron.schedule('grocery-voice-sync', '* * * * *', $$select public.grocery_voice_call('/api/cron/sync')$$);

-- Inspect:   select * from cron.job_run_details order by start_time desc limit 20;
--            select * from net._http_response order by created desc limit 20;
-- Remove:    select cron.unschedule('grocery-voice-reminders');
