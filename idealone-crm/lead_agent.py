"""
IdealOne.CRM — ULD Sales Lead Research Agent (reference implementation)
===================================================================
Multi-agent pipeline: Scout -> Verifier -> Analyst -> Contact Researcher
-> Outreach Writer -> SQLite -> (human approval queue in IdealOne.CRM UI).

Runs standalone:  python lead_agent.py run
Schedule:         cron  0 8 * * 1-5  (Asia/Singapore)

Env vars required:
  ANTHROPIC_API_KEY   Anthropic API key
  APOLLO_API_KEY      Apollo.io API key (optional; contact step degrades gracefully)

Dependencies:  pip install anthropic requests
Docs: https://docs.claude.com/en/api/overview
NOTE: emails are NEVER sent by this script. It only writes drafts to the DB.
"""

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime

import requests
from anthropic import Anthropic

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
DB_PATH = os.environ.get("LEAD_DB", "uld_leads.db")
MODEL = "claude-sonnet-4-6"
MAX_CANDIDATES = 12
SCORE_FLOOR = 65
HIGH_PRIORITY = 80

client = Anthropic()  # reads ANTHROPIC_API_KEY
WEB_SEARCH_TOOL = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]

PROMPTS_FILE = os.path.join(os.path.dirname(__file__), "prompts.json")
# prompts.json holds the five system prompts from the spec, keys:
# scout, verifier, analyst, contact_researcher, outreach_writer
with open(PROMPTS_FILE) as f:
    PROMPTS = json.load(f)

# ----------------------------------------------------------------------------
# DB
# ----------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    company_name_norm TEXT NOT NULL,
    website TEXT, domain_norm TEXT,
    industry TEXT, country_of_origin TEXT,
    sg_activity TEXT, signal_code TEXT NOT NULL, buying_signal TEXT,
    signal_date DATE, evidence_url TEXT NOT NULL, evidence_url_2 TEXT,
    uld_service TEXT, uld_service_2 TEXT,
    opportunity_size TEXT,
    dm_name TEXT, dm_title TEXT, dm_email TEXT, dm_profile_url TEXT, dm_source TEXT,
    lead_score INTEGER, score_breakdown TEXT,
    lead_status TEXT NOT NULL DEFAULT 'New',
    next_action TEXT,
    outreach_subject TEXT, outreach_body TEXT, requires_recipient INTEGER DEFAULT 0,
    est_pipeline_sgd INTEGER,
    date_discovered DATE NOT NULL, date_last_verified DATE,
    signal_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_leads_dedupe ON leads (signal_hash);
CREATE TABLE IF NOT EXISTS run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date DATE, candidates INTEGER, verified INTEGER,
    retained INTEGER, duplicates INTEGER, errors TEXT,
    finished_at TIMESTAMP
);
"""

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.row_factory = sqlite3.Row
    return conn

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
SUFFIXES = r"\b(pte\.?\s*ltd\.?|ltd\.?|llc|inc\.?|gmbh|co\.?|limited|corporation|corp\.?|llp)\b"

def norm_name(name: str) -> str:
    n = re.sub(SUFFIXES, "", (name or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", n).strip()

def norm_domain(url: str) -> str:
    if not url:
        return ""
    d = re.sub(r"^https?://", "", url.lower()).split("/")[0]
    return d[4:] if d.startswith("www.") else d

def signal_hash(domain: str, name_norm: str, signal_code: str) -> str:
    key = (domain or name_norm) + ":" + (signal_code or "")
    return hashlib.sha256(key.encode()).hexdigest()

def extract_json(text: str):
    """Claude may wrap JSON in fences or prose; pull the first JSON value."""
    text = re.sub(r"```(?:json)?", "", text).strip("` \n")
    m = re.search(r"[\[{]", text)
    if not m:
        raise ValueError("no JSON found")
    return json.loads(text[m.start():])

def call_agent(system: str, user: str, use_search: bool = False, max_tokens: int = 4000):
    """One subagent call. Retries once on JSON failure."""
    kwargs = dict(model=MODEL, max_tokens=max_tokens, system=system,
                  messages=[{"role": "user", "content": user}])
    if use_search:
        kwargs["tools"] = WEB_SEARCH_TOOL
    for attempt in (1, 2):
        resp = client.messages.create(**kwargs)
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
# Apollo (free people search only; enrichment is triggered manually in the UI)
# ----------------------------------------------------------------------------
PRIORITY_TITLES = ["country manager", "general manager", "operations director",
                   "operations manager", "supply chain manager", "logistics manager",
                   "procurement manager", "founder", "managing director",
                   "retail operations manager", "head of operations"]

def apollo_people_search(company_name: str, domain: str):
    key = os.environ.get("APOLLO_API_KEY")
    if not key:
        return []
    payload = {"per_page": 5, "person_titles": PRIORITY_TITLES,
               "person_locations": ["Singapore"]}
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
        return []  # degrade gracefully; Contact Researcher falls back to web

# ----------------------------------------------------------------------------
# Pipeline
# ----------------------------------------------------------------------------
def run():
    conn = db()
    today = date.today().isoformat()
    errors, dup_count = [], 0

    known = [r["domain_norm"] or r["company_name_norm"] for r in conn.execute(
        "SELECT domain_norm, company_name_norm FROM leads "
        "WHERE date_discovered >= date('now','-90 day')")]

    # 1. SCOUT ---------------------------------------------------------------
    candidates = call_agent(
        PROMPTS["scout"],
        f"Run today's scout. Date: {today}. "
        f"Exclude these previously reported companies/domains: {json.dumps(known)}",
        use_search=True, max_tokens=6000)
    candidates = candidates[:MAX_CANDIDATES]

    # 2. DEDUPE before spending verifier tokens --------------------------------
    fresh = []
    for c in candidates:
        h = signal_hash(norm_domain(c.get("website", "")),
                        norm_name(c.get("company_name", "")), c.get("signal_code", ""))
        if conn.execute("SELECT 1 FROM leads WHERE signal_hash=?", (h,)).fetchone():
            dup_count += 1
        else:
            c["_hash"] = h
            fresh.append(c)

    # 3. VERIFY ----------------------------------------------------------------
    verified = []
    if fresh:
        try:
            out = call_agent(PROMPTS["verifier"],
                             f"Verify these candidates as of {today}: {json.dumps(fresh)}",
                             use_search=True, max_tokens=6000)
            verified = [v for v in out if v.get("verified")]
        except Exception as e:  # noqa: BLE001
            errors.append(f"verifier: {e}")

    # 4. SCORE -------------------------------------------------------------
    retained = []
    if verified:
        try:
            out = call_agent(PROMPTS["analyst"],
                             f"Score these verified leads: {json.dumps(verified)}")
            retained = [l for l in out.get("retained", [])
                        if l.get("score", 0) >= SCORE_FLOOR]
        except Exception as e:  # noqa: BLE001
            errors.append(f"analyst: {e}")

    # 5 & 6. CONTACTS + OUTREACH, then persist -------------------------------
    for lead in retained:
        dom = norm_domain(lead.get("website", ""))
        apollo = apollo_people_search(lead["company_name"], dom)
        try:
            contacts = call_agent(
                PROMPTS["contact_researcher"],
                f"Find contacts for: {json.dumps(lead)}\n"
                f"Apollo API results: {json.dumps(apollo)}",
                use_search=True)
        except Exception as e:  # noqa: BLE001
            errors.append(f"contacts {lead['company_name']}: {e}")
            contacts = {"contacts": [], "contact_status": "not_found"}

        best = (contacts.get("contacts") or [{}])[0]
        lead["_contact"] = best

        try:
            draft = call_agent(PROMPTS["outreach_writer"],
                               f"Draft outreach for: {json.dumps(lead)}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"outreach {lead['company_name']}: {e}")
            draft = {"subject": "", "body": "", "requires_recipient": True}

        status = "High Priority" if lead["score"] >= HIGH_PRIORITY else "Verified"
        h = lead.get("_hash") or signal_hash(dom, norm_name(lead["company_name"]),
                                             lead.get("signal_code", ""))
        try:
            conn.execute("""
                INSERT INTO leads (company_name, company_name_norm, website, domain_norm,
                    industry, country_of_origin, sg_activity, signal_code, buying_signal,
                    signal_date, evidence_url, evidence_url_2, uld_service, uld_service_2,
                    opportunity_size, dm_name, dm_title, dm_email, dm_profile_url, dm_source,
                    lead_score, score_breakdown, lead_status, next_action,
                    outreach_subject, outreach_body, requires_recipient,
                    date_discovered, date_last_verified, signal_hash)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                lead["company_name"], norm_name(lead["company_name"]),
                lead.get("website", ""), dom,
                lead.get("industry", ""), lead.get("country_of_origin", ""),
                lead.get("sg_activity", ""), lead.get("signal_code", ""),
                lead.get("sg_activity", ""), lead.get("signal_date"),
                (lead.get("evidence_urls") or [""])[0],
                (lead.get("evidence_urls") or ["", ""])[1] if len(lead.get("evidence_urls", [])) > 1 else "",
                lead.get("uld_service", ""), lead.get("uld_service_secondary", ""),
                lead.get("opportunity_size", "Unknown"),
                best.get("name", ""), best.get("title", ""), best.get("email", ""),
                best.get("profile_url", ""), best.get("source", ""),
                lead["score"], json.dumps(lead.get("score_breakdown", {})),
                status, lead.get("recommended_next_action", ""),
                draft.get("subject", ""), draft.get("body", ""),
                1 if draft.get("requires_recipient") else 0,
                today, today, h))
        except sqlite3.IntegrityError:
            dup_count += 1

    conn.execute("INSERT INTO run_log (run_date, candidates, verified, retained, "
                 "duplicates, errors, finished_at) VALUES (?,?,?,?,?,?,?)",
                 (today, len(candidates), len(verified), len(retained),
                  dup_count, "; ".join(errors), datetime.now().isoformat()))
    conn.commit()

    print(f"[{today}] candidates={len(candidates)} verified={len(verified)} "
          f"retained={len(retained)} dupes={dup_count} errors={len(errors)}")
    for r in conn.execute("SELECT company_name, lead_score, lead_status, uld_service "
                          "FROM leads WHERE date_discovered=? "
                          "ORDER BY lead_score DESC", (today,)):
        print(f"  {r['lead_score']:>3}  {r['lead_status']:<13} "
              f"{r['uld_service']:<6} {r['company_name']}")

# ----------------------------------------------------------------------------
# Approval actions (called by the IdealOne.CRM UI — humans only)
# ----------------------------------------------------------------------------
HUMAN_ONLY = {"Contact Approved", "Contacted", "Replied", "Qualified",
              "Quotation", "Won", "Lost"}

def set_status(lead_id: int, status: str):
    """UI hook. The pipeline never calls this for HUMAN_ONLY statuses."""
    conn = db()
    conn.execute("UPDATE leads SET lead_status=?, updated_at=CURRENT_TIMESTAMP "
                 "WHERE id=?", (status, lead_id))
    conn.commit()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        run()
    else:
        print("usage: python lead_agent.py run")
