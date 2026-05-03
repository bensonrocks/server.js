'use strict';

const express = require('express');
const path = require('path');
const store = require('./lib/store');
const { parseEmailBody } = require('./lib/email-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Orders ────────────────────────────────────────────────────────────────────

app.get('/api/orders', (req, res) => {
  const { clientId, channel, status, search } = req.query;
  res.json(store.getOrders({ clientId, channel, status, search }));
});

app.get('/api/orders/:id', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// ── Email ingestion ───────────────────────────────────────────────────────────

app.post('/api/orders/ingest-email', (req, res) => {
  const { body, subject, from } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Email body is required' });
  try {
    const order = parseEmailBody(body);
    if (subject) order.source.emailSubject = subject;
    if (from)    order.source.emailFrom = from;
    store.addOrder(order);
    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Aggregates ────────────────────────────────────────────────────────────────

app.get('/api/stats',    (req, res) => res.json(store.getStats()));
app.get('/api/clients',  (req, res) => res.json(store.getClients()));
app.get('/api/channels', (req, res) => res.json(store.getChannels()));

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Order dashboard running at http://localhost:${PORT}`);
});
