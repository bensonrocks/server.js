'use strict';

const fs = require('fs');

const EXTRACT_PROMPT = `Extract all order or shipment information from this file. Return ONLY a raw JSON array (no markdown, no code fences, no explanation) following this exact structure for each order found:
[{
  "orderNumber": "string or null",
  "clientName": "string or null",
  "recipientName": "string or null",
  "addressLine1": "string or null",
  "addressLine2": "string or null",
  "city": "string or null",
  "state": "string or null",
  "zip": "string or null",
  "country": "2-letter code, default MY if not found",
  "courier": "string or null",
  "trackingNumber": "string or null",
  "items": [{"sku": "string", "name": "string", "qty": 1, "unitPrice": 0}],
  "notes": "string or null"
}]
If you find no extractable data, return [].`;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — set this environment variable to enable AI extraction for images, PDFs, and Word documents');
  }
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();
}

function parseJsonArray(text) {
  const t = text.trim();
  const s = t.indexOf('[');
  const e = t.lastIndexOf(']');
  if (s === -1 || e === -1) return [];
  try { return JSON.parse(t.slice(s, e + 1)); } catch {
    throw new Error('AI returned malformed JSON — please try again');
  }
}

async function extractFromImage(filePath, mimeType) {
  const client = getClient();
  const base64 = fs.readFileSync(filePath).toString('base64');
  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  });
  return parseJsonArray(msg.content[0].text);
}

async function extractFromPDF(filePath) {
  const client = getClient();
  const base64 = fs.readFileSync(filePath).toString('base64');
  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: EXTRACT_PROMPT },
      ],
    }],
  });
  return parseJsonArray(msg.content[0].text);
}

async function extractFromDocxText(text) {
  const client = getClient();
  const msg = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${EXTRACT_PROMPT}\n\nDocument content:\n${text.slice(0, 8000)}`,
    }],
  });
  return parseJsonArray(msg.content[0].text);
}

function extractFromSpreadsheet(filePath) {
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  return mapSpreadsheetRows(rows);
}

function mapSpreadsheetRows(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const norm = k => String(k).toLowerCase().replace(/[\s_\-]/g, '');
  const lk = keys.map(norm);

  const find = (...aliases) => {
    for (const alias of aliases) {
      const na = norm(alias);
      const i = lk.findIndex(k => k === na);
      if (i !== -1) return keys[i];
    }
    for (const alias of aliases) {
      const na = norm(alias);
      const i = lk.findIndex(k => k.startsWith(na) || na.startsWith(k));
      if (i !== -1) return keys[i];
    }
    return null;
  };

  const K = {
    order:     find('orderid','ordernumber','waybillno','waybill','trackingno','tracking','awbno','awb','referenceno','ref'),
    client:    find('client','clientname','company','sender','shipper'),
    recipient: find('recipient','recipientname','consignee','shipto','deliverto','receivername'),
    addr1:     find('address','addressline1','streetaddress','street'),
    addr2:     find('addressline2','unit','apartment','aptno'),
    city:      find('city','town'),
    state:     find('state','province'),
    zip:       find('zip','postalcode','postal','postcode'),
    country:   find('country'),
    courier:   find('courier','carrier','shippingcompany','shippingmethod'),
    tracking:  find('trackingnumber','trackingno'),
    sku:       find('sku','productcode','itemcode','code','barcode'),
    item:      find('itemname','productname','product','item','description','goods','commodity'),
    qty:       find('qty','quantity','pieces','pcs','noofpieces'),
    price:     find('price','unitprice','amount','value'),
    notes:     find('notes','remarks','note','comment','instruction'),
  };

  const g = (row, key) => key ? String(row[key] ?? '').trim() : '';
  const ni = (row, key) => key ? parseInt(row[key]) || 1 : 1;
  const nf = (row, key) => key ? parseFloat(row[key]) || 0 : 0;

  return rows
    .filter(r => keys.some(k => String(r[k] ?? '').trim() !== ''))
    .map(row => {
      const sku = g(row, K.sku);
      const itemName = g(row, K.item);
      return {
        orderNumber:    g(row, K.order)    || null,
        clientName:     g(row, K.client)   || null,
        recipientName:  g(row, K.recipient)|| null,
        addressLine1:   g(row, K.addr1)    || null,
        addressLine2:   g(row, K.addr2)    || null,
        city:           g(row, K.city)     || null,
        state:          g(row, K.state)    || null,
        zip:            g(row, K.zip)      || null,
        country:        g(row, K.country)  || 'MY',
        courier:        g(row, K.courier)  || null,
        trackingNumber: g(row, K.tracking) || null,
        items: [{
          sku:       sku || 'ITEM',
          name:      itemName || sku || 'Item',
          qty:       ni(row, K.qty),
          unitPrice: nf(row, K.price),
        }],
        notes: g(row, K.notes) || null,
      };
    })
    .filter(r => r.orderNumber || r.recipientName || r.trackingNumber);
}

module.exports = { extractFromImage, extractFromPDF, extractFromDocxText, extractFromSpreadsheet };
