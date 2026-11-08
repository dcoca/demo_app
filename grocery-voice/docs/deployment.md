# Deployment

Production is one Supabase project and one Vercel project. Order matters: the database first, then the app, then the scheduler that calls the app.

## 1. Supabase project

1. Create a project at supabase.com. Note the project ref, the publishable (anon) key and the secret (service_role) key.
2. Apply the schema:

   ```bash
   supabase link --project-ref <ref>
   supabase db push          # applies supabase/migrations/*. Do NOT run seed.sql in production.
   ```

3. **Authentication → URL Configuration**
   - Site URL: `https://YOUR-APP.vercel.app` (or your domain)
   - Redirect URLs: `https://YOUR-APP.vercel.app/auth/callback`
4. **Authentication → Sign In / Providers → Email**: keep "Confirm email" on.
5. **Authentication → SMTP**: configure a real sender. Supabase's built-in mailer is rate-limited and meant for testing.
6. **Database → Publications**: confirm `supabase_realtime` includes `shopping_items` and `orders`. The last migration adds them; this is a check, not a step.

## 2. Vercel

Import the repository and set the root directory to `grocery-voice`. Framework preset: Next.js.

Environment variables (Production, and Preview if previews should work):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable/anon key |
| `NEXT_PUBLIC_APP_URL` | the public URL; used in emails and Instacart link-backs |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key. Server-only. |
| `CRON_SECRET` | long random string; the scheduler sends it |
| `INTEGRATION_ENCRYPTION_KEY` | 32 random bytes, base64. Changing it makes stored Home Assistant tokens unreadable; members would have to reconnect. |
| `INSTACART_API_KEY` | leave empty to run in labelled mock mode |
| `INSTACART_ENV` | `production` once Instacart approves your key; `development` before that |
| `RESEND_API_KEY` | leave empty to log emails instead of sending |
| `EMAIL_FROM` | e.g. `Grocery Voice <reminders@yourdomain.com>`, on a domain verified in Resend |

Nothing secret has a `NEXT_PUBLIC_` prefix. `src/lib/env.ts` validates both groups at runtime and fails fast on a missing value.

Deploy, then check `https://YOUR-APP/api/health` returns `{"status":"ok"}`.

## 3. Supabase Cron

Open `supabase/cron.sql`, replace the app URL and `CRON_SECRET` placeholders, and run it once in the Supabase SQL editor. It:

- enables `pg_cron` and `pg_net`
- stores the URL and secret in Vault, so they don't appear in the job definition
- schedules `/api/cron/reminders` every 5 minutes and `/api/cron/sync` every minute

Both handlers are idempotent and take a database lock, so a slow run overlapping the next one is harmless.

Check it's running:

```sql
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;
select status_code, created from net._http_response order by created desc limit 10;
```

Expect `200` responses. A `401` means the secret in Vault doesn't match `CRON_SECRET` on Vercel.

## 4. Email

With Resend: verify your sending domain, create an API key, set `RESEND_API_KEY` and `EMAIL_FROM`. Each reminder is sent with its dedupe key as Resend's `Idempotency-Key`, so a retry after a timeout can't produce a second email. Failed sends retry at 1, 5, 25 minutes and so on (capped at 6 hours) for up to 5 attempts, then stop; every attempt is visible under Settings → Schedule → Notification history.

To use another provider, implement `EmailProvider` in `src/lib/notifications/email.ts` and select it in `src/server/container.ts`.

## 5. Instacart

Apply for Developer Platform access, start with a development key and `INSTACART_ENV=development`, and go through the checks listed under "Verify against the current docs" in [integrations.md](integrations.md#verify-against-the-current-docs-before-going-live). Switch to the production key and `INSTACART_ENV=production` after Instacart approves the integration.

## Release checklist

- [ ] `npm run typecheck && npm run lint && npm test` pass
- [ ] Integration tests pass against a fresh database (`npm run test:integration`)
- [ ] Migrations applied with `supabase db push`; no seed data in production
- [ ] Auth redirect URL and SMTP configured; email confirmation on
- [ ] All server env vars set on Vercel; no secret uses `NEXT_PUBLIC_`
- [ ] `cron.sql` run; `cron.job_run_details` shows successes
- [ ] A test reminder arrives once (set `next_reminder_at` in the past for a test household)
- [ ] A Siri test request returns 201, and the same request again returns `duplicate_event`
- [ ] Instacart: one link created in development mode and opened successfully

## Rollback

Migrations only add objects, so the previous app version runs against a newer schema. Roll back the app from the Vercel dashboard. Don't drop tables to undo a migration; write a new forward migration instead.

## Operations notes

- `sync_runs`, `notifications` and `order_events` grow without bound. At household scale that's years before it matters; add retention jobs with pg_cron when it does.
- Server logs never include request bodies, Authorization headers, tokens, or email addresses (the console email provider masks recipients).
