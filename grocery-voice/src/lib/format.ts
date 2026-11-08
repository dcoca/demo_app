export function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity === null && !unit) return "";
  const q = quantity === null ? "" : Number(quantity).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return [q, unit].filter(Boolean).join(" ");
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const SOURCE_LABEL: Record<string, string> = {
  web: "App",
  siri: "Siri",
  alexa: "Alexa",
  home_assistant: "Home Assistant",
  api: "API",
};
