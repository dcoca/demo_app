import type { Metadata } from "next";
import { MockInstacartPreview } from "@/features/orders/mock-instacart-preview";

export const metadata: Metadata = { title: "Mock Instacart", robots: { index: false } };

export default function MockInstacartPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <MockInstacartPreview />
    </main>
  );
}
