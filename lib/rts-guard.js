'use strict';

// Marketplace Ready-to-Ship decisions, kept out of server.js so the rules can
// be tested without booting the app.
//
// Zort's own status and the marketplace's status are two facts. Zort
// "Completed" (status word "success") does not mean Lazada is ready_to_ship,
// Shopee is PROCESSED, or TikTok is AWAITING_COLLECTION. Callers that have
// the per-store switch on ask this module; with the switch off they keep the
// old Zort-status rule and never call in here for that decision.

function normWord(s) {
  return String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function marketplaceOf(channel, platform) {
  const hay = `${channel || ''} ${platform || ''}`.toLowerCase();
  if (/lazada/.test(hay)) return 'lazada';
  if (/shopee/.test(hay)) return 'shopee';
  if (/tiktok/.test(hay)) return 'tiktok';
  return '';
}

// Seller has NOT arranged shipment yet. Shopee's own READY_TO_SHIP is this
// state — the name is the trap. TikTok AWAITING_SHIPMENT is the same idea.
const LAZADA_NOT_DONE = new Set(['packed', 'pending', 'unpaid', 'to_ship', 'to_arrange', 'to_arrange_shipment', 'repacked', 'to_pack']);
const LAZADA_DONE = new Set(['ready_to_ship', 'shipped', 'delivered', 'confirmed', 'failed', 'returned', 'lost', 'lost_by_3pl', 'damaged_by_3pl', 'failed_delivery']);
const SHOPEE_NOT_DONE = new Set(['unpaid', 'ready_to_ship', 'retry_ship', 'to_ship']);
const SHOPEE_DONE = new Set(['processed', 'shipped', 'completed', 'to_confirm_receive', 'to_return']);
const TIKTOK_NOT_DONE = new Set(['unpaid', 'on_hold', 'awaiting_shipment']);
const TIKTOK_DONE = new Set(['awaiting_collection', 'in_transit', 'delivered', 'completed', 'partially_shipping']);

// 'done'     — marketplace already at RTS or later; do not send again
// 'not_done' — still packed/pending (or the channel's equivalent); send RTS
// 'cancelled'— do not send RTS
// 'unknown'  — no word, or a word we do not recognise, or not a known channel
function marketplaceRtsVerdict(marketplace, integrationWord) {
  const mp = String(marketplace || '').toLowerCase();
  if (!mp || !['lazada', 'shopee', 'tiktok'].includes(mp)) return 'unknown';
  const w = normWord(integrationWord);
  if (!w) return 'unknown';
  // "cancel" / "canceled" / "in_cancel" before the status sets, so a word
  // that also happens to sit in a set cannot be read as progress.
  if (w.includes('cancel')) return 'cancelled';
  const table = mp === 'lazada' ? [LAZADA_NOT_DONE, LAZADA_DONE]
    : mp === 'shopee' ? [SHOPEE_NOT_DONE, SHOPEE_DONE]
    : [TIKTOK_NOT_DONE, TIKTOK_DONE];
  if (table[0].has(w)) return 'not_done';
  if (table[1].has(w)) return 'done';
  return 'unknown';
}

// mode 'legacy'  — switch off, or the channel is not Lazada/Shopee/TikTok.
//                  The caller keeps today's Zort-status rule.
// mode 'already' — marketplace itself says RTS or later. Stamp sent, no call.
// mode 'cancel'  — marketplace says cancelled. Do not call, do not stamp sent.
// mode 'send'    — packed/pending, or a known channel whose word we cannot
//                  read. Call Ready-to-Ship and only stamp sent when the
//                  marketplace read-back is 'done'.
function completionRtsPlan({ confirm, channel, platform, integration }) {
  if (!confirm) return { mode: 'legacy' };
  const mp = marketplaceOf(channel, platform);
  if (!mp) return { mode: 'legacy' };
  const verdict = marketplaceRtsVerdict(mp, integration);
  if (verdict === 'done') return { mode: 'already', marketplace: mp, verdict };
  if (verdict === 'cancelled') return { mode: 'cancel', marketplace: mp, verdict };
  return { mode: 'send', marketplace: mp, verdict };
}

// Due completion entries for stores that opted in move ahead of everything
// else. Not-due completions stay where they were. Stable: two completions
// keep their relative order. An empty flagged set returns a copy unchanged.
function prioritizeDueCompletions(entries, flaggedStoreIds, nowMs) {
  const flagged = flaggedStoreIds instanceof Set ? flaggedStoreIds : new Set(flaggedStoreIds || []);
  const list = Array.isArray(entries) ? entries : [];
  if (!flagged.size) return list.slice();
  const now = nowMs == null ? Date.now() : nowMs;
  const front = [];
  const rest = [];
  for (const entry of list) {
    const due = !(new Date(entry && entry.nextAttemptAt).getTime() > now);
    if (due && entry && entry.kind === 'completion' && flagged.has(entry.storeId)) front.push(entry);
    else rest.push(entry);
  }
  return front.concat(rest);
}

// Record WHY a due entry was not attempted. Does not touch attempts or
// lastError — a hold is not a refusal, and the chip treats lastError as one.
// Returns true only when the reason is new, so the caller can skip a write
// when the same hold is still in force.
function applyOutboxHold(entry, why, nowIso) {
  if (!entry || entry.lastSkip === why) return false;
  entry.lastSkip = why;
  entry.lastSkipAt = nowIso || new Date().toISOString();
  return true;
}

const SLACK_MS = 2 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A hub timestamp is usable as "when the courier took it" only when it is a
// real date-time that is not in the future. A date with no time is not an
// event. Anything past now + slack is an ETA or a clock we do not trust.
function hubTimestampUsable(raw, nowMs, opts) {
  const slack = (opts && opts.slackMs != null) ? opts.slackMs : SLACK_MS;
  const s = String(raw || '').trim();
  if (!s || DATE_ONLY.test(s)) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return null;
  const now = nowMs == null ? Date.now() : nowMs;
  if (d.getTime() > now + slack) return null;
  return d.toISOString();
}

// guard: true drops deliverydate (an ETA, not a collection) and rejects
// future / date-only values. Without guard, the first parseable candidate
// wins, including deliverydate — that is the historical reader.
function hubShippedAt(obj, opts) {
  const guard = !!(opts && opts.guard);
  const fields = guard
    ? ['shippingdate', 'shipdate', 'senddate', 'updateddatetime', 'updateddate']
    : ['shippingdate', 'shipdate', 'senddate', 'deliverydate', 'updateddatetime', 'updateddate'];
  for (const k of fields) {
    const v = obj && obj[k];
    if (guard) {
      const iso = hubTimestampUsable(v, opts && opts.nowMs, opts);
      if (iso) return iso;
    } else {
      const raw = String(v || '').trim();
      if (!raw) continue;
      const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

module.exports = {
  normWord,
  marketplaceOf,
  marketplaceRtsVerdict,
  completionRtsPlan,
  prioritizeDueCompletions,
  applyOutboxHold,
  hubTimestampUsable,
  hubShippedAt,
};
