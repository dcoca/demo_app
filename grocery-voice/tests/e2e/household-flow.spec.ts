import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Full two-member flow against a real Supabase stack (`supabase start`) with
 * email confirmations disabled (the local default). Enable with E2E_SUPABASE=1.
 *
 *   Dana creates a household and invites Sam. Sam joins. Dana adds milk in
 *   the app; Sam's open list shows it live. A Siri token adds strawberries.
 *   Dana approves, creates a (mock) Instacart link, confirms the order, and
 *   starts the next cycle. History keeps the old one.
 */
test.skip(!process.env.E2E_SUPABASE, "Set E2E_SUPABASE=1 with a local Supabase stack to run");

const stamp = Date.now();
const dana = { name: "Dana", email: `dana+${stamp}@example.com`, password: "correct-horse-1" };
const sam = { name: "Sam", email: `sam+${stamp}@example.com`, password: "correct-horse-2" };

async function signUp(page: Page, who: typeof dana, next = "/list") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

async function newPage(browser: Browser) {
  const context = await browser.newContext();
  return context.newPage();
}

test("two members share one live list through ordering and a new cycle", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const danaPage = await newPage(browser);
  await signUp(danaPage, dana);
  await expect(danaPage).toHaveURL(/\/onboarding/);
  await danaPage.getByLabel("Household name").fill("The Parkers");
  await danaPage.getByRole("button", { name: "Create household" }).click();
  await expect(danaPage).toHaveURL(/\/list/);

  // Invite Sam
  await danaPage.goto("/settings");
  await danaPage.getByPlaceholder("name@example.com").fill(sam.email);
  await danaPage.getByRole("button", { name: "Invite" }).click();
  const inviteLink = await danaPage.getByLabel("Invitation link").inputValue();
  const invitePath = new URL(inviteLink).pathname;

  const samPage = await newPage(browser);
  await signUp(samPage, sam, invitePath);
  await samPage.goto(invitePath);
  await samPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(samPage).toHaveURL(/\/list/);
  await expect(samPage.getByText("The Parkers")).toBeVisible();

  // Realtime: Dana adds, Sam sees it
  await danaPage.goto("/list");
  await expect(samPage.getByText("Live")).toBeVisible({ timeout: 15_000 });
  await danaPage.getByLabel("Add an item").fill("2 gallons milk");
  await danaPage.getByRole("button", { name: "Add" }).click();
  await expect(samPage.getByRole("button", { name: /milk/ })).toBeVisible({ timeout: 15_000 });
  await expect(samPage.getByText("2 gallon")).toBeVisible();

  // Siri: create a token and post like the Shortcut would
  await danaPage.goto("/settings/integrations");
  await danaPage.getByRole("button", { name: "Create Siri token" }).click();
  const token = await danaPage.getByLabel("New token").inputValue();
  const householdId = (await danaPage.locator("dd").nth(3).textContent())!.trim();
  const ingest = (eventId: string) =>
    danaPage.request.post(`${baseURL}/api/v1/ingest`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { source: "siri", externalEventId: eventId, householdId, text: "strawberries" },
    });
  expect((await ingest("shortcut-1")).status()).toBe(201);
  expect((await ingest("shortcut-1")).status()).toBe(200); // retry: duplicate_event
  await expect(samPage.getByRole("button", { name: /strawberries/ })).toHaveCount(1, { timeout: 15_000 });

  // Order: approve -> link -> open -> confirm -> next cycle
  await danaPage.goto("/order");
  await danaPage.getByRole("button", { name: /Approve 2 items/ }).click();
  await danaPage.getByRole("button", { name: /Create Instacart link/ }).click();
  await expect(danaPage.getByText(/Instacart link ready/)).toBeVisible();
  const popup = danaPage.waitForEvent("popup");
  await danaPage.getByRole("button", { name: /Open (mock )?Instacart/ }).click();
  await (await popup).close();
  await danaPage.getByRole("button", { name: "I placed the order" }).click();
  await expect(danaPage.getByText("not verified")).toBeVisible();
  await danaPage.getByRole("button", { name: "Start next week's list" }).click();
  await expect(danaPage.getByText("New list started")).toBeVisible();

  await danaPage.goto("/history");
  await expect(danaPage.getByText("Current list")).toBeVisible();
  await expect(danaPage.getByText(/Week of/)).toBeVisible();
});
