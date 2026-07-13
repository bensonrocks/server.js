'use strict';

// IdealOne.Hunter — in-app lead pipeline (Node port of idealone-hunter/lead_agent.py).
// Runs Scout -> Verifier -> Analyst -> Contact Researcher -> Outreach Writer for one
// org, driven by that org's wishlist, using the Anthropic API with web search, and
// writes org-scoped leads via lib/hunter/store. Triggered from the CRM (Master only).
//
// Requires ANTHROPIC_API_KEY in the environment. Never sends email — writes drafts only.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const hunter = require('./store');

const MODEL = process.env.HUNTER_MODEL || 'claude-opus-4-8';
const SCORE_FLOOR = 65;
const HIGH_PRIORITY = 80;
const WEB_SEARCH = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];

// Per-call timeout + limited retries so a slow/hung web-search call fails fast
// with a clear error instead of blocking. (SDK default is 10 min × 2 retries.)
const CALL_TIMEOUT_MS = 150000;
function getClient() {
  const { Anthropic } = require('@anthropic-ai/sdk');
  return new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: 1 });
}

const PROMPTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../idealone-hunter/prompts.json'), 'utf8'));

// In-memory run status per org (surfaced to the Settings UI).
const runStatus = {};
function status(orgId) {
  return runStatus[orgId] || { state: 'idle' };
}

function fillPrompt(tpl, wl, maxCandidates) {
  return tpl
    .replaceAll('{ORG_NAME}', wl.org_name)
    .replaceAll('{MARKET}', wl.market || 'their market')
    .replaceAll('{INDUSTRIES}', wl.industries || 'any relevant industry')
    .replaceAll('{SIGNALS}', wl.signals || 'any credible buying signal')
    .replaceAll('{SERVICES}', wl.services || 'their product/service')
    .replaceAll('{NOTES}', wl.notes || 'none')
    .replaceAll('{MAX_CANDIDATES}', String(maxCandidates));
}

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const m = cleaned.match(/[[{]/);
  if (!m) throw new Error('no JSON found in model output');
  // Trim trailing prose after the JSON value by scanning bracket depth.
  const start = m.index;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return JSON.parse(cleaned.slice(start, end === -1 ? undefined : end));
}

async function callAgent(client, system, user, useSearch, maxTokens = 6000) {
  const params = {
    model: MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: user }],
  };
  if (useSearch) params.tools = WEB_SEARCH;

  // Surface a failing web-search server tool instead of silently returning nothing.
  function checkSearchErrors(content) {
    for (const b of content) {
      if (b.type === 'web_search_tool_result') {
        const c = b.content;
        if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') {
          throw new Error(`Web search failed (${c.error_code}). Enable the web search tool for your Anthropic org (Console → billing/tools).`);
        }
      }
    }
  }

  // One retry with a "JSON only" nudge on parse failure.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp = await client.messages.create(params);
    // Server-side tools may pause; resume until the turn ends.
    let guard = 0;
    while (resp.stop_reason === 'pause_turn' && guard++ < 6) {
      checkSearchErrors(resp.content);
      params.messages.push({ role: 'assistant', content: resp.content });
      resp = await client.messages.create(params);
    }
    checkSearchErrors(resp.content);
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try {
      return extractJson(text);
    } catch (e) {
      if (attempt === 2) throw e;
      params.messages.push({ role: 'assistant', content: text });
      params.messages.push({ role: 'user', content: 'Return ONLY valid JSON. No prose, no fences.' });
    }
  }
}

// Apollo.io people search (optional). Returns raw people for the Contact
// Researcher agent to draw on; degrades to [] without a key or on any error.
const APOLLO_TITLES = ['country manager', 'general manager', 'operations director',
  'operations manager', 'supply chain manager', 'procurement manager',
  'founder', 'managing director', 'head of operations'];

async function apolloRaw(pathname, payload) {
  const r = await fetch(`https://api.apollo.io/api/v1/${pathname}`, {
    method: 'POST',
    headers: { 'x-api-key': process.env.APOLLO_API_KEY, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  let text = '';
  try { text = await r.text(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, text };
}

async function apolloPost(pathname, payload) {
  if (!process.env.APOLLO_API_KEY) return null;
  let res = await apolloRaw(pathname, payload);
  // Apollo deprecated the `.../search` endpoints in favour of `.../api_search`.
  // If we hit that, transparently retry the new path.
  if (!res.ok && res.status === 422 && /deprecated/i.test(res.text) && /api_search/i.test(res.text) && /\/search$/.test(pathname)) {
    res = await apolloRaw(pathname.replace(/\/search$/, '/api_search'), payload);
  }
  if (!res.ok) {
    throw new Error(`Apollo ${pathname} -> ${res.status}${res.status === 401 ? ' (check APOLLO_API_KEY)' : ''}${res.text ? ` — ${res.text.slice(0, 200)}` : ''}`);
  }
  return res.text ? JSON.parse(res.text) : {};
}

function apolloContact(p) {
  return {
    name: p.name || '', title: p.title || '',
    email: p.email && p.email !== 'email_not_unlocked@domain.com' ? p.email : '',
    phone: (p.phone_numbers && p.phone_numbers[0] && p.phone_numbers[0].sanitized_number) || '',
    profile_url: p.linkedin_url || '', source: 'apollo',
  };
}

async function apolloPeopleSearch(companyName, domain, market) {
  if (!process.env.APOLLO_API_KEY) return [];
  const payload = { per_page: 5, person_titles: APOLLO_TITLES };
  if (market) payload.person_locations = [market];
  if (domain) payload.q_organization_domains_list = [domain];
  else payload.q_keywords = companyName;
  try {
    const data = await apolloPost('mixed_people/search', payload);
    return ((data && data.people) || []).map(p => ({
      ...apolloContact(p), linkedin_url: p.linkedin_url || '',
      organization: p.organization && p.organization.name,
    }));
  } catch {
    return [];
  }
}

// Apollo-only discovery via Organization Search: finds companies matching the
// org's wishlist (market + industry keywords) and returns them as pipeline
// candidates with real domain + industry — no web search needed. Returns full
// company data in one request (does not enrich individual contacts).
async function apolloDiscover(wl, cap) {
  if (!process.env.APOLLO_API_KEY) return { candidates: [], error: 'APOLLO_API_KEY is not set on the server.' };
  const market = wl.market || '';
  const payload = { per_page: Math.min(100, Math.max(25, cap * 3)), page: 1 };
  if (market) payload.organization_locations = market.split(/[,\/&]|(?:\band\b)/i).map(s => s.trim()).filter(Boolean);
  const tags = (wl.industries || '').split(/[,\n;]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  if (tags.length) payload.q_organization_keyword_tags = tags;

  let orgs;
  try {
    const data = await apolloPost('mixed_companies/search', payload);
    orgs = (data && (data.organizations || data.accounts)) || [];
  } catch (e) {
    return { candidates: [], error: String((e && e.message) || e) };
  }

  const byCo = new Map();
  const today = new Date().toISOString().slice(0, 10);
  for (const org of orgs) {
    const name = org.name || '';
    if (!name) continue;
    const domain = normDomain(org.primary_domain || org.website_url || '');
    const key = domain || normName(name);
    if (byCo.has(key)) continue;
    const hq = [org.city, org.state, org.country].filter(Boolean).join(', ');
    const size = org.estimated_num_employees ? `~${org.estimated_num_employees} staff` : '';
    byCo.set(key, {
      company_name: name,
      website: org.website_url || (domain ? 'https://' + domain : ''),
      industry: org.industry || tags[0] || '',
      country_of_origin: hq || market,
      sg_activity: `${org.industry ? org.industry.charAt(0).toUpperCase() + org.industry.slice(1) + ' company' : 'Company'} in ${hq || market || 'your market'}${size ? `, ${size}` : ''} — matches your target profile.`,
      signal_code: 'SIG-ICP',
      signal_date: today,
      evidence_urls: [org.website_url || (domain ? 'https://' + domain : '') || org.linkedin_url || ''].filter(Boolean),
      sources_confirmed: 1,
      estimated_num_employees: parseInt(org.estimated_num_employees, 10) || 0,
      apollo_org_id: org.id || '',
    });
  }
  return { candidates: Array.from(byCo.values()).slice(0, cap * 2) };
}

// Which discovery source to use: HUNTER_DISCOVERY=apollo|web, else auto
// (prefer Apollo when an APOLLO_API_KEY is present, since it needs no web search).
function discoveryMode() {
  const m = (process.env.HUNTER_DISCOVERY || 'auto').toLowerCase();
  if (m === 'apollo' || m === 'web') return m;
  return process.env.APOLLO_API_KEY ? 'apollo' : 'web';
}

// Scout/Verifier should return an array; unwrap a wrapping object if the model added one.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const key of ['candidates', 'leads', 'results', 'companies', 'items']) {
      if (Array.isArray(v[key])) return v[key];
    }
    const firstArray = Object.values(v).find(Array.isArray);
    if (firstArray) return firstArray;
  }
  return [];
}

const SUFFIXES = /\b(pte\.?\s*ltd\.?|ltd\.?|llc|inc\.?|gmbh|co\.?|limited|corporation|corp\.?|llp|sdn\.?\s*bhd\.?)\b/gi;
const normName = n => (n || '').toLowerCase().replace(SUFFIXES, '').replace(/[^a-z0-9]+/g, ' ').trim();
function normDomain(url) {
  if (!url) return '';
  const d = url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  return d.startsWith('www.') ? d.slice(4) : d;
}
function signalHash(orgId, domain, nameNorm, code) {
  return crypto.createHash('sha256').update(`${orgId}:${domain || nameNorm}:${code || ''}`).digest('hex');
}

// Apollo Organization Search returns ICP-matched companies (right industry +
// location) but NO buying-signal/intent data. The intent-graded Analyst prompt
// would score every one of them below the floor and drop the whole batch, so
// score Apollo candidates deterministically on ICP fit instead. Solid matches
// clear SCORE_FLOOR; thin ones (no industry/domain/size) fall below it.
function apolloScore(cand, wl) {
  const market = (wl.market || '').toLowerCase();
  const hq = (cand.country_of_origin || '').toLowerCase();
  const hqMatch = !!(market && hq &&
    market.split(/[,/&]|\band\b/).some(m => (m = m.trim()) && hq.includes(m)));
  const staff = parseInt(cand.estimated_num_employees, 10) || 0;
  const sizeTier = staff >= 1000 ? 16 : staff >= 200 ? 12 : staff >= 50 ? 9 : staff > 0 ? 6 : 5;
  const breakdown = {
    market: 26 + (hqMatch ? 4 : 0),   // Apollo already filtered on location
    signal: 0,                        // org-search carries no intent signal
    fit: cand.industry ? 28 : 20,     // ICP industry / keyword-tag match
    volume: sizeTier,                 // headcount as an opportunity-size proxy
    access: cand.website ? 8 : 4,     // a real domain means it's reachable
    urgency: 0,
  };
  const score = Math.min(90,
    breakdown.market + breakdown.signal + breakdown.fit + breakdown.volume + breakdown.access);
  return { score, breakdown };
}

function apolloSize(cand) {
  const staff = parseInt(cand.estimated_num_employees, 10) || 0;
  return staff >= 1000 ? 'Large' : staff >= 200 ? 'Medium' : staff > 0 ? 'Small' : 'Unknown';
}

function buildLead(org, cand, contact, draft, score, breakdown, service, size, nextAction) {
  const dom = normDomain(cand.website || '');
  const evidenceUrls = cand.evidence_urls || [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  return {
    id: crypto.randomUUID(),
    org_id: org.id,
    company_name: cand.company_name || '',
    website: cand.website || '',
    industry: cand.industry || '',
    country_of_origin: cand.country_of_origin || '',
    sg_activity: cand.sg_activity || '',
    signal_code: cand.signal_code || 'SIG-OTHER',
    buying_signal: cand.sg_activity || '',
    signal_date: cand.signal_date || null,
    evidence_url: evidenceUrls[0] || '',
    evidence_url_2: evidenceUrls[1] || '',
    uld_service: service || 'Best fit',
    uld_service_2: '',
    opportunity_size: size || 'Unknown',
    dm_name: contact.name || '',
    dm_title: contact.title || '',
    dm_email: contact.email || '',
    dm_phone: contact.phone || '',
    dm_source: contact.source || '',
    sources_count: Math.max(1, parseInt(cand.sources_confirmed, 10) || evidenceUrls.length || 1),
    lead_score: score,
    score_breakdown: breakdown || {},
    lead_status: score >= HIGH_PRIORITY ? 'High Priority' : 'Verified',
    next_action: nextAction || '',
    outreach_subject: draft.subject || '',
    outreach_body: draft.body || '',
    requires_recipient: !!draft.requires_recipient,
    est_pipeline_sgd: null,
    date_discovered: today,
    date_last_verified: today,
    signal_hash: signalHash(org.id, dom, normName(cand.company_name || ''), cand.signal_code || ''),
    activity: [],
    created_at: now,
    updated_at: now,
  };
}

// Run the full pipeline for one org. Updates runStatus[org.id] as it progresses.
async function runForOrg(org) {
  if (!process.env.ANTHROPIC_API_KEY) {
    runStatus[org.id] = { state: 'error', error: 'ANTHROPIC_API_KEY is not set on the server', at: new Date().toISOString() };
    return runStatus[org.id];
  }
  const client = getClient();

  const wl = { ...(org.wishlist || {}), org_name: org.name };
  const cap = Math.max(1, Math.min(50, parseInt(wl.leads_per_day, 10) || 10));
  const set = (state, extra) => { runStatus[org.id] = { state, at: new Date().toISOString(), ...extra }; };

  try {
    const known = new Set(
      (await hunter.all(org.id, { owner: true })).map(l => l.signal_hash).filter(Boolean));

    const mode = discoveryMode();

    // ── DISCOVERY ─────────────────────────────────────────────────────
    let candidates;
    if (mode === 'apollo') {
      set('running', { step: 'Finding companies in Apollo', written: 0 });
      const res = await apolloDiscover(wl, cap);
      candidates = res.candidates;
      if (!candidates.length) {
        set('done', { written: 0, candidates: 0, verified: 0, retained: 0,
          note: res.error
            ? `No leads — Apollo discovery failed: ${res.error}`
            : `Apollo found no companies matching your wishlist in ${wl.market || 'your market'}. Broaden the market/industries in Settings, then run again.` });
        return runStatus[org.id];
      }
    } else {
      set('running', { step: 'Scouting the market', written: 0 });
      candidates = asArray(await callAgent(client, fillPrompt(PROMPTS.scout, wl, cap),
        `Run today's scout. Date: ${new Date().toISOString().slice(0, 10)}. Exclude previously reported companies.`,
        true));
      if (!candidates.length) {
        set('running', { step: 'No leads — checking why…', written: 0 });
        const probe = await probeWebSearch(client);
        const note = probe.ok
          ? 'Web search is working, but the Scout found no fresh, credible signals matching your wishlist right now. Broaden your market/industries/signals, raise leads/day, or try again later.'
          : `No leads because web search is not working: ${probe.error} Enable web search for your Anthropic org, or set HUNTER_DISCOVERY=apollo to discover via Apollo instead.`;
        set('done', { written: 0, candidates: 0, verified: 0, retained: 0, webSearchOk: probe.ok, note });
        return runStatus[org.id];
      }
    }

    const fresh = candidates.filter(c =>
      !known.has(signalHash(org.id, normDomain(c.website || ''), normName(c.company_name || ''), c.signal_code || '')));

    // ── VERIFY ────────────────────────────────────────────────────────
    // Apollo data is already structured/trusted — skip the web verifier.
    let verified = fresh;
    if (mode !== 'apollo') {
      set('running', { step: 'Verifying candidates', written: 0 });
      verified = [];
      if (fresh.length) {
        const out = await callAgent(client, fillPrompt(PROMPTS.verifier, wl, cap),
          `Verify these candidates: ${JSON.stringify(fresh)}`, true);
        verified = asArray(out).filter(v => v.verified);
      }
    }

    set('running', { step: 'Scoring opportunities', written: 0 });
    let retained = [];
    if (verified.length) {
      if (mode === 'apollo') {
        // ICP-fit scoring — Apollo already matched market + industry; no intent
        // signal exists to grade, so scoring here keeps every solid match.
        retained = verified.map(c => {
          const { score, breakdown } = apolloScore(c, wl);
          return { ...c, score, score_breakdown: breakdown, uld_service: 'ICP match',
                   opportunity_size: apolloSize(c),
                   recommended_next_action: 'Review the fit and identify a decision-maker to approach.' };
        }).filter(l => l.score >= SCORE_FLOOR);
      } else {
        const out = await callAgent(client, fillPrompt(PROMPTS.analyst, wl, cap),
          `Score these verified leads: ${JSON.stringify(verified)}`, false);
        retained = ((out && out.retained) || []).filter(l => (l.score || 0) >= SCORE_FLOOR);
      }
    }
    retained = retained.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, cap);

    // Re-attach each candidate's website/evidence (the analyst may drop them).
    if (mode === 'apollo') {
      const byName = new Map(candidates.map(c => [normName(c.company_name), c]));
      for (const l of retained) {
        const src = byName.get(normName(l.company_name));
        if (src) {
          if (!l.website) l.website = src.website;
          if (!l.evidence_urls) l.evidence_urls = src.evidence_urls;
        }
      }
    }

    let written = 0;
    for (const lead of retained) {
      set('running', { step: `Drafting outreach (${lead.company_name})`, written });
      // Apollo (org-search) mode has the company but no individual contact —
      // draft to the operations team (requires_recipient). Web mode researches.
      let contact = {};
      if (mode !== 'apollo') {
        try {
          const apollo = await apolloPeopleSearch(lead.company_name, normDomain(lead.website || ''), wl.market);
          const c = await callAgent(client, fillPrompt(PROMPTS.contact_researcher, wl, cap),
            `Find contacts for: ${JSON.stringify(lead)}\nApollo API results: ${JSON.stringify(apollo)}`, true);
          contact = (c && c.contacts && c.contacts[0]) || {};
        } catch { /* leave contact empty */ }
      }
      let draft = { subject: '', body: '', requires_recipient: true };
      try {
        draft = await callAgent(client, fillPrompt(PROMPTS.outreach_writer, wl, cap),
          `Draft outreach for: ${JSON.stringify({ ...lead, _contact: contact })}`, false) || draft;
      } catch { /* leave draft empty */ }

      const row = buildLead(org, lead, contact, draft, lead.score || 0, lead.score_breakdown || {},
        lead.uld_service || 'Best fit', lead.opportunity_size || 'Unknown', lead.recommended_next_action || '');
      if (known.has(row.signal_hash)) continue;
      await writeLead(row);
      known.add(row.signal_hash);
      written++;
    }

    set('done', { written, candidates: candidates.length, verified: verified.length, retained: retained.length });
    return runStatus[org.id];
  } catch (e) {
    set('error', { error: String(e && e.message || e) });
    return runStatus[org.id];
  }
}

// store.js doesn't expose a raw insert, so persist through the shared db layer.
const db = require('./db');
async function writeLead(row) {
  await db.put('leads', row.id, row);
}

// Probe whether the web-search server tool actually works for this org.
// Returns { ok, error }. Used by the connection test and by 0-lead runs.
async function probeWebSearch(client) {
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 400, tools: WEB_SEARCH,
      messages: [{ role: 'user', content: 'Search the web for one recent business news headline and reply with just the headline.' }],
    });
    let searchErr = null, gotResults = false;
    for (const b of resp.content) {
      if (b.type === 'web_search_tool_result') {
        const c = b.content;
        if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') searchErr = c.error_code;
        else if (Array.isArray(c) && c.length) gotResults = true;
      }
    }
    if (gotResults) return { ok: true };
    if (searchErr) return { ok: false, error: `Web search returned an error (${searchErr}). Enable web search / confirm billing for your Anthropic org.` };
    return { ok: false, error: 'Web search ran but returned no results.' };
  } catch (e) {
    let msg = String((e && e.message) || e);
    if (/401|authentication/i.test(msg)) msg = 'API key rejected (401). Check ANTHROPIC_API_KEY.';
    return { ok: false, error: msg };
  }
}

// Health check — runs in the BACKGROUND (a web search can take 30-90s, which
// would time out a synchronous HTTP request behind Railway's proxy). The UI
// polls testStatus. Two phases: a fast no-search API ping, then a web search.
const testState = { state: 'idle' };
function testStatus() { return testState; }

async function apolloProbe() {
  if (!process.env.APOLLO_API_KEY) return { ok: false, error: 'APOLLO_API_KEY is not set on the server.' };
  try {
    const data = await apolloPost('mixed_people/search', { per_page: 1, person_titles: ['operations manager'] });
    return { ok: !!(data && Array.isArray(data.people)) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function runTest() {
  const mode = discoveryMode();
  const out = { state: 'running', model: MODEL, discovery: mode, hasKey: !!process.env.ANTHROPIC_API_KEY,
                api: false, webSearch: false, apollo: !!process.env.APOLLO_API_KEY, apolloOk: false };
  Object.assign(testState, out);
  if (!out.hasKey) { Object.assign(testState, { state: 'done', error: 'ANTHROPIC_API_KEY is not set on the server.' }); return; }
  const client = getClient();
  try {
    // Phase 1: fast ping, no web search — confirms the key + API quickly.
    testState.step = 'Checking API key…';
    await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
    testState.api = true;

    // Phase 2: check whichever discovery source this deployment uses.
    if (mode === 'apollo') {
      testState.step = 'Testing Apollo…';
      const ap = await apolloProbe();
      testState.apolloOk = ap.ok;
      if (!ap.ok) testState.error = `Apollo error: ${ap.error}`;
    } else {
      testState.step = 'Testing web search…';
      const probe = await probeWebSearch(client);
      testState.webSearch = probe.ok;
      if (!probe.ok) testState.error = probe.error;
    }
  } catch (e) {
    let msg = String((e && e.message) || e);
    if (/401|authentication/i.test(msg)) msg = 'API key rejected (401). Check ANTHROPIC_API_KEY.';
    else if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg)) msg = 'The API call timed out — try again in a moment.';
    testState.error = msg;
  }
  testState.state = 'done';
  delete testState.step;
}

function startTest() {
  if (testState.state === 'running') return testState;
  Object.keys(testState).forEach(k => delete testState[k]);
  testState.state = 'running';
  runTest().catch(e => { testState.state = 'done'; testState.error = String(e); });
  return testState;
}

// Kick a run without blocking the HTTP response.
function startRun(org) {
  if (status(org.id).state === 'running') return status(org.id);
  runStatus[org.id] = { state: 'running', step: 'Starting…', at: new Date().toISOString(), written: 0 };
  runForOrg(org).catch(e => { runStatus[org.id] = { state: 'error', error: String(e), at: new Date().toISOString() }; });
  return runStatus[org.id];
}

module.exports = { startRun, status, runForOrg, startTest, testStatus, MODEL };
