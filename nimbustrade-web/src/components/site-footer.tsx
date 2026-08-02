import Link from "next/link";
import { Mail, Phone, MapPin } from "lucide-react";

const FOOTER_NAV = [
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/industries", label: "Industries" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Services",
    links: [
      { href: "/services", label: "All services" },
      { href: "/solutions", label: "Solutions" },
      { href: "/quote", label: "Get a quote" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy policy" },
      { href: "/terms", label: "Terms of service" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-paper-alt">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <img src="/logo.png" alt="NimbusTrade Solutions" className="h-16 w-auto" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-muted">
              A Singapore-based 4PL/3PL partner coordinating warehousing, fulfilment, and
              cross-border freight for growing brands.
            </p>
            <div className="mt-6 space-y-2 text-sm text-ink-muted">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 shrink-0 text-brand" />
                <span>62 Ubi Road 1, Oxley Bizhub 2, #06-01, Singapore 408734</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 shrink-0 text-brand" />
                <span>+65 8877 6106</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 shrink-0 text-brand" />
                <span>info@nimbustrade.co</span>
              </div>
            </div>
          </div>

          {FOOTER_NAV.map((col) => (
            <div key={col.heading}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink">
                {col.heading}
              </h3>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-ink-muted transition-colors hover:text-brand"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-border pt-8 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {new Date().getFullYear()} NimbusTrade Solutions. All rights reserved.</p>
          <p className="text-ink-muted/80">
            Content marked as a placeholder has not yet been confirmed for publication.
          </p>
        </div>
      </div>
    </footer>
  );
}
