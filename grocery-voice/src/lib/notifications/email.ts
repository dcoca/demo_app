import { HttpError } from "@/lib/retry";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Provider-side de-duplication key, so a resend after a crash is a no-op. */
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly id: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string | null }>;
}

/** Resend (https://resend.com) over its REST API. */
export class ResendEmailProvider implements EmailProvider {
  readonly id = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new HttpError(res.status, `Email provider responded ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: data.id ?? null };
  }
}

/** Development fallback: logs instead of sending. Recipient is masked. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly id = "console";
  async send(message: EmailMessage) {
    const masked = message.to.replace(/^(.).*(@.*)$/, "$1***$2");
    console.info(`[email:console] to=${masked} subject="${message.subject}"\n${message.text}`);
    return { providerMessageId: null };
  }
}
