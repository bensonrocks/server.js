import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Policy — NimbusTrade Solutions" };

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="font-display text-4xl font-bold text-ink">Privacy policy</h1>
      <p className="mt-6 rounded-sm border border-dashed border-border-strong bg-paper-alt px-4 py-3 text-sm text-ink-muted">
        Placeholder page. A real privacy policy — describing what data this site and its forms
        collect, how it is stored, and how visitors can request its removal — should be drafted
        with legal review before this page is published.
      </p>
    </div>
  );
}
