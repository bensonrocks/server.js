'use strict';
// Public sales enquiry from /intro: validate + sanitise, store, then email.
// Pure helpers; server.js wires in storage and the mail transport.
// Server-side only; never sent to the browser. Override with env ENQUIRY_TO.
const DEFAULT_ENQUIRY_TO = 'info@nimbustrade.co';
const enquiryTo = () => (process.env.ENQUIRY_TO || '').trim() || DEFAULT_ENQUIRY_TO;
const COMPANY_TYPES = ['3PL / logistics provider', 'E-commerce brand', 'Distributor / wholesaler', 'Retailer', 'Other'];
const ORDER_RANGES = ['Under 1,000', '1,000 - 5,000', '5,000 - 20,000', '20,000 - 100,000', 'Over 100,000', 'Not sure'];
const MODULES = ['Core OMS', 'WMS scan', 'TMS / driver app', 'Client portal', 'Integrations'];
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

function clean(v, max) {
  // strip control chars (incl. CR/LF for single-line fields) and angle brackets
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanMultiline(v, max) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, ' ').trim().slice(0, max);
}

// Returns { honeypot: true } | { errors: [...] } | { enquiry }
function validateEnquiry(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (clean(b.website, 200)) return { honeypot: true };
  const e = {
    name: clean(b.name, 120), company: clean(b.company, 160), email: clean(b.email, 254).toLowerCase(),
    phone: clean(b.phone, 40), company_type: clean(b.company_type, 60), monthly_orders: clean(b.monthly_orders, 40),
    modules: (Array.isArray(b.modules) ? b.modules : (b.modules ? [b.modules] : [])).map(m => clean(m, 40)).filter(m => MODULES.includes(m)),
    message: cleanMultiline(b.message, 4000),
  };
  const errors = [];
  if (e.name.length < 2) errors.push('Please enter your name.');
  if (e.company.length < 2) errors.push('Please enter your company.');
  if (!EMAIL_RE.test(e.email)) errors.push('Please enter a valid email address.');
  if (e.phone && !/^[+\d][\d\s()-]{5,39}$/.test(e.phone)) errors.push('Please enter a valid phone number.');
  if (e.company_type && !COMPANY_TYPES.includes(e.company_type)) errors.push('Please choose a company type.');
  if (e.monthly_orders && !ORDER_RANGES.includes(e.monthly_orders)) errors.push('Please choose a monthly order range.');
  return errors.length ? { errors } : { enquiry: e };
}

function enquiryMail(e, from) {
  const lines = [
    `New IdealOne enquiry (idealone.tech/intro)`, '',
    `Name: ${e.name}`, `Company: ${e.company}`, `Email: ${e.email}`, `Phone: ${e.phone || '-'}`,
    `Company type: ${e.company_type || '-'}`, `Monthly orders: ${e.monthly_orders || '-'}`,
    `Modules: ${e.modules.length ? e.modules.join(', ') : '-'}`, '', 'Message:', e.message || '-', '',
    `Received: ${e.created_at} (id ${e.id})`,
  ];
  return { from, to: enquiryTo(), replyTo: e.email, subject: `IdealOne enquiry: ${e.company} (${e.name})`, text: lines.join('\n') };
}

// store(e) persists; sendMail(msg) -> Promise or null when mail is not configured.
async function handleEnquiry(body, { store, sendMail, from, now = new Date(), id, meta = {} }) {
  const v = validateEnquiry(body);
  if (v.honeypot) return { status: 200, body: { ok: true } };   // silently accept bots
  if (v.errors) return { status: 400, body: { ok: false, errors: v.errors } };
  const e = { id: id || ('ENQ-' + now.getTime().toString(36)), created_at: now.toISOString(), ...v.enquiry, ...meta, mail_status: 'pending' };
  store(e);
  try {
    if (!sendMail) { e.mail_status = 'not_configured'; }
    else { await sendMail(enquiryMail(e, from)); e.mail_status = 'sent'; }
  } catch (err) { e.mail_status = 'failed'; e.mail_error = String(err && err.message || err).slice(0, 300); }
  store(e);
  // Stored either way, so the enquiry is never lost; tell the visitor the truth.
  return { status: 200, body: { ok: true, id: e.id, emailed: e.mail_status === 'sent' } };
}

module.exports = { DEFAULT_ENQUIRY_TO, enquiryTo, COMPANY_TYPES, ORDER_RANGES, MODULES, validateEnquiry, enquiryMail, handleEnquiry };
