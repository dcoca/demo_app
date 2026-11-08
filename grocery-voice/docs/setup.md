# Local setup

## Prerequisites

- Node.js 20.9+ (22 recommended)
- [Supabase CLI](https://supabase.com/docs/guides/local-development) and Docker, for the local stack
- PostgreSQL 15+ client tools (`psql`), only for the integration tests

## Run the app

```bash
npm install
supabase start
```

`supabase start` applies `supabase/migrations/*` and `supabase/seed.sql`, then prints the API URL and keys. Copy `.env.example` to `.env.local` and fill in:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | API URL (`http://127.0.0.1:54321`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the publishable (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret (service_role) key |
| `CRON_SECRET` | any random string, 16+ characters |
| `INTEGRATION_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ALLOW_PRIVATE_HOME_ASSISTANT_URLS` | `true` if your Home Assistant is on your LAN |

Leave `INSTACART_API_KEY` and `RESEND_API_KEY` empty to use the mock Instacart provider and console email.

```bash
npm run dev
```

Sign in as `dana@example.com` or `sam@example.com` (password `password123`). Both belong to "The Parkers". Open each in a separate browser profile to watch realtime sync.

Local Supabase captures auth emails (magic links, confirmations) in Mailpit at http://127.0.0.1:54324.

### Run the scheduler by hand

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reminders
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync
```

To trigger a reminder now, set the schedule in Settings, then in Supabase Studio set `household_schedules.next_reminder_at` to a past time and call the reminders endpoint. With no `RESEND_API_KEY` the email prints in the dev server log.

### Try voice ingestion without a phone

Create a Siri token in Settings → Siri & Alexa, then:

```bash
curl -X POST http://localhost:3000/api/v1/ingest \
  -H "Authorization: Bearer gv_..." -H "Content-Type: application/json" \
  -d '{"source":"siri","externalEventId":"test-1","householdId":"<id shown with the token>","text":"2 gallons of milk and bananas"}'
```

Run it twice: the second response says `"status":"duplicate_event"` and nothing changes.

## Tests

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

**Unit tests** need nothing running. They cover normalization, the spoken-list parser, schedule math (including DST), the Instacart and Home Assistant adapters against fake `fetch`, and the ingest, sync, order, reminder and notification services against in-memory stores.

**Integration tests** run against real PostgreSQL. `scripts/prepare-test-db.sh` drops and recreates `grocery_voice_test`, loads `tests/integration/supabase-shim.sql` (the `auth` schema, `auth.uid()` and the `anon`/`authenticated`/`service_role` roles), then applies every migration. Point `TEST_DATABASE_URL` at any Postgres you can create databases on; the default is `postgres://postgres:postgres@localhost:5432/grocery_voice_test`. You can also use the local Supabase database on port 54322, which already has the real auth schema. Without `TEST_DATABASE_URL`, `npm test` skips these.

**E2E tests** build on `next start`. The smoke suite (routing, auth gating, API error contracts, mock Instacart page, security headers) needs no backend. The two-member flow in `household-flow.spec.ts` needs `supabase start` and `E2E_SUPABASE=1`:

```bash
npm run build && E2E_SUPABASE=1 npm run test:e2e
```

If Playwright's bundled browser isn't installed, set `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chromium binary.
