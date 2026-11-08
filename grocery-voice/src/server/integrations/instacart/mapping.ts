import type { SnapshotItem } from "@/types/domain";

/**
 * Request types for POST /idp/v1/products/products_link (Instacart Developer
 * Platform, "Create shopping list page").
 *
 * Field names follow the published API reference. LineItem.quantity and
 * LineItem.unit are deprecated in favour of line_item_measurements, so only
 * the latter is sent. Re-check docs.instacart.com/developer_platform_api
 * before changing anything here; see docs/integrations.md.
 */
export interface InstacartMeasurement {
  quantity: number;
  unit: string;
}

export interface InstacartLineItem {
  name: string;
  display_text?: string;
  line_item_measurements?: InstacartMeasurement[];
  upcs?: string[];
  filters?: {
    brand_filters?: string[];
    health_filters?: string[];
  };
}

export interface InstacartProductsLinkRequest {
  title: string;
  link_type: "shopping_list";
  expires_in?: number;
  line_items: InstacartLineItem[];
  landing_page_configuration?: {
    partner_linkback_url?: string;
    enable_pantry_items?: boolean;
  };
}

export interface InstacartProductsLinkResponse {
  products_link_url: string;
}

/**
 * Our canonical units (see normalizeUnit) -> Instacart measurement units.
 * Units Instacart does not list are converted ("dozen" -> 12 each) or sent as
 * "package"/"each" so the item still lands on the page.
 */
const UNIT_MAP: Record<string, { unit: string; factor?: number }> = {
  gallon: { unit: "gallon" },
  "half gallon": { unit: "gallon", factor: 0.5 },
  quart: { unit: "quart" },
  pint: { unit: "pint" },
  liter: { unit: "liter" },
  ml: { unit: "milliliter" },
  lb: { unit: "pound" },
  oz: { unit: "ounce" },
  "fl oz": { unit: "fl oz" },
  kg: { unit: "kilogram" },
  g: { unit: "gram" },
  cup: { unit: "cup" },
  dozen: { unit: "each", factor: 12 },
  each: { unit: "each" },
  bunch: { unit: "bunch" },
  head: { unit: "head" },
  can: { unit: "can" },
  pack: { unit: "package" },
  bag: { unit: "package" },
  box: { unit: "package" },
  jar: { unit: "package" },
  bottle: { unit: "package" },
  carton: { unit: "package" },
  container: { unit: "package" },
  loaf: { unit: "package" },
};

export function toMeasurement(quantity: number | null, unit: string | null): InstacartMeasurement {
  const qty = quantity && quantity > 0 ? quantity : 1;
  if (!unit) return { quantity: qty, unit: "each" };
  const mapped = UNIT_MAP[unit];
  if (!mapped) return { quantity: qty, unit: "each" };
  return { quantity: Math.round(qty * (mapped.factor ?? 1) * 1000) / 1000, unit: mapped.unit };
}

export function toInstacartLineItem(item: SnapshotItem): InstacartLineItem {
  const line: InstacartLineItem = {
    name: item.name,
    line_item_measurements: [toMeasurement(item.quantity, item.unit)],
  };
  if (item.notes) line.display_text = `${item.name} (${item.notes})`.slice(0, 200);
  if (item.upc) line.upcs = [item.upc];

  const filters: NonNullable<InstacartLineItem["filters"]> = {};
  if (item.brand) filters.brand_filters = [item.brand];
  if (item.organic) filters.health_filters = ["ORGANIC"];
  if (filters.brand_filters || filters.health_filters) line.filters = filters;
  return line;
}

export function buildProductsLinkRequest(input: {
  title: string;
  items: SnapshotItem[];
  linkbackUrl?: string;
  expiresInDays: number;
}): InstacartProductsLinkRequest {
  const body: InstacartProductsLinkRequest = {
    title: input.title.slice(0, 100),
    link_type: "shopping_list",
    expires_in: input.expiresInDays,
    line_items: input.items.map(toInstacartLineItem),
  };
  if (input.linkbackUrl) {
    body.landing_page_configuration = { partner_linkback_url: input.linkbackUrl, enable_pantry_items: false };
  }
  return body;
}
