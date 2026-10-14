// DRIVER: RECEIVER SIGNS THE DO BEFORE SCAN-TO-CLOSE.
// Pure helpers; server.js does the I/O. One signature per transport job
// (= one order / one DO), so a multi-order route needs one per stop.
// Flag DRIVER_SIGN_REQUIRED=1 (off by default). DRIVER_POD_PROOF picks what
// counts as proof: 'signature' (default), 'photo', 'either' or 'both'.
'use strict';
const MODES = ['signature', 'photo', 'either', 'both'];
const MAX_SIG_BYTES = 60 * 1024;          // a phone signature PNG is ~5–25 KB
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function signRequiredOn(env = process.env) { return /^(1|true|on|yes)$/i.test(String(env.DRIVER_SIGN_REQUIRED || '')); }
function proofMode(env = process.env) {
  const m = String(env.DRIVER_POD_PROOF || '').trim().toLowerCase();
  return MODES.includes(m) ? m : 'signature';
}
const hasSignature = job => !!(job && job.podSignature && job.podSignature.file);
const hasPhoto = job => !!(job && Array.isArray(job.podPhotos) && job.podPhotos.length);

// null = OK to close; otherwise the message the driver sees.
function proofMissing(job, mode = 'signature') {
  if (job && job.podOverride && job.podOverride.reason) return null;   // office waived it
  const s = hasSignature(job), p = hasPhoto(job);
  if (mode === 'photo') return p ? null : 'Take a photo of the signed DO first.';
  if (mode === 'either') return s || p ? null : 'Get the receiver to sign the DO first.';
  if (mode === 'both') return !s ? 'Get the receiver to sign the DO first.' : (!p ? 'Take a photo of the signed DO too.' : null);
  return s ? null : 'Get the receiver to sign the DO first.';
}

// { dataUrl: 'data:image/png;base64,…', receiverName } → { ok, buf, name } | { ok:false, error }
function validateSignature(body) {
  const name = String((body && body.receiverName) || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) return { ok: false, error: "Enter the receiver's name." };
  if (name.length > 60) return { ok: false, error: 'Receiver name is too long (60 characters max).' };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String((body && body.dataUrl) || ''));
  if (!m) return { ok: false, error: 'No signature received. Ask the receiver to sign again.' };
  if (m[1].length > Math.ceil(MAX_SIG_BYTES * 4 / 3) + 4) return { ok: false, error: 'Signature image too large.' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_SIG_BYTES) return { ok: false, error: 'Signature image too large.' };
  if (buf.length < 100 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, error: 'Signature image is not a valid PNG.' };
  return { ok: true, buf, name };
}

// OFFICE OVERRIDE: waives the signature for one order (job), with a reason.
const OVERRIDE_REASONS = {
  refused: 'Receiver refused to sign',
  security: 'Receiver not present - left with security/guard',
  door: 'Left at door per instruction',
  other: 'Other',
};
function validateOverride(body) {
  const code = String((body && body.reason) || '');
  if (!OVERRIDE_REASONS[code]) return { ok: false, error: 'Pick a reason.' };
  const note = String((body && body.note) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (code === 'other' && note.length < 3) return { ok: false, error: "Type the reason for 'Other'." };
  const text = code === 'other' ? note : (note ? `${OVERRIDE_REASONS[code]} (${note})` : OVERRIDE_REASONS[code]);
  return { ok: true, code, note, text };
}
const sgt = iso => { const t = new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString(); return `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)} ${t.slice(11, 16)} SGT`; };
const overrideLine = o => `NOT SIGNED - office override: ${o.reason} (${o.byName || o.by}, ${sgt(o.at)})`;

module.exports = { OVERRIDE_REASONS, validateOverride, overrideLine, sgt, MODES, MAX_SIG_BYTES, signRequiredOn, proofMode, hasSignature, hasPhoto, proofMissing, validateSignature };
