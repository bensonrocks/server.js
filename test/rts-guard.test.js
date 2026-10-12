// Marketplace Ready-to-Ship is decided from the marketplace's own status.
//
// Live on 6 Oct 2026: after the warehouse scan, the completion push treated
// Zort "Completed" (status word "success") as already Ready-to-Ship and
// stamped the push sent while Lazada still said "packed". These checks pin
// the decision table, the outbox ordering, and the pickup-time guard. They
// do not boot the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../lib/rts-guard');

test('channel names from the live stores resolve to a marketplace', () => {
  assert.equal(g.marketplaceOf('Lazada20082026Mayer', ''), 'lazada');
  assert.equal(g.marketplaceOf('TIKTOKSmilefam', ''), 'tiktok');
  assert.equal(g.marketplaceOf('ShopeeSmilefam', ''), 'shopee');
  assert.equal(g.marketplaceOf('', 'Lazada'), 'lazada');
  assert.equal(g.marketplaceOf('', ''), '');
  assert.equal(g.marketplaceOf('some-other-oms', 'manual'), '');
});

test('Lazada packed is not RTS; ready_to_ship and later is', () => {
  assert.equal(g.marketplaceRtsVerdict('lazada', 'packed'), 'not_done');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'pending'), 'not_done');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'Ready To Ship'), 'done');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'ready_to_ship'), 'done');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'shipped'), 'done');
});

test('Shopee READY_TO_SHIP means not yet arranged; PROCESSED means done', () => {
  assert.equal(g.marketplaceRtsVerdict('shopee', 'READY_TO_SHIP'), 'not_done');
  assert.equal(g.marketplaceRtsVerdict('shopee', 'PROCESSED'), 'done');
  assert.equal(g.marketplaceRtsVerdict('shopee', 'SHIPPED'), 'done');
});

test('TikTok AWAITING_SHIPMENT is not collection; AWAITING_COLLECTION is', () => {
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'AWAITING_SHIPMENT'), 'not_done');
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'AWAITING_COLLECTION'), 'done');
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'IN_TRANSIT'), 'done');
});

test('a cancellation word wins over any other reading', () => {
  assert.equal(g.marketplaceRtsVerdict('lazada', 'canceled'), 'cancelled');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'Cancelled'), 'cancelled');
  assert.equal(g.marketplaceRtsVerdict('shopee', 'IN_CANCEL'), 'cancelled');
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'cancel'), 'cancelled');
});

test('empty, unknown marketplace, and an unrecognised word stay unknown', () => {
  assert.equal(g.marketplaceRtsVerdict('lazada', ''), 'unknown');
  assert.equal(g.marketplaceRtsVerdict('lazada', '   '), 'unknown');
  assert.equal(g.marketplaceRtsVerdict('', 'packed'), 'unknown');
  assert.equal(g.marketplaceRtsVerdict('shopify', 'packed'), 'unknown');
  assert.equal(g.marketplaceRtsVerdict('lazada', 'mystery_status'), 'unknown');
});

test('the completion plan follows the marketplace only when the switch is on', () => {
  const packed = { channel: 'Lazada20082026Mayer', platform: '', integration: 'packed' };
  assert.deepEqual(g.completionRtsPlan({ confirm: false, ...packed }).mode, 'legacy');
  assert.equal(g.completionRtsPlan({ confirm: true, ...packed }).mode, 'send');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'Lazada20082026Mayer', integration: 'ready_to_ship',
  }).mode, 'already');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'ShopeeSmilefam', integration: 'READY_TO_SHIP',
  }).mode, 'send');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'ShopeeSmilefam', integration: 'PROCESSED',
  }).mode, 'already');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'TIKTOKSmilefam', integration: 'AWAITING_SHIPMENT',
  }).mode, 'send');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'TIKTOKSmilefam', integration: 'AWAITING_COLLECTION',
  }).mode, 'already');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'Lazada20082026Mayer', integration: 'canceled',
  }).mode, 'cancel');
  // Zort Completed is not an input. A blank marketplace word on a known
  // channel still sends, and the caller must not stamp sent until read-back.
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'Lazada20082026Mayer', integration: '',
  }).mode, 'send');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: '', platform: '', integration: 'packed',
  }).mode, 'legacy');
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: '', platform: 'Lazada', integration: 'packed',
  }).mode, 'send');
});

test('TikTok numeric codes: 121 is already in transit, 111 still needs RTS, 140 is cancelled', () => {
  const plan = (integration) => g.completionRtsPlan({
    confirm: true, channel: 'TIKTOKSmilefam', integration,
  });
  for (const code of [112, '112', 114, '114', 121, '121', '121.0', 122, '122', 130, '130']) {
    assert.equal(g.marketplaceRtsVerdict('tiktok', code), 'done', String(code));
    assert.equal(plan(code).mode, 'already', String(code));
  }
  for (const code of [100, '100', 105, '105', 111, '111']) {
    assert.equal(g.marketplaceRtsVerdict('tiktok', code), 'not_done', String(code));
    assert.equal(plan(code).mode, 'send', String(code));
  }
  for (const code of [140, '140', '140.0']) {
    assert.equal(g.marketplaceRtsVerdict('tiktok', code), 'cancelled', String(code));
    assert.equal(plan(code).mode, 'cancel', String(code));
  }
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'IN_TRANSIT'), 'done');
  assert.equal(g.marketplaceRtsVerdict('tiktok', 'partially_shipping'), 'done');
  // A fractional code is not an integer status. JS number 121.0 stringifies as "121".
  assert.equal(g.marketplaceRtsVerdict('tiktok', '121.5'), 'unknown');
  assert.equal(g.marketplaceRtsVerdict('tiktok', 121.5), 'unknown');
  assert.equal(plan('121.5').mode, 'unknown');
});

test('Lazada and Shopee have no numeric status map', () => {
  for (const code of ['121', 121, '2', '4']) {
    assert.equal(g.marketplaceRtsVerdict('lazada', code), 'unknown', 'lazada ' + code);
    assert.equal(g.completionRtsPlan({
      confirm: true, channel: 'Lazada20082026Mayer', integration: code,
    }).mode, 'unknown', 'lazada ' + code);
  }
  for (const code of ['2', '4', 121, '121']) {
    assert.equal(g.marketplaceRtsVerdict('shopee', code), 'unknown', 'shopee ' + code);
    assert.equal(g.completionRtsPlan({
      confirm: true, channel: 'ShopeeSmilefam', integration: code,
    }).mode, 'unknown', 'shopee ' + code);
  }
});

test('an unrecognised status is not sent again, and a blank word still is', () => {
  const unknown = g.completionRtsPlan({
    confirm: true, channel: 'TIKTOKSmilefam', integration: '999',
  });
  assert.equal(unknown.mode, 'unknown');
  assert.match(unknown.reason, /unknown/i);
  assert.match(unknown.reason, /999/);
  const mystery = g.completionRtsPlan({
    confirm: true, channel: 'Lazada20082026Mayer', integration: 'mystery_status',
  });
  assert.equal(mystery.mode, 'unknown');
  assert.match(mystery.reason, /unknown/i);
  assert.equal(g.completionRtsPlan({
    confirm: true, channel: 'TIKTOKSmilefam', integration: '',
  }).mode, 'send');
  assert.equal(g.marketplaceBlocksPickup('not_done'), true);
  assert.equal(g.marketplaceBlocksPickup('cancelled'), true);
  assert.equal(g.marketplaceBlocksPickup('done'), false);
  assert.equal(g.marketplaceBlocksPickup('unknown'), false);
  assert.equal(g.marketplaceBlocksPickup(''), false);
});

test('a refused Ready-to-Ship stamps sent when the read-back is already shipped or in transit', () => {
  const stamp = (integration) => g.afterSendDecision({
    verdict: 'done', integration, marketplace: 'tiktok', zortStatus: 'pending', read: true,
  });
  assert.equal(stamp('121').action, 'stamp');
  assert.equal(stamp('IN_TRANSIT').action, 'stamp');
  assert.equal(stamp('shipped').action, 'stamp');
  const held = g.afterSendDecision({
    verdict: 'unknown', integration: '999', marketplace: 'tiktok', zortStatus: 'pending', read: true,
  });
  assert.equal(held.action, 'hold');
  assert.match(held.reason, /unknown/i);
  const viaZort = g.afterSendDecision({
    verdict: 'unknown', integration: '999', marketplace: 'lazada', zortStatus: 'success', read: true,
  });
  assert.equal(viaZort.action, 'stamp');
  assert.equal(viaZort.via, 'zort');
  assert.equal(g.afterSendDecision({
    verdict: 'not_done', integration: '111', marketplace: 'tiktok', zortStatus: 'packed', read: true,
  }).action, 'retry');
  assert.equal(g.afterSendDecision({
    verdict: 'cancelled', integration: '140', marketplace: 'tiktok', zortStatus: 'success', read: true,
  }).action, 'terminal');
  // A blank word is still the ordinary retry, even when Zort already says success.
  assert.equal(g.afterSendDecision({
    verdict: 'unknown', integration: '', marketplace: 'lazada', zortStatus: 'success', read: true,
  }).action, 'retry');
  assert.equal(g.afterSendDecision({
    verdict: 'unknown', integration: '', marketplace: 'lazada', zortStatus: '', read: false,
  }).action, 'retry');
});

test('due completion entries move ahead of a label backlog only for a flagged store', () => {
  const labels = Array.from({ length: 30 }, (_, i) => ({
    kind: 'label', storeId: 'hub', orderNumber: 'L' + i, nextAttemptAt: '2026-10-06T02:00:00.000Z',
  }));
  const completion = {
    kind: 'completion', storeId: 'hub', orderNumber: '172345816184229',
    nextAttemptAt: '2026-10-06T02:25:00.000Z',
  };
  const later = {
    kind: 'completion', storeId: 'hub', orderNumber: '173894356758004',
    nextAttemptAt: '2026-10-06T06:00:00.000Z',
  };
  const notDue = {
    kind: 'completion', storeId: 'hub', orderNumber: 'future',
    nextAttemptAt: '2026-10-07T00:00:00.000Z',
  };
  const other = {
    kind: 'completion', storeId: 'other', orderNumber: 'elsewhere',
    nextAttemptAt: '2026-10-06T02:00:00.000Z',
  };
  const now = Date.parse('2026-10-06T06:23:00.000Z');
  const entries = labels.concat([completion, other, notDue, later]);
  const out = g.prioritizeDueCompletions(entries, new Set(['hub']), now);
  assert.equal(out[0].orderNumber, '172345816184229');
  assert.equal(out[1].orderNumber, '173894356758004');
  assert.equal(out[2].kind, 'label');
  assert.ok(out.indexOf(notDue) > 2);
  assert.ok(out.indexOf(other) > 2);
  const untouched = g.prioritizeDueCompletions(entries, new Set(), now);
  assert.deepEqual(untouched.map(e => e.orderNumber), entries.map(e => e.orderNumber));
  assert.notEqual(untouched, entries);
});

test('a hold records a reason without looking like a channel refusal', () => {
  const entry = { attempts: 0 };
  assert.equal(g.applyOutboxHold(entry, 'waiting behind the pass cap', '2026-10-06T02:30:00.000Z'), true);
  assert.equal(entry.lastSkip, 'waiting behind the pass cap');
  assert.equal(entry.lastError, undefined);
  assert.equal(entry.attempts, 0);
  assert.equal(g.applyOutboxHold(entry, 'waiting behind the pass cap'), false);
  assert.equal(g.applyOutboxHold(entry, 'hub is not answering — held'), true);
  assert.equal(entry.lastSkip, 'hub is not answering — held');
  assert.equal(entry.lastError, undefined);
  assert.equal(g.applyOutboxHold(null, 'x'), false);
});

test('a future hub time is not a pickup, and a date with no time is not one either', () => {
  const now = Date.parse('2026-10-06T06:23:00.000Z');
  // The live stamps were 2026-10-06T23:59:xx.000Z — about 08:00 SGT the next
  // morning — while the check ran at 14:23 SGT the same calendar morning.
  assert.equal(g.hubTimestampUsable('2026-10-06T23:59:42.000Z', now), null);
  assert.equal(g.hubTimestampUsable('2026-10-07T00:00:00.000Z', now), null);
  assert.equal(g.hubTimestampUsable('2026-10-07', now), null);
  assert.equal(g.hubTimestampUsable('2026-10-06', now), null);
  const soon = new Date(now + 30 * 1000).toISOString();
  assert.equal(g.hubTimestampUsable(soon, now), soon);
  const past = '2026-10-06T02:07:35.000Z';
  assert.equal(g.hubTimestampUsable(past, now), past);
});

test('guarded pickup reading drops an ETA and a future ship time', () => {
  const now = Date.parse('2026-10-06T06:23:00.000Z');
  const hub = {
    shippingdate: '2026-10-07T00:00:00.000Z',
    deliverydate: '2026-10-07T08:00:00.000Z',
    updateddatetime: '2026-10-06T02:07:22.000Z',
  };
  assert.equal(g.hubShippedAt(hub, { guard: true, nowMs: now }), '2026-10-06T02:07:22.000Z');
  // Unguarded, the first parseable field wins — deliverydate included — which
  // is how a next-morning ETA became "picked up".
  assert.equal(
    g.hubShippedAt({ deliverydate: '2026-10-07 07:59:42' }, { nowMs: now }),
    new Date('2026-10-07T07:59:42').toISOString()
  );
  assert.equal(g.hubShippedAt({
    deliverydate: '2026-10-06T02:00:00.000Z',
    shippingdate: '',
  }, { guard: true, nowMs: now }), null);
});
