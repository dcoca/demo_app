import type { OrderStatus } from "@/types/domain";

/**
 * Mirror of public.order_transition_allowed() for UI hints and early
 * validation. The database function is authoritative; a test keeps the two
 * lists identical.
 */
export const ORDER_TRANSITIONS: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ["draft", "ready_for_review"],
  ["draft", "approved"],
  ["ready_for_review", "approved"],
  ["ready_for_review", "draft"],
  ["approved", "link_generated"],
  ["approved", "ready_for_review"],
  ["link_generated", "link_generated"],
  ["link_generated", "handoff_opened"],
  ["link_generated", "approved"],
  ["handoff_opened", "handoff_opened"],
  ["handoff_opened", "link_generated"],
  ["handoff_opened", "completed_unverified"],
  ["handoff_opened", "approved"],
  ["completed_unverified", "handoff_opened"],
  ["completed_unverified", "archived"],
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Collecting items",
  ready_for_review: "Ready for review",
  approved: "Approved",
  link_generated: "Instacart link ready",
  handoff_opened: "Opened in Instacart",
  completed_unverified: "Marked as ordered (not verified with Instacart)",
  archived: "Archived",
};

/** States in which the list can still be generated into a link. */
export const LINKABLE_STATUSES: OrderStatus[] = ["approved", "link_generated", "handoff_opened"];
