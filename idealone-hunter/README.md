# IdealOne.Hunter

<img src="assets/logo.png" alt="IdealOne.Hunter logo" width="300">

**AI lead intelligence, sold as a standalone suite in the IdealOne family of apps.**

IdealOne.Hunter discovers companies showing credible, recent buying signals, verifies them against real sources, scores commercial fit, finds publicly listed decision-makers, and drafts personalised outreach — then holds everything in a human approval queue. **Nothing is ever sent automatically.**

It runs on its own database and scheduler and requires no other IdealOne app. Integration with IdealOne.CRM (converting qualified leads into CRM accounts) is an optional add-on, not a dependency.

## What's in this package

| File | Purpose |
|---|---|
| `idealone-hunter-spec.md` | Implementation Specification v1.0 — pipeline design, signal taxonomy, schema, dedupe rules, dashboard, ops |
| `lead_agent.py` | Reference implementation of the multi-agent pipeline (Scout → Verifier → Analyst → Contact Researcher → Outreach Writer) |
| `prompts.json` | The five subagent system prompts loaded by `lead_agent.py` |
| `requirements.txt` | Python dependencies |
| `assets/logo.svg`, `assets/logo.png` | IdealOne.Hunter brand lockup (vector + raster) |

The shipped prompts are configured for the first customer deployment — United Logistics & Distribution (Singapore) Pte Ltd (ULD), a Singapore 3PL. Selling the suite to a new customer means editing `prompts.json` (company profile, buying signals, service map, tone); the pipeline code is customer-agnostic.

## Quick start

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...   # required
export APOLLO_API_KEY=...      # optional; contact research degrades gracefully without it
export LEAD_DB=leads.db        # optional; defaults to uld_leads.db
python lead_agent.py run
```

Schedule with cron for weekday-morning runs: `0 8 * * 1-5` (Asia/Singapore for the ULD deployment).

## Hard rules (enforced in the pipeline, not just the prompts)

1. No email is ever dispatched without a human setting status → `Contact Approved`. The pipeline may only write `New`, `Verified`, `High Priority`, `Monitor`.
2. No lead is written without at least one evidence URL and a verifiable date.
3. Contact fields are only populated from Apollo API responses or fetched public pages — never from model free-text.

See `idealone-hunter-spec.md` for the full design.
