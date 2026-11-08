import "server-only";
import { decryptSecret } from "@/lib/crypto";
import { publicEnv, serverEnv } from "@/lib/env";
import { ConsoleEmailProvider, ResendEmailProvider, type EmailProvider } from "@/lib/notifications/email";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { IntegrationConnection } from "@/types/domain";
import { HomeAssistantShoppingListAdapter } from "./integrations/alexa/home-assistant-adapter";
import { assertSafeHomeAssistantUrl } from "./integrations/alexa/url-guard";
import { InstacartProvider, MockInstacartProvider } from "./integrations/instacart/instacart-provider";
import type { GroceryOrderingProvider, ShoppingListSyncAdapter } from "./integrations/types";
import {
  SupabaseCredentialLookup,
  SupabaseItemWriter,
  SupabaseNotificationStore,
  SupabaseOrderStore,
  SupabaseReminderStore,
  SupabaseSyncStore,
} from "./repositories/supabase-stores";

/** Composition root: the one place that picks concrete providers. */

export function orderingProvider(): GroceryOrderingProvider {
  const env = serverEnv();
  if (env.INSTACART_API_KEY) {
    return new InstacartProvider({ apiKey: env.INSTACART_API_KEY, environment: env.INSTACART_ENV });
  }
  return new MockInstacartProvider(publicEnv().NEXT_PUBLIC_APP_URL);
}

export function emailProvider(): EmailProvider {
  const env = serverEnv();
  return env.RESEND_API_KEY ? new ResendEmailProvider(env.RESEND_API_KEY, env.EMAIL_FROM) : new ConsoleEmailProvider();
}

export function orderDeps() {
  return { store: new SupabaseOrderStore(supabaseAdmin()), provider: orderingProvider(), appUrl: publicEnv().NEXT_PUBLIC_APP_URL };
}

export function ingestDeps() {
  const admin = supabaseAdmin();
  return { credentials: new SupabaseCredentialLookup(admin), items: new SupabaseItemWriter(admin) };
}

export function syncStore() {
  return new SupabaseSyncStore(supabaseAdmin());
}

export function reminderDeps() {
  return { store: new SupabaseReminderStore(supabaseAdmin()), appUrl: publicEnv().NEXT_PUBLIC_APP_URL };
}

export function notificationDeps() {
  return { store: new SupabaseNotificationStore(supabaseAdmin()), email: emailProvider() };
}

export async function adapterFor(connection: IntegrationConnection): Promise<ShoppingListSyncAdapter> {
  const env = serverEnv();
  if (!env.INTEGRATION_ENCRYPTION_KEY) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured");
  const encrypted = await syncStore().encryptedToken(connection.id);
  if (!encrypted) throw new Error("Home Assistant token is missing; reconnect the integration");
  const url = assertSafeHomeAssistantUrl(connection.base_url, env.ALLOW_PRIVATE_HOME_ASSISTANT_URLS);
  return new HomeAssistantShoppingListAdapter({
    baseUrl: url.toString(),
    entityId: connection.entity_id,
    accessToken: decryptSecret(encrypted, env.INTEGRATION_ENCRYPTION_KEY),
  });
}
