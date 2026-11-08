export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter. Rethrows the last error. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === opts.attempts || !opts.isRetryable(error)) break;
      const cap = Math.min(opts.maxDelayMs ?? 10_000, opts.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.round(Math.random() * cap));
    }
  }
  throw lastError;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Network failures, timeouts, 408, 429 and 5xx are worth retrying. */
export function isTransientHttpError(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError;
  }
  return false;
}
