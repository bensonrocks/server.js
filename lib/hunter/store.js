'use strict';

const crypto = require('crypto');
const db     = require('./db');

// Org-scoped lead store for the Hunter CRM (PostgreSQL or JSON file via
// lib/hunter/db.js). The Python pipeline (idealone-hunter/lead_agent.py)
// will write here per-org; until then new orgs get labelled sample leads.
const COL = 'leads';

const STATUSES = ['New', 'Verified', 'High Priority', 'Contact Approved',
                  'Contacted', 'Replied', 'Qualified', 'Quotation',
                  'Won', 'Lost', 'Monitor'];

// Statuses that live in the Contacted tab (post-approval maintenance).
const CONTACTED_SET = ['Contacted', 'Replied', 'Qualified', 'Quotation', 'Won', 'Lost'];

// Activity entry types on a lead's timeline.
const ACTIVITY_TYPES = ['comment', 'email_sent', 'response', 'followup', 'status'];

// A Contacted lead untouched for this many calendar days is due a follow-up.
const FOLLOWUP_DAYS = 3;

const SEED = require('./seed.json');

// How many independent sources back this lead (evidence + contact source).
// Shown to tenants as the green "verified" count — the sources themselves
// are proprietary and never exposed.
function sourcesCount(lead) {
  if (lead.sources_count) return lead.sources_count;
  let n = 0;
  if (lead.evidence_url) n++;
  if (lead.evidence_url_2) n++;
  if (lead.dm_source) n++;
  return Math.max(1, n);
}

// Tenant-facing view: strip proprietary sourcing (Apollo etc.). The owner
// org keeps full provenance for self-use.
function view(lead, { owner = false } = {}) {
  const v = { ...lead, sources_count: sourcesCount(lead) };
  if (!owner) {
    delete v.dm_source;
    delete v.evidence_url;
    delete v.evidence_url_2;
    delete v.apollo_org_id;   // never reveal the underlying data source to tenants
    delete v.company_phone;   // server-side enrichment fallback only
  }
  return v;
}

async function seedSamplesFor(orgId) {
  const existing = await allRaw(orgId);
  if (existing.length) return;
  for (const tpl of SEED) {
    const lead = { ...tpl, id: crypto.randomUUID(), org_id: orgId, sample: true };
    await db.put(COL, lead.id, lead);
  }
}

async function allRaw(orgId) {
  return (await db.list(COL)).filter(l => l.org_id === orgId);
}

async function all(orgId, opts) {
  return (await allRaw(orgId)).map(l => view(l, opts));
}

async function getOwned(orgId, id) {
  const lead = await db.get(COL, id);
  return lead && lead.org_id === orgId ? lead : null;
}

// Delete every seeded sample lead for an org (used when going live).
async function clearSamples(orgId) {
  const samples = (await allRaw(orgId)).filter(l => l.sample);
  for (const l of samples) await db.del(COL, l.id);
  return { removed: samples.length };
}

async function setStatus(orgId, id, status, by) {
  if (!STATUSES.includes(status)) return { error: 'Invalid status' };
  const lead = await getOwned(orgId, id);
  if (!lead) return { error: 'Lead not found' };
  const now = new Date().toISOString();
  lead.lead_status = status;
  lead.updated_at = now;
  if (status === 'Contacted' && !lead.contacted_at) lead.contacted_at = now;
  lead.activity = lead.activity || [];
  lead.activity.push({ type: 'status', text: `Status → ${status}`, by: by || 'system', at: now });
  await db.put(COL, id, lead);
  return { lead };
}

async function addActivity(orgId, id, { type, text, by }) {
  if (!ACTIVITY_TYPES.includes(type)) return { error: 'Invalid activity type' };
  if (!text || !String(text).trim()) return { error: 'Text required' };
  const lead = await getOwned(orgId, id);
  if (!lead) return { error: 'Lead not found' };
  const now = new Date().toISOString();
  lead.activity = lead.activity || [];
  lead.activity.push({ type, text: String(text).trim(), by: by || 'staff', at: now });
  lead.updated_at = now;
  await db.put(COL, id, lead);
  return { lead };
}

// Attach an enriched decision-maker contact to a lead (Enrich-contact button).
async function setContact(orgId, id, contact) {
  const lead = await getOwned(orgId, id);
  if (!lead) return { error: 'Lead not found' };
  const now = new Date().toISOString();
  lead.dm_name   = contact.name  || lead.dm_name  || '';
  lead.dm_title  = contact.title || lead.dm_title || '';
  lead.dm_email  = contact.email || lead.dm_email || '';
  lead.dm_phone  = contact.phone || lead.dm_phone || '';
  lead.dm_source = contact.source || lead.dm_source || '';
  if (lead.dm_email || lead.dm_name) lead.requires_recipient = false;
  lead.activity = lead.activity || [];
  lead.activity.push({ type: 'status', text: `Contact enriched${contact.name ? ` — ${contact.name}` : ''}`,
                       by: 'system', at: now });
  lead.updated_at = now;
  await db.put(COL, id, lead);
  return { lead };
}

async function updateDraft(orgId, id, { subject, body }) {
  const lead = await getOwned(orgId, id);
  if (!lead) return { error: 'Lead not found' };
  lead.outreach_subject = subject;
  lead.outreach_body = body;
  lead.updated_at = new Date().toISOString();
  await db.put(COL, id, lead);
  return { lead };
}

// Last time a human touched a Contacted lead (any activity beats contacted_at).
function lastTouch(lead) {
  const times = (lead.activity || []).map(a => a.at);
  if (lead.contacted_at) times.push(lead.contacted_at);
  return times.sort().pop() || lead.date_discovered;
}

// Contacted leads (still awaiting a reply) untouched for >= FOLLOWUP_DAYS.
async function followups(orgId) {
  const now = Date.now();
  return (await allRaw(orgId))
    .filter(l => l.lead_status === 'Contacted')
    .map(l => {
      const t = lastTouch(l);
      const days = Math.floor((now - Date.parse(t)) / 86400000);
      return { id: l.id, company_name: l.company_name, dm_name: l.dm_name,
               last_touch: t, days_since: days };
    })
    .filter(f => f.days_since >= FOLLOWUP_DAYS)
    .sort((a, b) => b.days_since - a.days_since);
}

async function stats(orgId) {
  const leads = await allRaw(orgId);
  const by = (fn) => leads.reduce((m, l) => { const k = fn(l); m[k] = (m[k] || 0) + 1; return m; }, {});
  const contacted = leads.filter(l => ['Contacted', 'Replied', 'Qualified', 'Quotation', 'Won'].includes(l.lead_status)).length;
  const replied   = leads.filter(l => ['Replied', 'Qualified', 'Quotation', 'Won'].includes(l.lead_status)).length;
  return {
    total: leads.length,
    newVerified: leads.filter(l => ['Verified', 'High Priority'].includes(l.lead_status)).length,
    awaitingApproval: leads.filter(l => ['Verified', 'High Priority'].includes(l.lead_status) && l.outreach_body).length,
    contacted,
    replyRate: contacted ? Math.round((replied / contacted) * 100) : 0,
    qualified: leads.filter(l => ['Qualified', 'Quotation'].includes(l.lead_status)).length,
    pipelineSgd: leads.filter(l => ['Qualified', 'Quotation'].includes(l.lead_status))
                      .reduce((s, l) => s + (l.est_pipeline_sgd || 0), 0),
    scoreBuckets: {
      '65-74':  leads.filter(l => l.lead_score >= 65 && l.lead_score < 75).length,
      '75-84':  leads.filter(l => l.lead_score >= 75 && l.lead_score < 85).length,
      '85-100': leads.filter(l => l.lead_score >= 85).length,
    },
    byService: by(l => l.uld_service),
    byStatus:  by(l => l.lead_status),
  };
}

module.exports = { all, view, getOwned, seedSamplesFor, clearSamples, setStatus, addActivity, updateDraft,
                   setContact, followups, stats, STATUSES, CONTACTED_SET, ACTIVITY_TYPES, FOLLOWUP_DAYS };
