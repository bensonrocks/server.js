import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";

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
    <footer className="border-t border-border bg-paper">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <BrandLogo variant="footer" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-muted">
              Run by merchants. We run fulfillment, retail enablement, and logistics
              in Singapore and Malaysia, and ecommerce fulfillment worldwide,
              including the USA.
            </p>
            <address className="mt-6 space-y-1 text-sm not-italic leading-relaxed text-ink-muted">
              <p>Singapore</p>
              <p>
                <a href="tel:+6588776106" className="hover:text-ink">
                  +65 8877 6106
                </a>
              </p>
              <p>
                <a href="mailto:info@nimbustrade.co" className="hover:text-ink">
                  info@nimbustrade.co
                </a>
              </p>
            </address>
          </div>

          {FOOTER_NAV.map((col) => (
            <div key={col.heading}>
              <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-ink-muted">
                {col.heading}
              </h3>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-ink transition-colors hover:text-brand"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-border pt-6 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {new Date().getFullYear()} NimbusTrade Solutions. All rights reserved.</p>
          <a href="/client-access/" className="hover:text-ink">
            Client login
          </a>
        </div>
        <p className="mt-8 text-center">
          <a
            href="/staff-access"
            className="text-[11px] font-normal text-ink-faint hover:text-ink-muted"
          >
            Administrator
          </a>
        </p>
      </div>
    </footer>
  );
}
