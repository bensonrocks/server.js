import { cn } from "@/lib/utils";

/** Intrinsic size of /logo.png. Do not change these without measuring the file. */
const LOGO_W = 270;
const LOGO_H = 127;

export function BrandLogo({
  variant = "header",
  priority = false,
  className,
}: {
  variant?: "header" | "footer";
  priority?: boolean;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="NimbusTrade Solutions"
      width={LOGO_W}
      height={LOGO_H}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      className={cn(
        "brand-lockup",
        variant === "header" ? "is-header" : "is-footer",
        className
      )}
    />
  );
}
