# Grocery Voice

One shared household grocery list that Siri, Alexa and the web app all write to, turned into an Instacart shopping list each week.

```
"Hey Siri, Groceries" → "milk"          ┐
"Alexa, add strawberries to my          ├─▶ household list ─▶ reminder ─▶ review ─▶ Instacart link ─▶ you check out
 shopping list" (via Home Assistant)    ┘                                                              (history kept, new cycle)
```

Next.js 16 (App Router), TypeScript strict, Tailwind 4, Supabase (Postgres, Auth, Realtime, RLS, Cron), Zod, Vitest, Playwright.

## Quick start

```bash
npm install
supabase start                 # local Postgres/Auth/Realtime; applies migrations and seed
cp .env.example .env.local     # fill in keys printed by `supabase start`
npm run dev                    # http://localhost:3000, sign in as dana@example.com / password123
```

Without `INSTACART_API_KEY` the app uses a mock Instacart provider and says so on every screen that involves it.

## Tests

```bash
npm run test:unit          # pure logic and services with in-memory fakes
npm run test:integration   # RLS + SQL functions against a real PostgreSQL (see docs/setup.md)
npm run test:e2e           # Playwright smoke suite; E2E_SUPABASE=1 adds the full two-member flow
```

## Docs

- [Architecture](docs/architecture.md): modules, data model, guarantees, order states
- [Setup](docs/setup.md): local development and tests
- [Integrations](docs/integrations.md): Siri Shortcuts (iPhone and Mac), Alexa through Home Assistant, Instacart
- [Deployment](docs/deployment.md): Supabase, Vercel, Supabase Cron, email
