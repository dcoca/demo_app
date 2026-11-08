"use client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** JSON fetch with structured errors. Retries network failures only when `retries` > 0. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; retries?: number } = {},
): Promise<T> {
  const attempts = (init.retries ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: "same-origin",
      });
    } catch (error) {
      lastError = error; // network error: safe to retry because callers pass idempotency keys
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: unknown } };
    if (!res.ok) {
      const err = data.error ?? { code: "error", message: `Request failed (${res.status})` };
      if (res.status >= 500 && attempt < attempts) {
        lastError = new ApiError(res.status, err.code, err.message, err.details);
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
        continue;
      }
      throw new ApiError(res.status, err.code, err.message, err.details);
    }
    return data as T;
  }
  throw lastError instanceof ApiError ? lastError : new ApiError(0, "network", "You appear to be offline. Try again.");
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
