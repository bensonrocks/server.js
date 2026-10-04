"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/reveal";

interface Row {
  id: string;
  primary: string;
  secondary: string;
  status: "On track" | "Attention" | "Delivered" | "In stock" | "Low stock" | "Booked" | "In transit";
}

const ORDERS: Row[] = [
  { id: "ORD-3021", primary: "Lazada SG · 4 items", secondary: "Dispatch by 5:00pm SGT", status: "On track" },
  { id: "ORD-3018", primary: "Shopify · 12 items", secondary: "Partial stock allocation", status: "Attention" },
  { id: "ORD-3011", primary: "TikTok Shop · 2 items", secondary: "Handed to carrier", status: "Delivered" },
  { id: "ORD-3005", primary: "Shopee · 7 items", secondary: "Dispatch by 5:00pm SGT", status: "On track" },
];

const INVENTORY: Row[] = [
  { id: "SKU-1042", primary: "Cotton Tee — Navy / M", secondary: "412 units on hand", status: "In stock" },
  { id: "SKU-1043", primary: "Cotton Tee — Navy / L", secondary: "18 units on hand", status: "Low stock" },
  { id: "SKU-2210", primary: "Serum 30ml", secondary: "1,204 units on hand", status: "In stock" },
  { id: "SKU-2211", primary: "Serum 100ml", secondary: "6 units on hand", status: "Low stock" },
];

const SHIPMENTS: Row[] = [
  { id: "FR-7781", primary: "FCL · Origin port", secondary: "ETD confirmed", status: "Booked" },
  { id: "FR-7790", primary: "Airfreight consolidation", secondary: "In transit to SIN", status: "In transit" },
  { id: "FR-7805", primary: "LCL · Origin port", secondary: "Awaiting documents", status: "Attention" },
];

const STATUS_STYLE: Record<Row["status"], string> = {
  "On track": "text-confirm",
  "Delivered": "text-confirm",
  "In stock": "text-confirm",
  "Booked": "text-confirm",
  "Attention": "text-signal",
  "Low stock": "text-signal",
  "In transit": "text-brand",
};

function DataPanel({ rows }: { rows: Row[] }) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.primary.toLowerCase().includes(q) ||
        r.secondary.toLowerCase().includes(q)
    );
  }, [rows, query]);

  return (
    <div>
      <div className="relative mb-4 max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter this list…"
          className="pl-9"
          aria-label="Filter table rows"
        />
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-border">
            {filtered.map((r) => (
              <tr key={r.id} className="bg-paper">
                <td className="px-4 py-3 font-mono text-xs text-ink-muted whitespace-nowrap">{r.id}</td>
                <td className="px-4 py-3 text-ink">{r.primary}</td>
                <td className="px-4 py-3 text-ink-muted hidden sm:table-cell">{r.secondary}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "whitespace-nowrap text-sm font-semibold",
                      STATUS_STYLE[r.status]
                    )}
                  >
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-ink-muted">
                  No rows match &ldquo;{query}&rdquo;.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PlatformMockup() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="max-w-2xl">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">
          Platform — IdealOne
        </span>
        <h2 className="mt-3 font-display text-4xl font-semibold text-ink">
          IdealOne: the same screen we work from.
        </h2>
        <p className="mt-4 text-lg leading-relaxed text-ink-muted">
          IdealOne is our in-house operating platform. Orders, stock, and shipment
          status stay on one screen, so the workflow does not split between a
          marketplace and a warehouse login. This is a simplified, illustrative
          preview — try the tabs and the filter field below.
        </p>
      </Reveal>

      <dl className="mt-10 border-t border-border">
        <div className="grid grid-cols-1 gap-2 border-b border-border py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
          <dt className="font-display text-lg font-semibold text-ink">With integration</dt>
          <dd className="text-sm leading-relaxed text-ink-muted">
            Connect your storefront, marketplace, or WMS to IdealOne via API or file feed. Orders,
            inventory, and status updates sync automatically — no re-keying.
          </dd>
        </div>
        <div className="grid grid-cols-1 gap-2 border-b border-border py-5 sm:grid-cols-[14rem_1fr] sm:gap-8">
          <dt className="font-display text-lg font-semibold text-ink">Without integration</dt>
          <dd className="text-sm leading-relaxed text-ink-muted">
            No systems to connect yet? Log in and run orders, inventory, and shipments directly
            from IdealOne, or upload a spreadsheet — no engineering time required to get started.
          </dd>
        </div>
      </dl>

      <Reveal delay={0.15} className="mt-6 rounded-lg border border-border bg-paper-alt p-6 sm:p-8">
        <Tabs defaultValue="orders">
          <TabsList>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="inventory">Inventory</TabsTrigger>
            <TabsTrigger value="shipments">Shipments</TabsTrigger>
          </TabsList>
          <TabsContent value="orders">
            <DataPanel rows={ORDERS} />
          </TabsContent>
          <TabsContent value="inventory">
            <DataPanel rows={INVENTORY} />
          </TabsContent>
          <TabsContent value="shipments">
            <DataPanel rows={SHIPMENTS} />
          </TabsContent>
        </Tabs>
      </Reveal>
    </section>
  );
}
