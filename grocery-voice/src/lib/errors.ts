export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "unprocessable"
  | "rate_limited"
  | "upstream_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  upstream_error: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

interface PostgresLikeError {
  code?: string;
  message?: string;
}

/**
 * SQL functions raise custom SQLSTATEs (GV400, GV403, ...). Map them to
 * application errors; anything else becomes a generic internal error so
 * database details never reach clients.
 */
export function fromDatabaseError(error: PostgresLikeError): AppError {
  const message = error.message ?? "Database error";
  switch (error.code) {
    case "GV400":
      return new AppError("bad_request", message);
    case "GV401":
      return new AppError("unauthorized", message);
    case "GV403":
      return new AppError("forbidden", message);
    case "GV404":
      return new AppError("not_found", message);
    case "GV409":
      return message.includes("Idempotency")
        ? new AppError("idempotency_conflict", message)
        : new AppError("conflict", message);
    case "GV422":
      return new AppError("unprocessable", message);
    case "23505":
      return new AppError("conflict", "Already exists");
    case "42501":
      return new AppError("forbidden", "Not allowed");
    default:
      return new AppError("internal", "Unexpected database error", { code: error.code });
  }
}
