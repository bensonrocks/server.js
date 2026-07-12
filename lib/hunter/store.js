'use strict';

const fs   = require('fs');
const path = require('path');

// JSON file store, same fallback pattern as lib/users.js. The Python
// pipeline (idealone-hunter/lead_agent.py) writes SQLite; this store lets
// the CRM UI run before the pipeline is wired up, seeded with sample data.
const FILE = path.join(__dirname, '../../data/hunter-leads.json');

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

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

function write(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function all() {
  let list = read();
  if (!list) {
    list = SEED;
    write(list);
  }
  return list;
}

function update(id, patch) {
  const list = all();
  const i = list.findIndex(l => l.id === id);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() };
  write(list);
  return list[i];
}

function setStatus(id, status, by) {
  if (!STATUSES.includes(status)) return { error: 'Invalid status' };
  const list = all();
  const i = list.findIndex(l => l.id === id);
  if (i === -1) return { error: 'Lead not found' };
  const now = new Date().toISOString();
  const lead = list[i];
  lead.lead_status = status;
  lead.updated_at = now;
  if (status === 'Contacted' && !lead.contacted_at) lead.contacted_at = now;
  lead.activity = lead.activity || [];
  lead.activity.push({ type: 'status', text: `Status → ${status}`, by: by || 'system', at: now });
  write(list);
  return { lead };
}

function addActivity(id, { type, text, by }) {
  if (!ACTIVITY_TYPES.includes(type)) return { error: 'Invalid activity type' };
  if (!text || !String(text).trim()) return { error: 'Text required' };
  const list = all();
  const i = list.findIndex(l => l.id === id);
  if (i === -1) return { error: 'Lead not found' };
  const now = new Date().toISOString();
  list[i].activity = list[i].activity || [];
  list[i].activity.push({ type, text: String(text).trim(), by: by || 'staff', at: now });
  list[i].updated_at = now;
  write(list);
  return { lead: list[i] };
}

function updateDraft(id, { subject, body }) {
  const lead = update(id, { outreach_subject: subject, outreach_body: body });
  return lead ? { lead } : { error: 'Lead not found' };
}

// Last time a human touched a Contacted lead (any activity beats contacted_at).
function lastTouch(lead) {
  const times = (lead.activity || []).map(a => a.at);
  if (lead.contacted_at) times.push(lead.contacted_at);
  return times.sort().pop() || lead.date_discovered;
}

// Contacted leads (still awaiting a reply) untouched for >= FOLLOWUP_DAYS.
function followups() {
  const now = Date.now();
  return all()
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

function stats() {
  const leads = all();
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

module.exports = { all, setStatus, addActivity, updateDraft, followups, stats,
                   STATUSES, CONTACTED_SET, ACTIVITY_TYPES, FOLLOWUP_DAYS };
