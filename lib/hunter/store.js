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

function setStatus(id, status) {
  if (!STATUSES.includes(status)) return { error: 'Invalid status' };
  const lead = update(id, { lead_status: status });
  return lead ? { lead } : { error: 'Lead not found' };
}

function updateDraft(id, { subject, body }) {
  const lead = update(id, { outreach_subject: subject, outreach_body: body });
  return lead ? { lead } : { error: 'Lead not found' };
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

module.exports = { all, setStatus, updateDraft, stats, STATUSES };
