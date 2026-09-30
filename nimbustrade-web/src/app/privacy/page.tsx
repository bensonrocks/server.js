import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  robots: { index: false, follow: true },
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">Legal</p>
      <h1 className="mt-3 font-display text-4xl font-semibold text-ink">Privacy policy</h1>
      <p className="mt-6 rounded-sm border border-dashed border-border-strong bg-paper-alt px-4 py-3 text-sm text-ink-muted">
        Placeholder page. A real privacy policy — describing what data this site and its forms
        collect, how it is stored, and how visitors can request its removal — should be drafted
        with legal review before this page is published.
      </p>
    </div>
  );
}
