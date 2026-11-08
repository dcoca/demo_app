/** Only same-origin relative paths; blocks open redirects like //evil.com. */
export function safeNext(next: string | null | undefined, fallback = "/list"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
