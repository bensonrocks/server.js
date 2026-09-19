# Liagire Workflow

A standalone quote-to-cash tracker. It is a **separate app** from IDEALONE
(this repo's warehouse system) — its own server, its own SQLite database,
its own login. Nothing here shares data, users or sessions with IDEALONE.

## The flow

Every job moves through one linear pipeline, and can only move forward:

```
quote requested → quote sent → accepted → collected → in transit
  → delivered → invoiced → paid
```

A job can be **cancelled** at any point (a flag on top of the pipeline, not
a stage — a cancelled job still remembers which stage it had reached, and
can be reactivated).

Alongside the client side of a job, any number of **vendor cost invoices**
can be logged against it (freight, customs, trucking, etc.), each with its
own payment ledger — so a job's margin (client invoice minus vendor costs)
and two separate payment pictures (what the client owes us, what we owe
vendors) are both visible at a glance. Vendor costs are never shown on the
client-facing view.

## What each stage actually enforces

- **Acceptance** cannot be recorded without a quote having been sent, and
  requires an uploaded proof (PO, signed quote, confirmation email, etc.)
  the first time.
- **Collection** cannot be recorded before acceptance, and requires at
  least one photo.
- **Shipment tracking** cannot start before collection.
- **Delivery** cannot be recorded before tracking has started, and
  requires at least one photo.
- **Payment** cannot be recorded before an invoice has been issued.

Payments are a ledger (one row per receipt), not a single number you
overwrite — `paid_amount` and `payment_status` are always derived by
summing that ledger, so a mistaken entry can be deleted and the totals
heal themselves.

## Two views

- **Staff dashboard** (`/index.html`, behind login) — the full pipeline,
  every action, vendor costs, users (admin), and a shareable client link
  per job.
- **Client view** (`/client.html?t=<token>`) — read-only, no login. One
  unguessable token per job. Shows the timeline, collection/delivery
  photos, tracking, and invoice/payment status. Never shows vendor costs,
  vendor names, internal notes, or who on our side did what.

## Running it

```bash
cd liagire
npm install
npm start          # listens on :4100 by default (LIAGIRE_PORT / PORT to change)
```

On first boot with an empty database, an admin account is created
automatically and its username/password are printed once to the console.
Set `LIAGIRE_ADMIN_USER` / `LIAGIRE_ADMIN_PASSWORD` before that first boot
to choose them yourself instead.

Data lives in `liagire/data/` (SQLite database + uploaded photos/documents)
— gitignored, not committed. Back it up like you would any small
production database.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LIAGIRE_PORT` / `PORT` | `4100` | HTTP port |
| `LIAGIRE_DATA_DIR` | `liagire/data` | Where the DB and uploads live |
| `LIAGIRE_ADMIN_USER` | `admin` | First-boot admin username |
| `LIAGIRE_ADMIN_PASSWORD` | random | First-boot admin password |

## Known limits (by design, for a first cut)

- Sessions are in-memory — a restart signs everyone out. Fine for a small
  internal tool; move to a persisted session store if that becomes
  annoying.
- The client link is a bearer token (anyone holding the URL can view that
  one job, read-only). There is no client login. This matches what was
  asked for — frictionless client viewing — not a full client portal.
- One currency field per job/invoice/vendor-cost (free text, defaults to
  SGD) — no FX conversion or multi-currency rollups.
