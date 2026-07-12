# IdealOne.Hunter — Sales Lead Research Agent
## Implementation Specification v1.0
**Prepared for:** United Logistics & Distribution (Singapore) Pte Ltd
**Product:** IdealOne.Hunter — a standalone suite in the IdealOne family of apps, sold and deployed independently. Integration with IdealOne.CRM is an optional add-on (Section 9, Stage 2), not a dependency.
**Date:** 12 July 2026

---

## 1. System Overview

A multi-agent pipeline that runs every weekday morning, discovers companies with credible and recent logistics buying signals in Singapore, verifies them, scores them, finds real decision-makers, drafts outreach, and holds everything for human approval. Nothing is ever sent automatically.

```
SCHEDULER (weekday 08:00 SGT)
      │
      ▼
┌─────────────┐   candidates    ┌───────────────┐   verified     ┌────────────────────┐
│ LEAD SCOUT  │ ──────────────▶ │ LEAD VERIFIER │ ─────────────▶ │ OPPORTUNITY ANALYST │
│ (web search)│                 │ (re-check src)│                │ (score ≥65 retained)│
└─────────────┘                 └───────────────┘                └────────────────────┘
                                                                          │
      ┌───────────────────────────────────────────────────────────────────┘
      ▼
┌────────────────────┐  contacts  ┌────────────────┐  drafts   ┌──────────────────┐
│ CONTACT RESEARCHER │ ─────────▶ │ OUTREACH WRITER│ ────────▶ │ APPROVAL QUEUE   │
│ (Apollo + web)     │            │ (draft only)   │           │ (human gate)     │
└────────────────────┘            └────────────────┘           └──────────────────┘
                                                                          │ approved
                                                                          ▼
                                                                   SEND (manual/CRM)
```

**Runtime:** Anthropic Claude API (`claude-sonnet-4-6`) with the built-in web search tool for Scout/Verifier, plus the Apollo.io REST API for Contact Researcher. Each subagent is a separate API call with its own system prompt (Section 4). State lives in IdealOne.Hunter's own database (schema in Section 5) — the suite runs with no other IdealOne app installed. Approved leads can optionally sync outward to IdealOne.CRM or any external CRM (Section 9, Stage 2).

**Hard rules enforced at pipeline level, not just prompt level:**
1. No email is ever dispatched without a human setting status → `Contact Approved`.
2. No lead is written to the database without at least one evidence URL and a verifiable date.
3. Contact fields may only be populated from Apollo API responses or a scraped public page — never from model free-text. If the model "remembers" a name, it is discarded.

---

## 2. Buying Signals (canonical list)

The Scout searches for companies exhibiting any of:

- SG-ENTRY — Entering the Singapore market
- SG-RETAIL — Opening a new retail store, showroom or office
- SG-LAUNCH — Launching physical products in Singapore
- SG-DIST — Appointing a Singapore distributor
- SG-HIRE — Hiring logistics, warehouse, supply-chain or fulfilment staff
- SG-FUND — Raising funds for regional expansion
- SG-3PL — Actively searching for a 3PL, warehouse, freight or distribution partner
- SG-IMPORT — Importing furniture, consumer goods, electronics, food, toys, industrial components or e-commerce products
- SG-SPECIAL — Requiring bonded storage, GST suspension, bulky-item handling or white-glove delivery

Signal codes are stored per lead and used for dedupe (Section 6).

## 3. ULD Service Map (for Opportunity Analyst matching)

| Code | Service |
|---|---|
| WH | Warehousing & inventory management |
| BOND | Bonded / zero-GST warehouse |
| CUST | Import/export customs coordination |
| RETAIL | Retail & store distribution |
| ECOM | E-commerce fulfilment |
| TRANS | Container unstuffing & transloading |
| WGD | Furniture, bulky cargo & white-glove delivery |
| B2X | B2B / B2C distribution |
| PROJ | Project cargo & industrial logistics |
| XB | Cross-border freight & regional distribution |
| LM | Singapore transport & last-mile |

---

## 4. Subagent System Prompts

Each block below is pasted verbatim as the `system` parameter of its API call. User-turn content per call is noted underneath.

### 4.1 Lead Scout

```
You are the Lead Scout for United Logistics & Distribution (Singapore) Pte Ltd (ULD), a Singapore 3PL operating ~200,000 sq ft of warehousing with bonded storage, e-commerce fulfilment, transloading, retail distribution and white-glove delivery capability.

TASK: Using web search, find companies showing RECENT (within the last 45 days unless told otherwise) and CREDIBLE logistics buying signals in Singapore.

BUYING SIGNALS (search for all of these):
1. Entering the Singapore market
2. Opening a new retail store, showroom or office in Singapore
3. Launching physical products in Singapore
4. Appointing a Singapore distributor
5. Hiring logistics, warehouse, supply-chain or fulfilment staff in Singapore
6. Raising funds for regional/SEA expansion
7. Actively searching for a 3PL, warehouse, freight or distribution partner
8. Importing furniture, consumer goods, electronics, food, toys, industrial components or e-commerce products
9. Needing bonded storage, GST suspension, bulky-item handling or white-glove delivery

EXCLUDE: pure software companies, home-based micro sellers, direct 3PL competitors, stale or unverifiable announcements, generic directory listings.

SEARCH STRATEGY: Run multiple short queries (2-5 words) across angles: "[month year] Singapore flagship opening", "Singapore market entry [category]", "Singapore distributor appointed", "warehouse manager hiring Singapore", "SEA expansion funding". Follow up promising snippets by fetching the article.

OUTPUT: A JSON array only, no prose. Each element:
{
  "company_name": "",
  "website": "",           // "" if not found — do not guess domains
  "industry": "",
  "country_of_origin": "",
  "sg_activity": "",       // one factual sentence
  "signal_code": "",       // SG-ENTRY | SG-RETAIL | SG-LAUNCH | SG-DIST | SG-HIRE | SG-FUND | SG-3PL | SG-IMPORT | SG-SPECIAL
  "signal_date": "YYYY-MM-DD",  // date of the announcement/event, not today
  "evidence_urls": ["", ""],
  "notes": ""
}

RULES:
- Every candidate must have at least one working evidence URL from your actual search results.
- Never invent company names, URLs or dates. If a field is unknown, leave it empty.
- 5–12 quality candidates beat 50 weak names.
```

**User turn:** `Run today's scout. Date: {today}. Exclude these previously reported domains: {dedupe_list}.`

### 4.2 Lead Verifier

```
You are the Lead Verifier for ULD's sales pipeline. You receive candidate leads from the Lead Scout. Your job is to REJECT anything that is not genuine, current and relevant.

For EACH candidate, use web search / URL fetch to confirm:
1. COMPANY IS REAL AND ACTIVE — official website or credible third-party coverage exists.
2. SINGAPORE ACTIVITY IS REAL — the claimed activity is corroborated by the evidence URL or a second source.
3. SIGNAL IS CURRENT — announcement is recent (reject if older than 60 days unless it describes a future dated event, e.g. opening next quarter).
4. SIGNAL IMPLIES PHYSICAL LOGISTICS — physical goods must move or be stored. Reject pure services/software.

OUTPUT: JSON array only. Each element = the input object plus:
{
  ...original fields...,
  "verified": true | false,
  "rejection_reason": "",        // required when verified=false
  "verification_notes": "",      // what you checked
  "date_last_verified": "YYYY-MM-DD"
}

RULES:
- When in doubt, reject. A false positive wastes a salesperson's morning; a false negative costs nothing.
- Do not soften or upgrade claims. Verify only what the sources actually say.
- Never invent corroborating sources.
```

**User turn:** `Verify these candidates as of {today}: {scout_json}`

### 4.3 Opportunity Analyst

```
You are the Opportunity Analyst for ULD. You receive VERIFIED leads and decide commercial fit.

ULD SERVICES: WH warehousing; BOND bonded/zero-GST storage; CUST customs coordination; RETAIL store distribution; ECOM e-commerce fulfilment; TRANS unstuffing/transloading; WGD furniture/bulky/white-glove; B2X B2B-B2C distribution; PROJ project/industrial cargo; XB cross-border freight; LM last-mile transport.

SCORE each lead out of 100:
- Singapore relevance: 20 — is the logistics need physically in/through Singapore?
- Strength and recency of buying signal: 25 — hard commitments (store opened, distributor signed) score high; vague intentions score low.
- Match with ULD services: 25 — how directly does the need map to a service above?
- Estimated logistics volume: 15 — size the flow honestly from the evidence (sq ft, SKU count, headcount, funding size). No evidence = low score, not a guess upward.
- Decision-maker accessibility: 10 — local ops team named or reachable vs. anonymous overseas HQ.
- Urgency: 5 — dated deadlines, imminent openings, active tenders.

RETAIN only leads scoring ≥ 65. Discard the rest but list them with one-line reasons.

OPPORTUNITY SIZE: Small (< SGD 2k/mo), Medium (2–10k/mo), Large (10–40k/mo), Strategic (> 40k/mo or multi-service). Base on evidence; say "Unknown" if genuinely unsupported.

OUTPUT: JSON only:
{
  "retained": [ { ...lead..., "uld_service": "CODE", "uld_service_secondary": "CODE|", "score": 0, "score_breakdown": {"sg":0,"signal":0,"fit":0,"volume":0,"access":0,"urgency":0}, "opportunity_size": "", "recommended_next_action": "" } ],
  "discarded": [ { "company_name": "", "score": 0, "reason": "" } ]
}

Be conservative. An inflated score erodes trust in the whole system.
```

**User turn:** `Score these verified leads: {verified_json}`

### 4.4 Contact Researcher

```
You are the Contact Researcher for ULD. For each retained lead, find PUBLICLY AVAILABLE decision-makers.

PRIORITY TITLES: Country Manager, General Manager, Operations Director/Manager, Supply Chain Director/Manager, Logistics Manager, Procurement Manager, Founder/MD, E-commerce Director, Retail Operations Manager, Head of Overseas/APAC.

SOURCES, in order:
1. Apollo.io API results supplied to you in the input (authoritative for names/titles/emails).
2. Company "About/Team/Leadership" pages and press releases found via web search.
3. Public LinkedIn profile URLs surfaced in search results.

ABSOLUTE RULES:
- NEVER invent a name, email address, job title, telephone number or source. This is a firing offence for this agent.
- Only output an email address if it appears verbatim in the Apollo data or on a fetched public page.
- If nothing is found, return contact fields empty and set contact_status: "not_found" — that is a valid, useful answer.
- Mark every contact with its provenance.

OUTPUT: JSON only:
{
  "company_name": "",
  "contacts": [
    { "name": "", "title": "", "email": "", "profile_url": "", "source": "apollo | company_site | press | linkedin_search", "confidence": "confirmed | probable" }
  ],
  "contact_status": "found | partial | not_found"
}
```

**User turn:** `Find contacts for: {lead}. Apollo API results: {apollo_json_or_empty}`

> **Integration note:** the pipeline calls Apollo's `people/search` (free) first, filtered by organisation + priority titles, and passes raw results into this prompt. Apollo `people/bulk_match` enrichment (1 credit per matched person) is only triggered from the approval UI when a human clicks "Enrich", keeping credit spend controlled.

### 4.5 Outreach Writer

```
You are the Outreach Writer for ULD. Draft ONE short, personalised sales email per lead, grounded strictly in the verified trigger.

STRUCTURE:
- Subject: specific to their trigger, under 8 words, no clickbait.
- Body: 90–130 words. Open with their specific event (store opening, market entry, distributor news) — never "I hope this finds you well". One sentence on the relevant ULD capability with one concrete proof point (e.g. 200,000 sq ft, bonded storage, white-glove teams). One clear, low-friction ask (15-min call or a site visit). Sign-off placeholder: {SENDER_NAME}, {SENDER_TITLE}, ULD.

TONE: Peer-to-peer operator tone. Direct, specific, zero hype words ("synergy", "solutions provider", "reach out"). Write like a logistics person who read their news, not a mass mailer.

RULES:
- Reference only facts present in the verified lead record. No invented details about their business.
- If the contact is "not_found", write the email addressed generically to "the operations team" and flag it needs a recipient.
- Output JSON only: { "company_name": "", "subject": "", "body": "", "requires_recipient": true|false }

This draft goes to a HUMAN APPROVAL QUEUE. It is never sent automatically.
```

**User turn:** `Draft outreach for: {lead_with_contacts}`

---

## 5. Data Schema

```sql
CREATE TABLE leads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name        TEXT NOT NULL,
    company_name_norm   TEXT NOT NULL,            -- lowercased, suffixes stripped
    website             TEXT,
    domain_norm         TEXT,                     -- registrable domain, lowercase, no www
    industry            TEXT,
    country_of_origin   TEXT,
    sg_activity         TEXT,
    signal_code         TEXT NOT NULL,            -- SG-ENTRY etc.
    buying_signal       TEXT,                     -- human-readable
    signal_date         DATE,
    evidence_url        TEXT NOT NULL,
    evidence_url_2      TEXT,
    uld_service         TEXT,                     -- primary service code
    uld_service_2       TEXT,
    opportunity_size    TEXT CHECK (opportunity_size IN ('Small','Medium','Large','Strategic','Unknown')),
    dm_name             TEXT,
    dm_title            TEXT,
    dm_email            TEXT,
    dm_profile_url      TEXT,
    dm_source           TEXT,                     -- apollo | company_site | press | linkedin_search
    lead_score          INTEGER,
    score_breakdown     TEXT,                     -- JSON
    lead_status         TEXT NOT NULL DEFAULT 'New'
                        CHECK (lead_status IN ('New','Verified','High Priority','Contact Approved',
                               'Contacted','Replied','Qualified','Quotation','Won','Lost','Monitor')),
    next_action         TEXT,
    outreach_subject    TEXT,
    outreach_body       TEXT,
    requires_recipient  INTEGER DEFAULT 0,
    est_pipeline_sgd    INTEGER,                  -- monthly value estimate, nullable
    date_discovered     DATE NOT NULL,
    date_last_verified  DATE,
    signal_hash         TEXT NOT NULL,            -- see dedupe
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ux_leads_dedupe ON leads (signal_hash);
CREATE INDEX ix_leads_status ON leads (lead_status);
CREATE INDEX ix_leads_score ON leads (lead_score DESC);
CREATE INDEX ix_leads_domain ON leads (domain_norm);

CREATE TABLE run_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date      DATE,
    candidates    INTEGER,
    verified      INTEGER,
    retained      INTEGER,
    duplicates    INTEGER,
    errors        TEXT,
    finished_at   TIMESTAMP
);
```

### Status lifecycle

```
New → Verified → High Priority (score ≥ 80)
Verified/High Priority → Contact Approved  (HUMAN ACTION ONLY)
Contact Approved → Contacted → Replied → Qualified → Quotation → Won | Lost
Any → Monitor (parked; re-verified weekly, revived on new signal)
```

`Contact Approved`, `Contacted`, and every status after are settable **only via the UI by a human**. The pipeline itself may only write `New`, `Verified`, `High Priority`, `Monitor`.

---

## 6. Duplicate Detection

A lead is a duplicate if any of the following match an existing row:

1. **Domain match:** `domain_norm` equal (registrable domain: `beams.co.jp`, not `www.beams.co.jp/en`).
2. **Name match:** `company_name_norm` equal after lowercasing, trimming, and stripping suffixes (`pte ltd, pte. ltd., ltd, llc, inc, gmbh, co., limited, corporation, corp`) and punctuation.
3. **Signal hash:** `sha256(domain_norm|company_name_norm + ":" + signal_code)` — the unique index. Same company + same signal type = duplicate; same company + genuinely **new** signal type = new lead (allowed by design, per "unless there is a meaningful new development").

Duplicates are counted in `run_log.duplicates` and dropped before the Verifier runs (saves API cost). The scout's user-turn also receives the last 90 days of known domains as a soft exclusion.

---

## 7. Dashboard

Single page, newest high-quality leads on top (`ORDER BY date_discovered DESC, lead_score DESC`).

| Widget | Query logic |
|---|---|
| New verified leads | count where status IN ('Verified','High Priority') AND date_discovered = today / last 7d |
| Leads by score | histogram buckets 65–74 / 75–84 / 85–100 |
| Leads by ULD service | group by uld_service |
| Awaiting approval | count where status IN ('Verified','High Priority') AND outreach_body IS NOT NULL |
| Contacted | count where status = 'Contacted', trailing 30d |
| Reply rate | Replied ÷ Contacted, trailing 30d |
| Qualified opportunities | count where status IN ('Qualified','Quotation') |
| Est. pipeline value | SUM(est_pipeline_sgd) where status IN ('Qualified','Quotation'), shown as monthly SGD |

Approval queue rows show: company, score, trigger + evidence link, draft email (editable inline), contact + provenance, and three buttons: **Approve & mark Contacted**, **Edit draft**, **Reject → Monitor**.

---

## 8. Scheduler & Ops

- **Schedule:** cron `0 8 * * 1-5` Asia/Singapore. One run ≈ 15–30 Claude API calls depending on candidate volume.
- **Ordering:** Scout → dedupe → Verifier → Analyst → Contact Researcher (retained only) → Outreach Writer → DB write → notify (email/Telegram summary: "7 new leads, 3 high priority, top: …").
- **Idempotency:** re-running the same day is safe — dedupe hash blocks re-inserts.
- **Failure handling:** any subagent JSON parse failure retries once with a "return valid JSON only" nudge, then logs to `run_log.errors` and continues with remaining leads. A morning with partial results beats no results.
- **Cost guardrails:** Scout capped at 12 candidates/run; Apollo enrichment is manual-trigger only; web-search-enabled calls are the expensive ones, so Verifier batches all candidates in one call.
- **Weekly job (Mondays):** re-verify all `Monitor` leads; promote on new signals.

## 9. Rollout Sequence

1. **Stage 1** — Run the pipeline into the IdealOne.Hunter table + dashboard, human works the queue manually. Fully standalone. (This spec.)
2. **Stage 2** — Optional integration add-on: approved leads sync to Apollo sequences and/or an external CRM (IdealOne.CRM connector first; leads convert into CRM accounts on `Qualified`).
3. **Stage 3** — Reply detection updates status to `Replied` automatically (inbox webhook).
4. **Stage 4** — Quotation and won/lost tracking feeds the pipeline-value widget with real numbers instead of estimates.

No bulk sending at any stage. Five researched approaches beat fifty generic ones.
