import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError } from "./errors";

export function jsonError(error: AppError) {
  return NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Wraps a route handler: maps AppError/ZodError to structured JSON, hides
 * everything else behind a generic 500, and never logs request bodies or
 * Authorization headers.
 */
export function handler<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (error) {
      if (error instanceof AppError) return jsonError(error);
      if (error instanceof ZodError) {
        return jsonError(new AppError("bad_request", "Invalid request", error.flatten()));
      }
      console.error(`[api] ${req.method} ${new URL(req.url).pathname} failed:`, error instanceof Error ? error.message : error);
      return jsonError(new AppError("internal", "Something went wrong"));
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  return schema.parse(body);
}

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
