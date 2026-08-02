import type { Metadata } from "next";
import { Credibility } from "@/components/sections/credibility";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";

export const metadata: Metadata = { title: "About — NimbusTrade Solutions" };

const FAQS = [
  {
    q: "Where is NimbusTrade based?",
    a: "The operating desk is based in Singapore, coordinating a network of warehousing, freight, and last-mile partners across the region.",
  },
  {
    q: "Do I need to use every service line?",
    a: "No — most clients start with one or two service lines (often warehousing and fulfilment) and add freight, distribution, or tech integration later as they need them.",
  },
  {
    q: "How is pricing structured?",
    a: "Pricing is scoped per client against the specific service lines you use, set out in a written rate card after the scoping call — there's no one-size-fits-all rate.",
  },
  {
    q: "Can you support a brand expanding into a new country?",
    a: "Yes — cross-border expansion is one of our service lines, typically starting with a local handoff partner before a client commits to a fuller local presence.",
  },
];

export default function AboutPage() {
  return (
    <div>
      <div className="mx-auto max-w-7xl px-6 py-20">
        <div className="max-w-2xl">
          <span className="text-xs font-bold uppercase tracking-wider text-brand">About</span>
          <h1 className="mt-3 font-display text-5xl font-bold text-ink">
            One desk, coordinating the operating layer.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-ink-muted">
            NimbusTrade Solutions was set up to remove the coordination overhead of running
            e-commerce logistics across multiple vendors — one warehouse, one freight forwarder,
            one customs broker, one set of reports. We run that coordination as a single desk, so
            our clients deal with one point of contact instead of five.
          </p>
          <p className="mt-4 rounded-sm border border-dashed border-border-strong bg-paper-alt px-4 py-3 text-sm text-ink-muted">
            [ Company history, founding date, and leadership bios — placeholder pending
            confirmed details. ]
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gallery/gallery-racking-aisle.jpg"
            alt="Pallet racking inside a NimbusTrade-appointed warehouse"
            className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/gallery/gallery-outbound-single.jpg"
            alt="An outbound parcel ready for courier collection"
            className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
          />
        </div>
      </div>

      <Credibility />

      <section className="mx-auto max-w-4xl px-6 py-24">
        <span className="text-xs font-bold uppercase tracking-wider text-brand">FAQ</span>
        <h2 className="mt-3 font-display text-4xl font-bold text-ink">Common questions.</h2>
        <Accordion type="single" collapsible className="mt-8">
          {FAQS.map((item) => (
            <AccordionItem key={item.q} value={item.q}>
              <AccordionTrigger>{item.q}</AccordionTrigger>
              <AccordionContent>{item.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
    </div>
  );
}
