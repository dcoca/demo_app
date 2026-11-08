import { expect, test } from "@playwright/test";

/**
 * Runs against `next start` with no reachable Supabase. Covers routing,
 * auth gating, API error contracts, the mock Instacart page and security
 * headers. The full multi-user flow lives in household-flow.spec.ts.
 */

test("protected pages redirect to sign-in and keep the destination", async ({ page }) => {
  await page.goto("/order");
  await expect(page).toHaveURL(/\/login\?next=%2Forder$/);
  await expect(page.getByRole("heading", { name: "Grocery Voice" })).toBeVisible();
});

test("sign-in form is accessible and switches modes", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await page.getByRole("tab", { name: "Create account" }).click();
  await expect(page.getByLabel("Your name")).toBeVisible();
  await page.getByRole("tab", { name: "Email link" }).click();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Email me a link" })).toBeVisible();
});

test("protected APIs return structured 401s", async ({ request }) => {
  const res = await request.post("/api/v1/households/00000000-0000-4000-8000-000000000000/items", { data: { items: [] } });
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});

test("ingest rejects missing tokens and tokens in the URL", async ({ request }) => {
  const payload = {
    source: "siri",
    externalEventId: "evt-1",
    householdId: "00000000-0000-4000-8000-000000000000",
    items: [{ name: "milk" }],
  };
  const noToken = await request.post("/api/v1/ingest", { data: payload });
  expect(noToken.status()).toBe(401);

  const inUrl = await request.post("/api/v1/ingest?token=gv_abc", { data: payload });
  expect(inUrl.status()).toBe(400);
  expect((await inUrl.json()).error.message).toContain("Authorization header");
});

test("cron endpoints require the shared secret", async ({ request }) => {
  expect((await request.post("/api/cron/reminders")).status()).toBe(401);
  expect((await request.post("/api/cron/sync", { headers: { Authorization: "Bearer wrong" } })).status()).toBe(401);
});

test("mock Instacart page says plainly that nothing was sent or bought", async ({ page }) => {
  const request = {
    title: "Parkers groceries",
    link_type: "shopping_list",
    line_items: [{ name: "milk", line_item_measurements: [{ quantity: 2, unit: "gallon" }], filters: { health_filters: ["ORGANIC"] } }],
  };
  const hash = Buffer.from(JSON.stringify(request)).toString("base64url");
  await page.goto(`/mock-instacart#${hash}`);
  await expect(page.getByText("This is not Instacart")).toBeVisible();
  await expect(page.getByText("Nothing was ordered or purchased")).toBeVisible();
  await expect(page.getByText("2 gallon")).toBeVisible();
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-powered-by"]).toBeUndefined();
});

test("auth callback with a bad link returns to sign-in with an error", async ({ page }) => {
  await page.goto("/auth/callback?next=//evil.example");
  await expect(page).toHaveURL(/\/login\?error=link/);
  await expect(page.getByText("invalid or expired")).toBeVisible();
});
