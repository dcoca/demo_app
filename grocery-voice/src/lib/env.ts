import { z } from "zod";

/**
 * Public configuration. These values are inlined into the browser bundle, so
 * nothing secret may ever be added here.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export function publicEnv() {
  // Referenced individually so Next.js can inline them at build time.
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters"),
  INTEGRATION_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  INSTACART_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  INSTACART_ENV: z.enum(["development", "production"]).default("development"),
  RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  EMAIL_FROM: z.string().default("Grocery Voice <reminders@example.com>"),
  ALLOW_PRIVATE_HOME_ASSISTANT_URLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/** Server-only configuration. Import only from server modules. */
export function serverEnv(): ServerEnv {
  return serverSchema.parse(process.env);
}
