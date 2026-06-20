# Louve Luxe App

All-in-one app for managing prospective clients, floor plans, room-by-room
furniture selections, and generating picture quotes with retail pricing.

## Features

- Create clients with name, address, and particulars.
- Upload a floor plan image; Claude (vision) suggests room names, which can
  be added as room sub-headings with one click, or added manually.
- Per room, add furniture items with an image, material, dimensions
  (W x D x H in cm), and cost price in SGD/USD/INR/RMB.
- Cost price is converted to SGD using a live exchange rate, then multiplied
  by a markup (default 2.4x, configurable via `SELLING_PRICE_MULTIPLIER`) to
  get the retail/selling price.
- Generate a picture quote PDF with room sub-headings, furniture photos,
  materials, dimensions, and the retail price per item plus a grand total.
- Staff login required for all client/quote data. Accounts are admin-created
  only — there is no public sign-up page. Admins can create and remove staff
  accounts from the "Manage Users" page.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — a Postgres connection string (e.g. from Supabase, Neon, or RDS).
   - `S3_*` — credentials and bucket for any S3-compatible object storage
     (AWS S3, Cloudflare R2, Supabase Storage, MinIO). The bucket should
     allow public read on uploaded objects, since the app links to
     `S3_PUBLIC_URL_BASE` directly for images.
   - `ANTHROPIC_API_KEY` — used for AI-assisted floor plan room detection.
   - `SESSION_SECRET` — a long random string for signing session cookies
     (e.g. `openssl rand -hex 32`).
3. `npx prisma migrate dev --name init` to create the database schema.
4. Create the first admin account: set `SEED_ADMIN_EMAIL`,
   `SEED_ADMIN_PASSWORD` (8+ chars), and `SEED_ADMIN_NAME` in `.env`, then
   run `npm run seed:admin`. You can remove those env vars afterwards.
5. `npm start` (or `npm run dev` for auto-restart on changes).
6. Open `http://localhost:3000` and log in with the admin account.

## Notes

- Exchange rates are fetched live from a free FX API and cached for 1 hour
  per currency.
- The selling price multiplier is a flat markup applied after converting
  cost price to SGD: `sellingPriceSgd = costPrice * rateToSgd * multiplier`.
