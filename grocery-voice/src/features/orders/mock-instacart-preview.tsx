"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Notice } from "@/components/ui";
import type { InstacartProductsLinkRequest } from "@/server/integrations/instacart/mapping";

function readHash(): string {
  return window.location.hash.slice(1);
}

function decode(hash: string): InstacartProductsLinkRequest | null {
  try {
    const json = atob(hash.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

export function MockInstacartPreview() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    readHash,
    () => "",
  );
  const request = hash ? decode(hash) : null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Mock Instacart page</h1>
      <Notice tone="amber">
        This is not Instacart. No request was sent to Instacart because the server has no{" "}
        <code>INSTACART_API_KEY</code>. Below is the exact shopping-list request Grocery Voice would send.
        Nothing was ordered or purchased.
      </Notice>
      {request ? (
        <>
          <p className="font-medium">{request.title}</p>
          <ul className="surface divide-y divide-[var(--border)] rounded-2xl">
            {request.line_items.map((li, i) => (
              <li key={i} className="px-4 py-3 text-sm">
                <div className="font-medium">{li.display_text ?? li.name}</div>
                <div className="text-muted">
                  {li.line_item_measurements?.map((m) => `${m.quantity} ${m.unit}`).join(", ")}
                  {li.filters?.brand_filters ? ` · brand: ${li.filters.brand_filters.join(", ")}` : ""}
                  {li.filters?.health_filters ? ` · ${li.filters.health_filters.join(", ").toLowerCase()}` : ""}
                  {li.upcs ? ` · UPC ${li.upcs.join(", ")}` : ""}
                </div>
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer">Request JSON</summary>
            <pre className="surface mt-2 overflow-x-auto rounded-xl p-3 text-xs">{JSON.stringify(request, null, 2)}</pre>
          </details>
        </>
      ) : (
        <p className="text-muted text-sm">No list data in this link.</p>
      )}
      <Link href="/order" className="inline-block text-sm font-medium text-brand-600 underline">
        Back to Grocery Voice
      </Link>
    </div>
  );
}
