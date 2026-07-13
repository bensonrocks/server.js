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

async function apolloPeopleSearch(companyName, domain, market) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return [];
  const payload = { per_page: 5, person_titles: APOLLO_TITLES };
  if (market) payload.person_locations = [market];
  if (domain) payload.q_organization_domains_list = [domain];
  else payload.q_keywords = companyName;
  try {
    const r = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    // Trim to the fields the Contact Researcher needs (keeps the prompt lean).
    return (data.people || []).map(p => ({
      name: p.name, title: p.title,
      email: p.email && p.email !== 'email_not_unlocked@domain.com' ? p.email : '',
      phone: (p.phone_numbers && p.phone_numbers[0] && p.phone_numbers[0].sanitized_number) || '',
      linkedin_url: p.linkedin_url || '',
      organization: p.organization && p.organization.name,
    }));
  } catch {
    return [];
  }
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

    set('running', { step: 'Scouting the market', written: 0 });
    const candidates = asArray(await callAgent(client, fillPrompt(PROMPTS.scout, wl, cap),
      `Run today's scout. Date: ${new Date().toISOString().slice(0, 10)}. Exclude previously reported companies.`,
      true));
    if (!candidates.length) {
      set('done', { written: 0, candidates: 0, verified: 0, retained: 0,
        note: 'The Scout found no fresh, credible signals this run. Try again later, broaden your wishlist (market/industries/signals), or raise leads/day.' });
      return runStatus[org.id];
    }
    const fresh = candidates.filter(c =>
      !known.has(signalHash(org.id, normDomain(c.website || ''), normName(c.company_name || ''), c.signal_code || '')));

    set('running', { step: 'Verifying candidates', written: 0 });
    let verified = [];
    if (fresh.length) {
      const out = await callAgent(client, fillPrompt(PROMPTS.verifier, wl, cap),
        `Verify these candidates: ${JSON.stringify(fresh)}`, true);
      verified = asArray(out).filter(v => v.verified);
    }

    set('running', { step: 'Scoring opportunities', written: 0 });
    let retained = [];
    if (verified.length) {
      const out = await callAgent(client, fillPrompt(PROMPTS.analyst, wl, cap),
        `Score these verified leads: ${JSON.stringify(verified)}`, false);
      retained = ((out && out.retained) || []).filter(l => (l.score || 0) >= SCORE_FLOOR);
    }
    retained = retained.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, cap);

    let written = 0;
    for (const lead of retained) {
      set('running', { step: `Researching & drafting (${lead.company_name})`, written });
      let contact = {};
      try {
        const apollo = await apolloPeopleSearch(lead.company_name, normDomain(lead.website || ''), wl.market);
        const c = await callAgent(client, fillPrompt(PROMPTS.contact_researcher, wl, cap),
          `Find contacts for: ${JSON.stringify(lead)}\nApollo API results: ${JSON.stringify(apollo)}`, true);
        contact = (c && c.contacts && c.contacts[0]) || {};
      } catch { /* leave contact empty */ }
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

// Health check — runs in the BACKGROUND (a web search can take 30-90s, which
// would time out a synchronous HTTP request behind Railway's proxy). The UI
// polls testStatus. Two phases: a fast no-search API ping, then a web search.
const testState = { state: 'idle' };
function testStatus() { return testState; }

async function runTest() {
  const out = { state: 'running', model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY,
                api: false, webSearch: false, apollo: !!process.env.APOLLO_API_KEY };
  Object.assign(testState, out);
  if (!out.hasKey) { Object.assign(testState, { state: 'done', error: 'ANTHROPIC_API_KEY is not set on the server.' }); return; }
  const client = getClient();
  try {
    // Phase 1: fast ping, no web search — confirms the key + API quickly.
    testState.step = 'Checking API key…';
    await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
    testState.api = true;

    // Phase 2: web search (the slow part).
    testState.step = 'Testing web search…';
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 512, tools: WEB_SEARCH,
      messages: [{ role: 'user', content: 'Search the web for one recent business news headline and reply with just the headline.' }],
    });
    let searchErr = null, searched = false;
    for (const b of resp.content) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') searched = true;
      if (b.type === 'web_search_tool_result') {
        const c = b.content;
        if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') searchErr = c.error_code;
        else if (Array.isArray(c) && c.length) { searched = true; testState.webSearch = true; }
      }
    }
    if (!testState.webSearch) {
      testState.error = searchErr
        ? `Web search returned an error (${searchErr}). Enable web search / confirm billing for your Anthropic org.`
        : (searched ? 'Web search ran but returned no results.' : 'The model did not run a web search on this test.');
    }
  } catch (e) {
    let msg = String((e && e.message) || e);
    if (/401|authentication/i.test(msg)) msg = 'API key rejected (401). Check ANTHROPIC_API_KEY.';
    else if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(msg)) msg = 'The API call timed out. The model/web-search may be slow right now — try again in a moment.';
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
