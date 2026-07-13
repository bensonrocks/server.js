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
  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic();

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
        const c = await callAgent(client, fillPrompt(PROMPTS.contact_researcher, wl, cap),
          `Find contacts for: ${JSON.stringify(lead)}\nApollo API results: []`, true);
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

// Quick health check: verifies the API key works and whether the web-search
// server tool is enabled — one cheap call, no pipeline. Returns a report.
async function testConnection() {
  const out = { model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY, api: false, webSearch: false };
  if (!out.hasKey) { out.error = 'ANTHROPIC_API_KEY is not set on the server.'; return out; }
  const { Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 512, tools: WEB_SEARCH,
      messages: [{ role: 'user', content: 'Search the web for one recent business news headline and reply with just the headline.' }],
    });
    out.api = true; // the request itself succeeded
    let searchErr = null, searched = false;
    for (const b of resp.content) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') searched = true;
      if (b.type === 'web_search_tool_result') {
        const c = b.content;
        if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') searchErr = c.error_code;
        else if (Array.isArray(c) && c.length) { searched = true; out.webSearch = true; }
      }
    }
    if (!out.webSearch) {
      out.error = searchErr
        ? `Web search returned an error (${searchErr}). Enable web search / confirm billing for your Anthropic org.`
        : (searched ? 'Web search ran but returned no results.' : 'The model did not run a web search on this test.');
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
    if (/401|authentication/i.test(out.error)) out.error = 'API key rejected (401). Check ANTHROPIC_API_KEY.';
  }
  return out;
}

// Kick a run without blocking the HTTP response.
function startRun(org) {
  if (status(org.id).state === 'running') return status(org.id);
  runStatus[org.id] = { state: 'running', step: 'Starting…', at: new Date().toISOString(), written: 0 };
  runForOrg(org).catch(e => { runStatus[org.id] = { state: 'error', error: String(e), at: new Date().toISOString() }; });
  return runStatus[org.id];
}

module.exports = { startRun, status, runForOrg, testConnection, MODEL };
