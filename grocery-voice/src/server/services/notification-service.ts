import type { EmailProvider } from "@/lib/notifications/email";
import type { NotificationRecord } from "@/types/domain";

export interface NotificationStore {
  /** Atomically moves due rows to 'sending' with a lease and bumps attempts. */
  claim(limit: number, leaseSeconds: number): Promise<NotificationRecord[]>;
  markSent(id: string, providerMessageId: string | null, at: Date): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: Date, dead: boolean): Promise<void>;
}

/** 1m, 5m, 25m, ~2h ... capped at 6h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(6 * 3600_000, 60_000 * 5 ** Math.max(0, attempts - 1));
}

export async function deliverNotifications(
  deps: { store: NotificationStore; email: EmailProvider },
  now: Date,
): Promise<{ sent: number; failed: number; dead: number }> {
  const out = { sent: 0, failed: 0, dead: 0 };
  const batch = await deps.store.claim(50, 120);

  for (const n of batch) {
    const to = typeof n.payload.to === "string" ? n.payload.to : null;
    try {
      if (!to) throw new Error("Notification has no recipient address");
      const { providerMessageId } = await deps.email.send({
        to,
        subject: n.subject,
        text: n.body,
        idempotencyKey: n.dedupe_key,
      });
      await deps.store.markSent(n.id, providerMessageId, now);
      out.sent++;
    } catch (error) {
      const dead = n.attempts >= n.max_attempts || !to;
      await deps.store.markFailed(
        n.id,
        error instanceof Error ? error.message.slice(0, 500) : "Send failed",
        new Date(now.getTime() + retryDelayMs(n.attempts)),
        dead,
      );
      if (dead) out.dead++;
      else out.failed++;
    }
  }
  return out;
}
