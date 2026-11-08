# Architecture

Grocery Voice is a modular monolith: one Next.js app on Vercel and one Supabase project. The database is the system of record for everything a household shares. Integrations sit behind interfaces so any of them can be replaced or mocked.

## Layout

```
src/
  app/                    routes: pages (list, order, history, settings) and /api route handlers
  components/             shared UI primitives and navigation
  features/
    auth/                 session helpers (requireMember, requireActiveHousehold), login form
    households/           role permissions, household/member/invite UI
    shopping/             name normalization, spoken-text parser, live list UI
    scheduling/           timezone-aware schedule math, schedule form
    orders/               order state machine, snapshot hashing, order UI
    integrations/         Siri token and Home Assistant connection UI
  lib/                    env, errors, crypto, retry, http helpers, Supabase clients, email providers, Zod schemas
  server/
    services/             domain logic; depends only on small "port" interfaces
    repositories/         Supabase implementations of those ports
    integrations/         siri/, alexa/ (Home Assistant), instacart/ adapters + mocks
    container.ts          composition root: picks real or mock providers from env
supabase/migrations/      schema, RLS policies, SQL functions
tests/unit|integration|e2e
```

Services never import Supabase. Each declares the narrow interface it needs (`ItemWriter`, `OrderStore`, `SyncStore`, `ReminderStore`, ...). `server/repositories/supabase-stores.ts` implements them, and the unit tests implement them in memory.

## Integration contracts

`src/server/integrations/types.ts` defines three:

| Interface | Direction | Implementations |
|---|---|---|
| `GroceryInputProvider` | something pushes items to us | Siri Shortcut, mock Alexa push, generic API |
| `ShoppingListSyncAdapter` | we pull an external list | Home Assistant (Alexa list), `MockAlexaShoppingList` |
| `GroceryOrderingProvider` | we hand a list to a store | Instacart Developer Platform, `MockInstacartProvider` |

`ShoppingListSyncAdapter.capabilities.write` is `false` everywhere today. Two-way sync means adding write methods behind that flag; the sync service and mappings table already key everything by external id.

## Authorization model

There are two Supabase clients on the server, and the rule for choosing is strict.

The **user client** (publishable key + session cookie) is used for reads in Server Components and for writes a member makes to shared data: item edits, schedule, invitations, roles. RLS decides.

The **service client** bypasses RLS. It is used only after the route has proven the caller's right to act: by reading the target row through the user client (orders), by checking membership (`requireMember`), or by authenticating an integration token (ingest). It handles secrets, snapshots, links, notifications and sync bookkeeping, none of which clients may write.

SQL functions add a second check. `add_items`, `transition_order` and `close_cycle` accept a non-service caller only if `auth.uid()` belongs to the household, and `add_items` refuses a user who claims a voice source or another actor.

`tests/integration/household-isolation.test.ts` signs in as a non-member and checks every household-scoped table for zero visible rows, plus refused writes and function calls.

## Data model

```
households ─┬─ household_members (owner | admin | member)
            ├─ household_invitations (sha256 token, email-bound, 7-day expiry)
            ├─ shopping_cycles (one open per household) ─┬─ shopping_items
            │                                             └─ orders (one per cycle) ─┬─ order_snapshots (versioned, immutable)
            │                                                                        ├─ shopping_links (one per snapshot+provider)
            │                                                                        └─ order_events (audit trail)
            ├─ household_schedules ── notifications (dedupe_key unique)
            ├─ notification_preferences (per member)
            ├─ integration_credentials (Siri tokens: prefix + sha256, revocable)
            ├─ integration_connections (Home Assistant) ─┬─ integration_connection_secrets (AES-GCM, server-only)
            │                                            ├─ external_item_mappings (external id → item)
            │                                            ├─ sync_checkpoints
            │                                            └─ sync_runs
            ├─ ingestion_events (one per voice event)
            └─ idempotency_keys (server-only)
```

## Guarantees and how they're enforced

**Retries never add twice.** Every item write goes through `add_items(..., idempotency_key, request_hash)`. The function takes an advisory lock on the key, returns the stored response on replay, and rejects the same key with a different payload (`GV409`). Web clients send an `Idempotency-Key` header generated once per tap; Siri sends `externalEventId`; Home Assistant sync uses `ha:<connection>:<external id>`. Tested with eight concurrent identical requests.

**Duplicates follow an explicit rule.** Two items match when both are active in the open cycle with equal `normalized_name` and equal unit. The household setting decides whether a match increases quantity (missing quantity counts as 1) or adds a separate line. Normalization lowercases, applies NFKC, drops leading articles and folds a regular plural on the last word only, so "Bananas" = "banana" but "organic milk" ≠ "almond milk". A per-cycle advisory lock stops two concurrent "milk" adds from both missing each other.

**Sync never loses or duplicates items.** The sync service writes an item, then records the external-id mapping. If it dies in between, the next run replays the same idempotency key, gets the same item id back, and records the mapping. Items that disappear from Alexa, or an unreachable Home Assistant, never change internal items. Failures only update health (`degraded` after one, `failing` after three) and back off exponentially up to six hours.

**Reminders go out once.** The scheduler reads due schedules, inserts notifications keyed `review_reminder:<household>:<shopping date>:<member>` with `on conflict do nothing`, and advances the schedule with compare-and-set on `next_reminder_at`. Delivery claims rows with a lease (`for update skip locked`) and passes the dedupe key to the email provider as its idempotency key. A reminder whose ordering cutoff has passed is skipped.

**One link per list version.** Generating a link snapshots the active items and hashes them. The same hash reuses the same snapshot and its ready link without calling Instacart. A new hash makes a new snapshot version. A unique `(snapshot_id, provider)` row acts as the claim, so a double-tap gets a 409 instead of a second API call. "Open Instacart" re-checks the hash and regenerates if the list changed.

**No invented checkout.** Instacart's shopping-list API returns a URL and nothing about checkout. Opening the link sets `handoff_opened`. Only a member pressing "I placed the order" sets `completed_unverified`, and the UI labels it unverified. Nothing in the code marks an order confirmed or fulfilled.

## Order states

```
draft ─▶ ready_for_review ─▶ approved ─▶ link_generated ─▶ handoff_opened ─▶ completed_unverified ─▶ archived
```

| From | Allowed to |
|---|---|
| draft | ready_for_review (reminder sent), approved |
| ready_for_review | approved, draft |
| approved | link_generated, ready_for_review (reopen) |
| link_generated | link_generated (new snapshot), handoff_opened, approved (reopen) |
| handoff_opened | handoff_opened, link_generated (regenerated), completed_unverified (member confirms), approved (reopen) |
| completed_unverified | archived (close cycle), handoff_opened (undo) |

The authoritative table is `order_transition_allowed()` in SQL. `src/features/orders/status.ts` mirrors it for the UI, and an integration test fails if they differ. `close_cycle()` archives the order, opens the next cycle with a fresh draft order, and moves active items that weren't in the ordered snapshot into it.

## Realtime

The list page subscribes to `postgres_changes` on `shopping_items` and `orders` filtered by household. RLS applies to Realtime, so members only receive their own household's rows. Events carry a `version`, and older versions are ignored. On (re)subscribe and when the tab becomes visible, the client re-reads the list to cover anything missed while disconnected.

## What's not built

- Native iOS app (App Intents would allow "Hey Siri, add milk to groceries" in one breath; Shortcuts asks a follow-up question).
- Two-way Alexa sync.
- Push or SMS notifications (email only).
- Verified order status from Instacart (no such API for shopping-list links).
