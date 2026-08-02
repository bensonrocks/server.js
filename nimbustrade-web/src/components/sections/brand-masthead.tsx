import { ChevronDown } from "lucide-react";
import { WaveMark } from "@/components/wave-mark";

export function BrandMasthead() {
  return (
    <section>
      <div className="flex flex-col items-center px-6 py-16 sm:py-24">
        <WaveMark className="h-24 w-auto text-brand sm:h-32 md:h-40" />
        <h1 className="mt-6 text-center font-display text-3xl font-bold tracking-[0.15em] text-brand sm:text-4xl md:text-5xl">
          NIMBUSTRADE SOLUTIONS
        </h1>
        <p className="mt-3 text-center text-base tracking-[0.3em] text-brand-bright sm:text-lg">
          云腾贸易方案私人有限公司
        </p>
        <ChevronDown className="mt-10 h-8 w-8 animate-bounce text-ink-muted" aria-hidden />
      </div>

      <div className="relative aspect-[21/9] w-full overflow-hidden sm:aspect-[3/1]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gallery/gallery-racking-wide.jpg"
          alt="Inside a NimbusTrade-appointed warehouse"
          className="h-full w-full object-cover object-[center_35%]"
        />
      </div>
    </section>
  );
}
