# NimbusTrade Solutions — marketing site

A Next.js (App Router) marketing site for NimbusTrade Solutions, a fictional Singapore
4PL/3PL logistics operator. Built with TypeScript, Tailwind CSS v4, hand-rolled
shadcn-style UI primitives (Radix + `class-variance-authority`), Framer Motion, and
React Hook Form + Zod.

## Setup

```bash
npm install
npm run dev      # http://localhost:3000
```

No environment variables are required — the site is fully static/client-side. The
contact and quote forms currently log submissions to the browser console only (see
"Connecting the forms" below).

Other scripts:

```bash
npm run build    # production build
npm run start    # serve the production build
npm run lint     # ESLint
npx playwright test   # run the test suite (tests/*.spec.ts)
```

Playwright is configured to launch the pre-installed Chromium at
`/opt/pw-browsers/chromium` (see `playwright.config.ts`) and will start the dev
server automatically if one isn't already running.

## Folder structure

```
src/
  app/
    layout.tsx          Root layout — fonts, metadata, header/footer chrome
    page.tsx             Home page (assembles the section components below)
    about/, services/, solutions/, industries/, contact/, quote/
    privacy/, terms/     Placeholder legal pages
    globals.css          Tailwind v4 @theme tokens (brand palette, fonts, radii)
  components/
    ui/                  Hand-rolled shadcn-style primitives (button, card, input,
                          label, textarea, select, tabs, accordion)
    sections/            Page sections (hero, credibility, services,
                          solutions-selector, how-it-works, industries,
                          platform-mockup, case-studies, contact-section,
                          quote-form)
    site-header.tsx, site-footer.tsx
  data/                  Content data (services, solutions, industries, case studies)
  lib/utils.ts           `cn()` class-merging helper
tests/                   Playwright test suite
public/                  logo.png, favicon.png, icon-192/512.png
```

## Design notes

- **Brand palette**: blue (`#0a558b` / `#0f6aa8` / `#4a9bd4`), near-white paper tones,
  no dark mode — matches the client-supplied logo exactly (colors were sampled
  directly from the logo file).
- **Typography**: Big Shoulders (display/headings), IBM Plex Sans (body), IBM Plex
  Mono (code/IDs), all self-hosted via `next/font/google`.
- **No shadcn CLI**: the CLI's registry (`ui.shadcn.com`) isn't reachable from this
  build environment, so the primitives in `src/components/ui/` were hand-built
  directly on top of the same underlying Radix packages the CLI would have used.

## Content still marked as placeholder

Per the brief, nothing has been fabricated — anything not yet confirmed is
labeled inline as a placeholder and should be replaced before this site is
published externally:

- **Case studies** (`/`, case-studies data): real engagements, but client
  names are intentionally withheld — each is described generically
  (e.g. "A fashion & apparel brand") rather than attributed by name.
- **Contact details**: registered office address (footer, `/contact`) is
  still a placeholder pending confirmation. Phone, WhatsApp, and email are
  set to real values.
- **About page**: founding date, company history, and leadership bios.
- **Legal pages** (`/privacy`, `/terms`): stub pages that should be drafted with
  real legal review before launch.
- **Industries list**: illustrative — confirm which verticals NimbusTrade has
  real, citable experience in before publishing externally.

The homepage stats (13 markets, 8 service lines, 1 operating desk) and the
testimonials-style narrative tone were established earlier in this project as
in-universe facts for this fictional company, not flagged as placeholders.

## Connecting the forms to a real backend

Both `src/components/sections/contact-section.tsx` and
`src/components/sections/quote-form.tsx` currently `console.log` their
validated submission and show a success state — there's no backend yet. Each
`onSubmit` is a single async function, so wiring it up is a matter of replacing
the `console.log` with a real call, for example:

- **Email**: POST to a serverless function that sends via Resend/Postmark/SES.
- **CRM**: POST to the CRM's REST API (HubSpot, Pipedrive, etc.) or a webhook.
- **Generic backend**: POST to a Next.js Route Handler (`src/app/api/.../route.ts`)
  that validates with the same Zod schema and forwards the data on.

The Zod schemas (`quoteSchema`, `contactSchema`) already define the exact shape
of the data available at submit time, so the request payload doesn't need to be
redesigned — only the destination.

## Completed interactions

- Header: compact/translucent on scroll, working mobile menu.
- Hero: animated multi-stop shipment path (SVG + Framer Motion `offsetPath`),
  disabled automatically under `prefers-reduced-motion`.
- Solutions selector: client-side tab switching across 8 solutions, no reload.
- How It Works: scroll-triggered, staggered reveal (Framer Motion `whileInView`).
- Platform mock-up: real tabs (Orders/Inventory/Shipments) each with a live
  client-side text filter over the visible rows.
- Multi-step quote form: 6 steps, per-step Zod validation, progress indicator,
  back/next, a review step, and a success state.
- Contact form: validated, with its own success state.

## Testing performed

`npx playwright test` runs 36 tests against Chromium, covering:

- Page-to-page navigation (desktop nav + mobile hamburger menu).
- The Solutions selector's tab switching.
- The Platform mock-up's tab switching and live filter (including the
  "no rows match" empty state).
- The quote form end to end: blocked-without-required-field validation,
  every step, the Back button preserving already-entered data, the review
  step, and the success state.
- Responsive layout (no horizontal overflow) at 375px, 768px, 1280px, and
  1440px across every page.
- `prefers-reduced-motion` — the hero still renders its content correctly.

All 36 tests pass as of the last run. A production build (`npm run build`)
also completes cleanly with no TypeScript errors.
