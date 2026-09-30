import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  robots: { index: false, follow: true },
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Legal</p>
      <h1 className="mt-3 font-display text-4xl font-semibold text-ink">Terms of service</h1>
      <p className="mt-6 rounded-sm border border-dashed border-border-strong bg-paper-alt px-4 py-3 text-sm text-ink-muted">
        Placeholder page. Real terms of service — covering the site itself and any service
        agreement referenced from it — should be drafted with legal review before this page is
        published.
      </p>
    </div>
  );
}
