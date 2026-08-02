"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WaveMark } from "@/components/wave-mark";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/services", label: "Services" },
  { href: "/solutions", label: "Solutions" },
  { href: "/industries", label: "Industries" },
  { href: "/contact", label: "Contact" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full border-b transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300",
        scrolled
          ? "border-border bg-paper/90 backdrop-blur-md shadow-[0_1px_0_rgba(20,23,27,0.05)]"
          : "border-transparent bg-paper"
      )}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-3">
        <Link
          href="/"
          className={cn(
            "flex shrink-0 origin-left items-center gap-3 transition-transform duration-300 ease-out motion-reduce:transition-none",
            scrolled ? "scale-[0.86]" : "scale-100"
          )}
          aria-label="NimbusTrade Solutions home"
        >
          <WaveMark className="h-9 w-auto shrink-0 text-brand sm:h-11 md:h-14" />
          <span className="flex min-w-0 flex-col leading-none">
            <span className="whitespace-nowrap font-display text-base font-bold tracking-[0.03em] text-brand sm:text-xl sm:tracking-[0.08em] md:text-2xl">
              NIMBUSTRADE
              <span className="text-ink"> SOLUTIONS</span>
            </span>
            <span className="mt-0.5 hidden text-[11px] tracking-[0.2em] text-ink-muted sm:block">
              云腾贸易方案私人有限公司
            </span>
          </span>
        </Link>

        <nav className="hidden lg:flex items-center gap-8">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "text-sm font-semibold tracking-wide transition-colors",
                  active ? "text-brand" : "text-ink-muted hover:text-ink"
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden lg:flex items-center gap-3">
          <Button asChild size="sm">
            <Link href="/quote">Get a Quote</Link>
          </Button>
        </div>

        <button
          type="button"
          className="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-sm text-ink"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="lg:hidden border-t border-border bg-paper px-6 py-4">
          <nav className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "rounded-sm px-3 py-3 text-base font-semibold transition-colors",
                    active ? "bg-brand-tint text-brand" : "text-ink hover:bg-paper-alt"
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-4 flex flex-col gap-2">
            <Button asChild className="w-full">
              <Link href="/quote" onClick={() => setMobileOpen(false)}>
                Get a Quote
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
