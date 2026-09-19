'use strict';

// The lifecycle a job moves through, in order. `cancelled` is a flag on top
// of this (see jobs.cancelJob), never a stage of its own, so a cancelled job
// still remembers which stage it reached.
const STAGE_ORDER = [
  'quote_requested',
  'quote_sent',
  'accepted',
  'collected',
  'in_transit',
  'delivered',
  'invoiced',
  'paid',
];

const STAGE_LABELS = {
  quote_requested: 'Quote requested',
  quote_sent: 'Quote sent',
  accepted: 'Quote accepted',
  collected: 'Collected',
  in_transit: 'In transit',
  delivered: 'Delivered',
  invoiced: 'Invoiced',
  paid: 'Paid',
};

function stageIndex(status) {
  const i = STAGE_ORDER.indexOf(status);
  return i === -1 ? 0 : i;
}

module.exports = { STAGE_ORDER, STAGE_LABELS, stageIndex };
