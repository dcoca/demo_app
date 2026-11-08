import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const quantitySchema = z.coerce.number().positive().max(9999).nullish();

export const itemInputSchema = z.object({
  name: trimmed(120),
  quantity: quantitySchema,
  unit: optionalText(32),
  brand: optionalText(80),
  notes: optionalText(500),
  organic: z.boolean().optional().default(false),
  upc: z
    .string()
    .regex(/^\d{8,14}$/, "UPC must be 8-14 digits")
    .nullish()
    .transform((v) => v ?? null),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

export const addItemsSchema = z.object({
  items: z.array(itemInputSchema).min(1).max(50),
});

/** Idempotency-Key header for user-facing create endpoints. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency-Key must be at least 8 characters")
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, "Idempotency-Key has invalid characters");

export const updateItemSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: trimmed(120).optional(),
    quantity: quantitySchema,
    unit: optionalText(32).optional(),
    brand: optionalText(80).optional(),
    notes: optionalText(500).optional(),
    organic: z.boolean().optional(),
    upc: z.string().regex(/^\d{8,14}$/).nullable().optional(),
    status: z.enum(["active", "completed", "removed"]).optional(),
  })
  .strict();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

// ---------------------------------------------------------------------------
// Voice ingestion (POST /api/v1/ingest)
// ---------------------------------------------------------------------------
export const ingestItemSchema = z.object({
  name: trimmed(120),
  quantity: quantitySchema,
  unit: optionalText(32),
  brand: optionalText(80),
  notes: optionalText(500),
});

export const ingestRequestSchema = z
  .object({
    source: z.enum(["siri", "alexa", "api"]),
    externalEventId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[\w\-:.+ ]+$/, "externalEventId has invalid characters"),
    householdId: z.string().uuid(),
    items: z.array(ingestItemSchema).min(1).max(50).optional(),
    // Raw dictated text, e.g. "milk, two dozen eggs and bananas".
    text: z.string().trim().min(1).max(1000).optional(),
    device: z.string().trim().max(60).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.items) !== Boolean(v.text), {
    message: "Provide exactly one of items or text",
  });
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown timezone" },
);

export const createHouseholdSchema = z.object({
  name: trimmed(80),
  timezone: timezoneSchema,
});

export const updateHouseholdSchema = z.object({
  name: trimmed(80).optional(),
  duplicatePolicy: z.enum(["increase_quantity", "separate_item"]).optional(),
});

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(["member", "admin"]).default("member"),
});

export const memberUpdateSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:MM");

export const scheduleSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(["weekly", "custom"]),
    shoppingWeekday: z.number().int().min(0).max(6),
    intervalDays: z.number().int().min(1).max(60).nullable().optional(),
    anchorDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    reviewLeadDays: z.number().int().min(0).max(6),
    reviewReminderTime: timeOfDay,
    orderCutoffTime: timeOfDay,
    timezone: timezoneSchema,
  })
  .refine((v) => v.frequency === "weekly" || (v.intervalDays && v.anchorDate), {
    message: "Custom frequency needs an interval and a first shopping date",
  });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const notificationPrefsSchema = z.object({
  emailReminders: z.boolean(),
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export const createCredentialSchema = z.object({
  label: trimmed(60),
  allowedSources: z.array(z.enum(["siri", "alexa", "api"])).min(1).max(3).default(["siri"]),
});

export const createConnectionSchema = z.object({
  label: trimmed(60).default("Alexa via Home Assistant"),
  baseUrl: z.string().trim().url().max(300),
  entityId: z
    .string()
    .trim()
    .regex(/^todo\.[a-z0-9_]+$/, "Entity id looks like todo.alexa_shopping_list"),
  accessToken: z.string().trim().min(20).max(1000),
  pollIntervalSeconds: z.number().int().min(60).max(86400).default(300),
});

export const updateConnectionSchema = z.object({
  label: trimmed(60).optional(),
  enabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().min(60).max(86400).optional(),
  accessToken: z.string().trim().min(20).max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export const orderActionSchema = z.object({
  action: z.enum([
    "mark_ready",
    "approve",
    "reopen",
    "generate_link",
    "open_handoff",
    "confirm_placed",
    "undo_confirm",
    "close_cycle",
  ]),
});
export type OrderAction = z.infer<typeof orderActionSchema>["action"];
