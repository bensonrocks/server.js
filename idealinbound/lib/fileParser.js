'use strict';

// ASN/PO file ingestion — XLSX/CSV column auto-detection, best-effort PDF
// line parsing. Fails loudly (throws) rather than silently importing a
// partial or wrong manifest — the caller must show the error and let the
// operator fix the file or fall back to manual entry.

const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');
const { Readable } = require('stream');

const HEADER_ALIASES = {
  sku:         ['sku', 'item sku', 'product sku', 'item code', 'product code', 'code'],
  description: ['description', 'desc', 'item name', 'product name', 'name'],
  qty:         ['qty', 'quantity', 'expected qty', 'expected quantity', 'order qty'],
};

async function parseSpreadsheet(buffer, kind) {
  const wb = new ExcelJS.Workbook();
  if (kind === 'csv') {
    await wb.csv.read(Readable.from(buffer));
  } else {
    await wb.xlsx.load(buffer);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in file.');

  let headerRowNum = null;
  let colMap = {};
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const map = {};
    row.eachCell((cell, colNum) => {
      const val = String(cell.value ?? '').trim().toLowerCase();
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.includes(val)) map[field] = colNum;
      }
    });
    if (map.sku && map.qty) { headerRowNum = r; colMap = map; break; }
  }
  if (!headerRowNum) {
    throw new Error('Could not find SKU/Qty columns — expected a header row with columns like SKU, Description, Qty.');
  }

  const lines = [];
  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = String(row.getCell(colMap.sku).value ?? '').trim();
    if (!sku) continue;
    const qty = Number(row.getCell(colMap.qty).value) || 0;
    if (qty <= 0) continue;
    const description = colMap.description ? String(row.getCell(colMap.description).value ?? '').trim() : '';
    lines.push({ sku, description, expectedQty: qty });
  }
  if (!lines.length) throw new Error('No SKU/Qty lines found below the header row.');
  return lines;
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  let text;
  try {
    text = (await parser.getText()).text || '';
  } finally {
    await parser.destroy();
  }

  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (!/^[A-Z0-9][A-Z0-9_-]{2,}$/i.test(first)) continue;
    if (!/^\d+$/.test(last)) continue;
    const qty = Number(last);
    if (qty <= 0) continue;
    lines.push({ sku: first, description: tokens.slice(1, -1).join(' '), expectedQty: qty });
  }
  if (!lines.length) {
    throw new Error('Could not find any SKU/Qty lines in this PDF — try XLSX or CSV instead.');
  }
  return lines;
}

async function parseInboundFile(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') return parseSpreadsheet(buffer, 'csv');
  if (ext === 'xlsx' || ext === 'xls') return parseSpreadsheet(buffer, 'xlsx');
  if (ext === 'pdf') return parsePdf(buffer);
  throw new Error('Unsupported file type — upload an XLSX, CSV, or PDF.');
}

// Non-blocking — flags ambiguous duplicate SKU lines without merging or
// rejecting them, so an operator can judge intent (split pick vs. mistake).
function findDuplicateLineWarnings(lines) {
  const bySku = new Map();
  for (const l of lines) {
    const key = l.sku.toLowerCase();
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(l);
  }
  const warnings = [];
  for (const group of bySku.values()) {
    if (group.length > 1) {
      const combined = group.reduce((a, l) => a + l.expectedQty, 0);
      warnings.push(`SKU ${group[0].sku} appears ${group.length} times in this file — combined qty is ${combined}.`);
    }
  }
  return warnings;
}

module.exports = { parseInboundFile, findDuplicateLineWarnings };
