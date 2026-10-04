import { Credibility } from "@/components/sections/credibility";
import { FaqJsonLd } from "@/components/structured-data";
import { Reveal } from "@/components/reveal";
import { staggerDelay } from "@/lib/motion";
import { marketingMeta } from "@/lib/site-config";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";

export const metadata = marketingMeta({
  title: "A fulfillment desk run by merchants",
  description:
    "NimbusTrade is run by merchants. Enquire about pick and pack, retail enablement in Singapore and Malaysia, worldwide fulfillment including the USA, and compliance including FDA.",
  path: "/about",
});

const FAQS = [
  {
    q: "Who runs NimbusTrade?",
    a: "Merchants. The people on the desk sell and fulfil as well as run the operation, so pick, pack, inventory, and cross-border questions are familiar work.",
  },
  {
    q: "Where is NimbusTrade based?",
    a: "The operating desk is in Singapore. Warehouses we run ourselves are in Singapore and Malaysia, for ecommerce and retail enablement. Ecommerce fulfillment continues worldwide, including the USA, through appointed partners.",
  },
  {
    q: "Is NimbusTrade a one-stop, or do I pick one service?",
    a: "Both. The desk can take storage, orders, freight, and compliance together. Most clients start with one or two lines and add the rest when they need them.",
  },
  {
    q: "Can you handle regulatory compliance, including FDA?",
    a: "Yes. Compliance is a service we handle with the shipment, including FDA and similar regulatory work: the paperwork and permits that travel with the goods.",
  },
  {
    q: "How is pricing structured?",
    a: "Pricing is scoped per client against the specific service lines you use, set out in a written rate card after the scoping call — there's no one-size-fits-all rate.",
  },
  {
    q: "Can you support a brand selling into the USA, or another country?",
    a: "Yes. Ecommerce fulfillment is worldwide, including the USA. Cross-border starts with the lane you actually need, including a local handoff where that is how the destination works.",
  },
  {
    q: "Do you offer Merchant of Record or Importer of Record services?",
    a: "Yes — where trading requires an entity of record, we offer Merchant of Record and Importer of Record support so a brand can clear the destination without setting up a local company first.",
  },
];

export default function AboutPage() {
  return (
    <div>
      <FaqJsonLd faqs={FAQS} />
      <div className="mx-auto max-w-7xl px-6 py-20">
        <Reveal className="max-w-2xl">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">About</span>
          <h1 className="mt-3 font-display text-5xl font-semibold text-ink">
            One desk, coordinating the operating layer.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-ink-muted">
            NimbusTrade is run by merchants. We are merchants ourselves, so we know
            this work from the inside: the one-stop for brands that would otherwise
            keep a warehouse, a freight forwarder, a customs broker, and a stack of
            reports. Ecommerce and retail enablement in Singapore and Malaysia,
            ecommerce fulfillment worldwide including the USA, and the compliance
            that goes with the goods — one point of contact.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Reveal delay={staggerDelay(0)} className="overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/gallery/gallery-racking-aisle.jpg"
              alt="Pallet racking inside a NimbusTrade-appointed warehouse"
              className="aspect-[4/3] w-full object-cover"
            />
          </Reveal>
          <Reveal delay={staggerDelay(1)} className="overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/gallery/gallery-outbound-single.jpg"
              alt="An outbound parcel ready for courier collection"
              className="aspect-[4/3] w-full object-cover"
            />
          </Reveal>
        </div>
      </div>

      <Credibility />

      <section className="mx-auto max-w-4xl px-6 py-24">
        <Reveal>
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">FAQ</span>
          <h2 className="mt-3 font-display text-4xl font-semibold text-ink">Common questions.</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <Accordion type="single" collapsible className="mt-8">
            {FAQS.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </section>
    </div>
  );
}
