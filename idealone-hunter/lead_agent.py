"""
IdealOne.Hunter — Multi-tenant Sales Lead Research Agent
========================================================
Standalone suite in the IdealOne family of apps. Runs the multi-agent
pipeline (Scout -> Verifier -> Analyst -> Contact Researcher -> Outreach
Writer) for EVERY onboarded organisation, driven by each org's own
wishlist, and writes org-scoped leads into the SAME store the CRM web app
reads (PostgreSQL via DATABASE_URL, or JSON files under ../data).

Reselling model:
  - Each org's wishlist (market, industries, buying signals, what they
    sell, leads/day) is templated into the five system prompts.
  - The owner org ships pre-configured; tenant orgs fill their wishlist
    during signup onboarding. Orgs without setup_complete are skipped.
  - Results are capped at each org's leads_per_day and deduped against
    that org's existing leads.

Usage:
  python lead_agent.py run              # sweep every ready org
  python lead_agent.py run --org <id>   # one org only
  python lead_agent.py run --dry-run    # no API calls; stubbed candidates
                                        # (proves the read/write wiring)
Schedule: cron  0 8 * * 1-5  (per-org timezone handled by the host)

Env vars:
  DATABASE_URL        Postgres (shared with the web app). Omit -> JSON files.
  ANTHROPIC_API_KEY   Anthropic API key (required unless --dry-run)
  APOLLO_API_KEY      Apollo.io API key (optional; contact step degrades)

Dependencies:  pip install anthropic requests psycopg2-binary
NOTE: emails are NEVER sent by this script. It only writes drafts.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from datetime import date, datetime, timezone

import store

MODEL = "claude-sonnet-4-6"
SCORE_FLOOR = 65
HIGH_PRIORITY = 80

PROMPTS_FILE = os.path.join(os.path.dirname(__file__), "prompts.json")
with open(PROMPTS_FILE) as f:
    PROMPTS = json.load(f)

WEB_SEARCH_TOOL = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]


# ----------------------------------------------------------------------------
# Prompt templating from an org's wishlist
# ----------------------------------------------------------------------------
def fill(template, wishlist, max_candidates):
    """Substitute {ORG_NAME}, {MARKET}, ... into a system prompt."""
    return (template
            .replace("{ORG_NAME}", wishlist["org_name"])
            .replace("{MARKET}", wishlist.get("market") or "their market")
            .replace("{INDUSTRIES}", wishlist.get("industries") or "any relevant industry")
            .replace("{SIGNALS}", wishlist.get("signals") or "any credible buying signal")
            .replace("{SERVICES}", wishlist.get("services") or "their product/service")
            .replace("{NOTES}", wishlist.get("notes") or "none")
            .replace("{MAX_CANDIDATES}", str(max_candidates)))


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
SUFFIXES = r"\b(pte\.?\s*ltd\.?|ltd\.?|llc|inc\.?|gmbh|co\.?|limited|corporation|corp\.?|llp|sdn\.?\s*bhd\.?)\b"


def norm_name(name):
    n = re.sub(SUFFIXES, "", (name or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", n).strip()


def norm_domain(url):
    if not url:
        return ""
    d = re.sub(r"^https?://", "", url.lower()).split("/")[0]
    return d[4:] if d.startswith("www.") else d


def signal_hash(org_id, domain, name_norm, signal_code):
    key = org_id + ":" + (domain or name_norm) + ":" + (signal_code or "")
    return hashlib.sha256(key.encode()).hexdigest()


def extract_json(text):
    text = re.sub(r"```(?:json)?", "", text).strip("` \n")
    m = re.search(r"[\[{]", text)
    if not m:
        raise ValueError("no JSON found")
    return json.loads(text[m.start():])


# ----------------------------------------------------------------------------
# Claude subagent call (skipped in --dry-run)
# ----------------------------------------------------------------------------
_client = None


def call_agent(system, user, use_search=False, max_tokens=4000):
    global _client
    if _client is None:
        from anthropic import Anthropic
        _client = Anthropic()
    kwargs = dict(model=MODEL, max_tokens=max_tokens, system=system,
                  messages=[{"role": "user", "content": user}])
    if use_search:
        kwargs["tools"] = WEB_SEARCH_TOOL
    for attempt in (1, 2):
        resp = _client.messages.create(**kwargs)
        text = "".join(b.text for b in resp.content if b.type == "text")
        try:
            return extract_json(text)
        except (ValueError, json.JSONDecodeError):
            if attempt == 2:
                raise
            kwargs["messages"].append({"role": "assistant", "content": text})
            kwargs["messages"].append(
                {"role": "user", "content": "Return ONLY valid JSON. No prose, no fences."})


# ----------------------------------------------------------------------------
# Apollo people search (optional)
# ----------------------------------------------------------------------------
PRIORITY_TITLES = ["country manager", "general manager", "operations director",
                   "operations manager", "supply chain manager", "procurement manager",
                   "founder", "managing director", "head of operations"]


def apollo_people_search(company_name, domain, market):
    import requests
    key = os.environ.get("APOLLO_API_KEY")
    if not key:
        return []
    payload = {"per_page": 5, "person_titles": PRIORITY_TITLES}
    if market:
        payload["person_locations"] = [market]
    if domain:
        payload["q_organization_domains_list"] = [domain]
    else:
        payload["q_keywords"] = company_name
    try:
        r = requests.post("https://api.apollo.io/api/v1/mixed_people/search",
                          headers={"x-api-key": key, "Content-Type": "application/json"},
                          json=payload, timeout=30)
        r.raise_for_status()
        return r.json().get("people", [])
    except requests.RequestException:
        return []


# ----------------------------------------------------------------------------
# Dry-run stubs — prove read/template/write wiring with no API calls
# ----------------------------------------------------------------------------
def stub_candidates(wishlist, n):
    ind = (wishlist.get("industries") or "target industry").split(",")[0].strip()
    mkt = wishlist.get("market") or "the market"
    out = []
    for i in range(1, n + 1):
        out.append({
            "company_name": f"[SAMPLE] {ind.title()} Prospect {i}",
            "website": f"https://prospect-{i}.example.com",
            "industry": ind,
            "country_of_origin": mkt,
            "sg_activity": f"Showing a buying signal in {mkt} relevant to {ind}.",
            "signal_code": "SIG-OTHER",
            "signal_date": date.today().isoformat(),
            "evidence_urls": [f"https://prospect-{i}.example.com/news"],
            "sources_confirmed": 2,
            "notes": "dry-run stub",
        })
    return out


# ----------------------------------------------------------------------------
# Per-org pipeline
# ----------------------------------------------------------------------------
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def build_lead(org, cand, contact, draft, score, breakdown, service, size, next_action):
    dom = norm_domain(cand.get("website", ""))
    status = "High Priority" if score >= HIGH_PRIORITY else "Verified"
    return {
        "id": str(uuid.uuid4()),
        "org_id": org["id"],
        "company_name": cand.get("company_name", ""),
        "website": cand.get("website", ""),
        "industry": cand.get("industry", ""),
        "country_of_origin": cand.get("country_of_origin", ""),
        "sg_activity": cand.get("sg_activity", ""),
        "signal_code": cand.get("signal_code", "SIG-OTHER"),
        "buying_signal": cand.get("sg_activity", ""),
        "signal_date": cand.get("signal_date"),
        "evidence_url": (cand.get("evidence_urls") or [""])[0],
        "evidence_url_2": (cand.get("evidence_urls") or ["", ""])[1] if len(cand.get("evidence_urls", [])) > 1 else "",
        "uld_service": service,
        "uld_service_2": "",
        "opportunity_size": size,
        "dm_name": contact.get("name", ""),
        "dm_title": contact.get("title", ""),
        "dm_email": contact.get("email", ""),
        "dm_phone": contact.get("phone", ""),
        "dm_source": contact.get("source", ""),
        "sources_count": max(1, int(cand.get("sources_confirmed") or 0) or len(cand.get("evidence_urls", [])) or 1),
        "lead_score": score,
        "score_breakdown": breakdown,
        "lead_status": status,
        "next_action": next_action,
        "outreach_subject": draft.get("subject", ""),
        "outreach_body": draft.get("body", ""),
        "requires_recipient": bool(draft.get("requires_recipient")),
        "est_pipeline_sgd": None,
        "date_discovered": date.today().isoformat(),
        "date_last_verified": date.today().isoformat(),
        "signal_hash": signal_hash(org["id"], dom, norm_name(cand.get("company_name", "")), cand.get("signal_code", "")),
        "activity": [],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def run_org(org, dry_run=False):
    wl = dict(org.get("wishlist") or {})
    wl["org_name"] = org["name"]
    cap = max(1, min(50, int(wl.get("leads_per_day") or 10)))

    # Known signal hashes for this org (dedupe across days).
    known = {l.get("signal_hash") for l in store.leads_for(org["id"]) if l.get("signal_hash")}

    today = date.today().isoformat()

    # 1. SCOUT
    if dry_run:
        candidates = stub_candidates(wl, cap + 2)
    else:
        candidates = call_agent(
            fill(PROMPTS["scout"], wl, cap),
            f"Run today's scout. Date: {today}. Exclude previously reported companies.",
            use_search=True, max_tokens=6000)
    candidates = candidates[:cap + 4]

    # 2. DEDUPE before spending tokens
    fresh = []
    for c in candidates:
        h = signal_hash(org["id"], norm_domain(c.get("website", "")),
                        norm_name(c.get("company_name", "")), c.get("signal_code", ""))
        if h not in known:
            c["_hash"] = h
            fresh.append(c)

    # 3. VERIFY
    if dry_run:
        verified = [dict(c, verified=True) for c in fresh]
    else:
        try:
            out = call_agent(fill(PROMPTS["verifier"], wl, cap),
                             f"Verify these candidates as of {today}: {json.dumps(fresh)}",
                             use_search=True, max_tokens=6000)
            verified = [v for v in out if v.get("verified")]
        except Exception as e:  # noqa: BLE001
            print(f"  ! verifier error: {e}")
            verified = []

    # 4. SCORE
    if dry_run:
        retained = [dict(v, score=78, uld_service="Best fit",
                         score_breakdown={"market": 18, "signal": 20, "fit": 20, "volume": 10, "access": 6, "urgency": 4},
                         opportunity_size="Medium",
                         recommended_next_action="Review and approve outreach")
                    for v in verified]
    else:
        try:
            out = call_agent(fill(PROMPTS["analyst"], wl, cap),
                             f"Score these verified leads: {json.dumps(verified)}")
            retained = [l for l in out.get("retained", []) if l.get("score", 0) >= SCORE_FLOOR]
        except Exception as e:  # noqa: BLE001
            print(f"  ! analyst error: {e}")
            retained = []

    # Cap at the org's leads/day
    retained = sorted(retained, key=lambda l: l.get("score", 0), reverse=True)[:cap]

    # 5 & 6. CONTACTS + OUTREACH, then persist
    written = 0
    for lead in retained:
        if dry_run:
            contact = {"name": "Sample Contact", "title": "Operations Director",
                       "email": "contact@example.com", "phone": "+00 000 0000", "source": "apollo"}
            draft = {"subject": f"Re: your recent move — {wl['org_name']}",
                     "body": f"Saw {lead.get('company_name')}'s recent activity. {wl['org_name']} can help. 15-min call?\n\n{{SENDER_NAME}}, {{SENDER_TITLE}}, {wl['org_name']}",
                     "requires_recipient": False}
        else:
            apollo = apollo_people_search(lead["company_name"], norm_domain(lead.get("website", "")), wl.get("market"))
            try:
                contacts = call_agent(fill(PROMPTS["contact_researcher"], wl, cap),
                                      f"Find contacts for: {json.dumps(lead)}\nApollo API results: {json.dumps(apollo)}",
                                      use_search=True)
                contact = (contacts.get("contacts") or [{}])[0]
            except Exception as e:  # noqa: BLE001
                print(f"  ! contacts error ({lead['company_name']}): {e}")
                contact = {}
            try:
                draft = call_agent(fill(PROMPTS["outreach_writer"], wl, cap),
                                   f"Draft outreach for: {json.dumps(dict(lead, _contact=contact))}")
            except Exception as e:  # noqa: BLE001
                print(f"  ! outreach error ({lead['company_name']}): {e}")
                draft = {"subject": "", "body": "", "requires_recipient": True}

        row = build_lead(org, lead, contact, draft,
                         lead.get("score", 0), lead.get("score_breakdown", {}),
                         lead.get("uld_service", "Best fit"),
                         lead.get("opportunity_size", "Unknown"),
                         lead.get("recommended_next_action", ""))
        if row["signal_hash"] in known:
            continue
        store.put("leads", row["id"], row)
        known.add(row["signal_hash"])
        written += 1

    # Run log (per org)
    log_id = str(uuid.uuid4())
    store.put("runlog", log_id, {
        "id": log_id, "org_id": org["id"], "run_date": today,
        "candidates": len(candidates), "verified": len(verified),
        "retained": len(retained), "written": written, "finished_at": now_iso(),
    })
    return {"candidates": len(candidates), "verified": len(verified),
            "retained": len(retained), "written": written}


# ----------------------------------------------------------------------------
# Sweep
# ----------------------------------------------------------------------------
def run(only_org=None, dry_run=False):
    all_orgs = store.orgs()
    ready = [o for o in all_orgs if o.get("setup_complete")]
    if only_org:
        ready = [o for o in ready if o["id"] == only_org]

    print(f"[{date.today().isoformat()}] store={store.backend} "
          f"orgs={len(all_orgs)} ready={len(ready)} dry_run={dry_run}")
    if not ready:
        print("  no ready orgs — tenants must complete wishlist onboarding first")
        return

    grand = 0
    for org in ready:
        tag = "OWNER" if org.get("is_owner") else "tenant"
        print(f"\n-> {org['name']}  ({tag}, {(org.get('wishlist') or {}).get('leads_per_day', '?')} leads/day)")
        res = run_org(org, dry_run=dry_run)
        grand += res["written"]
        print(f"   candidates={res['candidates']} verified={res['verified']} "
              f"retained={res['retained']} written={res['written']}")
    print(f"\nDone. {grand} new leads written across {len(ready)} org(s).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="IdealOne.Hunter multi-tenant lead pipeline")
    ap.add_argument("cmd", nargs="?", default="run", choices=["run"])
    ap.add_argument("--org", help="run one org by id")
    ap.add_argument("--dry-run", action="store_true", help="no API calls; stubbed candidates")
    args = ap.parse_args()
    run(only_org=args.org, dry_run=args.dry_run)
