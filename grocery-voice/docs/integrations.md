# Integrations

Three integrations, each behind an interface in `src/server/integrations/types.ts`. All of them are optional; the app works fully from the browser.

---

## Siri (Apple Shortcuts)

A Shortcut you build once on your iPhone. It asks what to add, sends your words to Grocery Voice, and reads back what was added. It syncs to your Mac, Apple Watch and HomePod through iCloud. No App Store app is involved.

### How it talks to the server

```
POST https://YOUR-APP/api/v1/ingest
Authorization: Bearer gv_xxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "source": "siri",
  "externalEventId": "siri-20261108183012123-482913",
  "householdId": "6f1c…",
  "text": "two gallons of milk and bananas",
  "device": "Dana's iPhone"
}
```

You can send `"items": [{ "name": "milk", "quantity": 2, "unit": "gallon" }]` instead of `text`. With `text`, the server splits the phrase on commas and "and" (keeping products like "mac and cheese" and "half and half" whole) and reads leading quantities and units.

The token decides which household is written to. `householdId` must match it or the request is refused, so a leaked household id is useless on its own. Tokens:

- belong to one household and one member, and stop working if that member leaves
- can only add items (`items:write`) and only as the sources they were created for
- are stored as a SHA-256 hash; the full token is shown once
- go in the `Authorization` header only. The endpoint rejects `?token=` in the URL so it never ends up in access logs

Responses:

| Status | Body `status` | Meaning |
|---|---|---|
| 201 | `accepted` | Items added (or merged into existing ones) |
| 200 | `duplicate_event` | Same `externalEventId` seen before; nothing changed |
| 400 | — | Payload invalid |
| 401 | — | Token missing, wrong, revoked, or its owner left the household |
| 403 | — | Token not allowed for that household or source |
| 409 | — | `externalEventId` reused with different content |

### 1. Create a token

In Grocery Voice: Settings → Siri & Alexa → enter a device name (e.g. "Dana's iPhone") → **Create Siri token**. Keep the page open; you'll copy the token, the URL and the household id from it.

Create one token per device. If a phone is lost, revoke its token without breaking the others.

### 2. Build the Shortcut on iPhone

Open **Shortcuts**, tap **+**, and add these actions in order:

1. **Ask for Input**. Input type: Text. Prompt: `What should I add?`
2. **Current Date**.
3. **Format Date**. Date format: Custom, format string `yyyyMMddHHmmssSSS`.
4. **Random Number** between `100000` and `999999`.
5. **Text**. Contents: `siri-` then insert the *Formatted Date* variable, `-`, then the *Random Number* variable. This is the event id.
6. **Get Contents of URL**.
   - URL: the ingest URL shown with your token, e.g. `https://YOUR-APP/api/v1/ingest`
   - Tap *Show More*. Method: `POST`
   - Headers: add `Authorization` with value `Bearer ` followed by your token (one space after `Bearer`)
   - Request Body: `JSON`, with these fields (all Text):
     - `source` → `siri`
     - `externalEventId` → the *Text* variable from step 5
     - `householdId` → your household id
     - `text` → *Provided Input* from step 1
     - `device` → e.g. `Dana's iPhone`
7. **Get Dictionary Value**. Get *Value* for key `message` in *Contents of URL*.
8. **Speak Text**. Speak *Dictionary Value*. (Or **Show Result** if you prefer silence.)

Name the Shortcut **Groceries** (tap the name at the top). The name is the Siri phrase.

### 3. Use it

> "Hey Siri, Groceries"
> Siri: "What should I add?"
> "Two gallons of milk and strawberries"
> Siri: "Added milk, strawberries"

Siri can't pull an item out of the trigger phrase itself ("Hey Siri, add milk to groceries") for a personal Shortcut. That form needs a native app with App Intents, which is out of scope for this version. The two-step exchange above is what Shortcuts supports.

### 4. Mac

Shortcuts on macOS 12 or later syncs from iCloud when **Shortcuts → Settings → Sync with iCloud** is on (same Apple ID as the iPhone). Then:

- "Hey Siri, Groceries" works on Macs with Siri enabled (System Settings → Siri).
- Pin it to the menu bar: open the Shortcut → Details (ⓘ) → **Pin in Menu Bar**.
- Give it a keyboard shortcut in the same panel.

If you want the Mac to be its own device in the token list, duplicate the Shortcut, create a "Dana's Mac" token, and paste that token into the copy.

### 5. Apple Watch and HomePod

The same Shortcut appears on Apple Watch automatically. On HomePod, turn on **Personal Requests** for your account in the Home app; HomePod runs the Shortcut through your iPhone.

### Notes and limits

- **Retries.** Shortcuts does not retry a failed request. If you run it again yourself, that's a new event id and a new explicit add. Under the default "increase quantity" setting, a second "milk" becomes quantity 2. If the phone lost signal mid-request and the first one actually landed, you'll see the bumped quantity on the list and can fix it in one tap.
- **Don't share the Shortcut** through an iCloud link: the token is inside it. Each person makes their own.
- **Different households.** A token belongs to one household. Someone in two households creates two Shortcuts.

---

## Alexa, through Home Assistant

Amazon offers no supported public API for reading the Alexa shopping list, so Grocery Voice does not talk to Amazon at all. It reads the list from your Home Assistant, which you connect to Alexa yourself. Grocery Voice never sees your Amazon password.

This guide assumes your Home Assistant exposes the Alexa shopping list as a **to-do entity** (`todo.something`), for example through its Alexa Devices integration. Grocery Voice needs only that entity; it doesn't care which integration provides it. Check before you start: in Home Assistant go to **Developer Tools → States** and filter for `todo.`. If you don't see an Alexa shopping list entity, the integration you're using doesn't expose it, and this sync can't work until one does.

### Direction

One-way: Alexa → Grocery Voice. Items you check off in Grocery Voice stay on the Alexa list, and items removed from Alexa stay in Grocery Voice. The adapter reports `capabilities.write = false`; two-way sync is a later addition behind the same interface.

### 1. Reach Home Assistant over HTTPS

Grocery Voice runs in the cloud and needs a public HTTPS URL for Home Assistant. Use one of:

- **Home Assistant Cloud (Nabu Casa)**: Settings → Home Assistant Cloud → Remote Control. The URL looks like `https://xxxxxxxx.ui.nabu.casa`.
- Your own reverse proxy with a valid certificate.

For safety, the server rejects `http://`, `localhost`, `*.local`, and private or link-local IP addresses unless `ALLOW_PRIVATE_HOME_ASSISTANT_URLS=true` (meant for local development only).

### 2. Create a dedicated user and token

1. Settings → People → **Add person** named "Grocery Voice", allowed to log in, **not** an administrator.
2. Log in as that user, open the profile (bottom left) → **Security** → **Long-lived access tokens** → **Create token**. Copy it.

A non-admin user limits what a leaked token could do. Grocery Voice stores the token encrypted (AES-256-GCM, key in `INTEGRATION_ENCRYPTION_KEY`) in a table no client role can read.

### 3. Test from a terminal

```bash
curl -s -X POST \
  -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
  -d '{"entity_id":"todo.alexa_shopping_list","status":["needs_action"]}' \
  "https://YOUR-HA-URL/api/services/todo/get_items?return_response"
```

You should see `{"changed_states":[],"service_response":{"todo.alexa_shopping_list":{"items":[...]}}}`. This is exactly the call Grocery Voice makes.

### 4. Connect

Grocery Voice → Settings → Siri & Alexa → Alexa section (owners and admins):

- Home Assistant URL
- Shopping list entity, e.g. `todo.alexa_shopping_list`
- The token
- Poll interval (1 minute to 24 hours; 5 minutes is a good default)

**Connect** reads the list once before saving, so a typo fails right away.

### How sync works

Supabase Cron calls `/api/cron/sync` every minute. That handler leases the connections that are due (each has its own interval) so overlapping runs never sync the same one twice.

For each connection:

1. Read open items from Home Assistant (10 s timeout, up to 3 attempts with backoff on network errors and 5xx; a rejected token is not retried).
2. Skip items whose Home Assistant `uid` is already in `external_item_mappings`.
3. Add each new item with idempotency key `ha:<connection>:<uid>`, parsing quantities like "2 gallons of milk", then record the mapping.
4. Save a checkpoint (hash of the uids seen, count, time) and mark the connection healthy.

Failure handling:

| Situation | What happens |
|---|---|
| Home Assistant down, slow, or token rejected | No items change. Health goes `degraded`, then `failing` after 3 consecutive failures. Next attempt backs off: interval × 2ⁿ, capped at 6 hours. |
| Crash after adding an item but before recording its mapping | Next run replays the same idempotency key, gets the same item back, records the mapping. No duplicate. |
| One item fails to save | Others still import. That item stays unmapped and is retried next run. Health shows `degraded`. |
| Item removed or checked off in Alexa | Nothing happens in Grocery Voice. |
| Same thing said to Alexa again later | Alexa gives it a new uid, so it's a new explicit add and follows the household's duplicate rule. |

Health, last success, last error and the latest run are on the integrations page, with **Sync now**, **Pause** and **Disconnect**. Disconnecting keeps every imported item.

### Mock Alexa source

Tests and local development can skip Home Assistant entirely:

- `MockAlexaShoppingList` (`src/server/integrations/alexa/mock-alexa-list.ts`) implements the sync adapter in memory, with `say()`, `complete()` and `failNext()` to simulate outages.
- `/api/v1/ingest` accepts `"source": "alexa"` from a token created with `"allowedSources": ["alexa"]` (`POST /api/v1/households/{id}/credentials`), labelled "Alexa (mock)" in the list. This is a push path for prototyping an Alexa skill; real Alexa items come through Home Assistant.

---

## Instacart

Grocery Voice uses the Instacart Developer Platform **Create shopping list page** endpoint to turn the approved list into a link. You pick a store and check out on Instacart. Grocery Voice never places or pays for an order.

### Configuration

| Variable | Value |
|---|---|
| `INSTACART_API_KEY` | Developer Platform API key. Server-only, never sent to the browser. |
| `INSTACART_ENV` | `development` → `https://connect.dev.instacart.tools`; `production` → `https://connect.instacart.com` |

Without a key, `MockInstacartProvider` is used. Its links open `/mock-instacart`, which says in a banner that nothing was sent to Instacart and shows the exact request that would have been sent. The order screen shows a "mock mode" notice too.

### Request

`POST {base}/idp/v1/products/products_link` with `Authorization: Bearer <key>`:

```json
{
  "title": "The Parkers groceries",
  "link_type": "shopping_list",
  "expires_in": 14,
  "line_items": [
    { "name": "milk", "line_item_measurements": [{ "quantity": 2, "unit": "gallon" }] },
    {
      "name": "yogurt",
      "display_text": "yogurt (vanilla)",
      "line_item_measurements": [{ "quantity": 4, "unit": "each" }],
      "upcs": ["0818290011312"],
      "filters": { "brand_filters": ["Chobani"], "health_filters": ["ORGANIC"] }
    }
  ],
  "landing_page_configuration": { "partner_linkback_url": "https://YOUR-APP/order", "enable_pantry_items": false }
}
```

The response field used is `products_link_url`. If it's missing, the call is treated as a failure.

Mapping (`src/server/integrations/instacart/mapping.ts`):

| Grocery Voice | Instacart |
|---|---|
| name | `name` |
| quantity + unit | `line_item_measurements[0]`. The deprecated top-level `quantity`/`unit` are never sent. |
| `lb`, `oz`, `kg`, `g`, `ml` | `pound`, `ounce`, `kilogram`, `gram`, `milliliter` |
| `dozen` | quantity × 12, `each` |
| bag, box, jar, bottle, carton, loaf, pack | `package` |
| no quantity or unknown unit | quantity (or 1), `each` |
| brand | `filters.brand_filters` |
| organic | `filters.health_filters: ["ORGANIC"]` |
| UPC | `upcs` |
| notes | `display_text: "name (notes)"` |

Retries: 3 attempts on network errors, 408, 429 and 5xx; 4xx fails immediately. Response bodies are not logged.

### Verify against the current docs before going live

The docs site (docs.instacart.com/developer_platform_api) couldn't be fetched from the environment this was built in. The endpoint, the `line_item_measurements` format, the deprecation of top-level quantity/unit, `brand_filters`, and `products_link_url` were confirmed through search results of that site. These were not, and should be checked once:

- the exact set of accepted measurement unit strings (the unit map above is the place to fix them)
- `health_filters` values (`ORGANIC` assumed)
- `expires_in` units and limits (days assumed)
- the `landing_page_configuration` field names

The adapter is the only file that needs to change if any of these differ.

### Lifecycle

1. **Approve** freezes nothing; it marks the list reviewed.
2. **Create Instacart link** snapshots active items (versioned, hashed), calls Instacart once per snapshot, and stores the link. Pressing it again with an unchanged list reuses the link.
3. **Open Instacart** records `handoff_opened`. If the list changed since the link was made, a new snapshot and link are created first.
4. **I placed the order** is the member's own statement. The order becomes `completed_unverified` and the UI says it isn't verified with Instacart.
5. **Start next week's list** archives the order, closes the cycle, and opens a new one. Items added after the snapshot (e.g. eggs that came in through Alexa after the link was made) move to the new list.
