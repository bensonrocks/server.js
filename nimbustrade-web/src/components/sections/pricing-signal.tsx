import Link from "next/link";

export function PricingSignal() {
  return (
    <section className="border-y border-border bg-paper-alt">
      <div className="mx-auto max-w-4xl px-6 py-10 text-center">
        <p className="text-sm leading-relaxed text-ink">
          No minimum volume, no fixed-term lease — every engagement runs month-to-month. A rate
          card is quoted per scope and issued within 2 business days of a scoping call.{" "}
          <Link href="/quote" className="font-semibold text-brand hover:underline">
            The quote form takes about two minutes.
          </Link>
        </p>
      </div>
    </section>
  );
}
