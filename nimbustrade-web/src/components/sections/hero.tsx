import Link from "next/link";
import { ArrowRight, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-paper">
      <div className="mx-auto max-w-3xl px-6 py-20 text-center lg:py-28">
        <span className="inline-flex items-center gap-2 rounded-sm border border-border-strong bg-paper-alt px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand">
          Singapore · Ecommerce Fulfillment Across Southeast Asia
        </span>
        <h1 className="mt-6 font-display text-5xl font-bold leading-[1.05] text-ink sm:text-6xl">
          One control tower for ecommerce fulfillment across Southeast Asia.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
          NimbusTrade Solutions runs the operating layer between your suppliers and
          your customers — a single Singapore desk coordinating storage, pick-and-pack,
          customs, and cross-border transport for B2B and B2C brands. Self-run out of
          Singapore and Malaysia, with an appointed-partner network reaching onward
          across Southeast Asia and into international markets.
        </p>
        <div className="mt-9 flex flex-col justify-center gap-4 sm:flex-row">
          <Button asChild size="lg">
            <Link href="/quote">
              Get a quote <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/solutions">
              <PlayCircle className="h-4 w-4" /> Explore solutions
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
