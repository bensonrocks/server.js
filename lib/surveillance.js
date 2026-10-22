'use strict';
// ── SURVEILLANCE — packing-station video lookup (OFF by default) ────────────
// Isolated sub-function: its own JSON file in DATA_DIR, no hooks into the
// scan / packing paths. It only READS order scan states. No video is stored
// here — a local recorder agent registers file NAMES + times, and IdealOne
// tells you which file to open and where to seek.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let FILE = null;
function init(dataDir) { FILE = path.join(dataDir, 'surveillance.json'); return module.exports; }

function defaults() {
  return { enabled: false, grantedUsers: [], recorderKey: '', padBeforeSec: 30, padAfterSec: 30,
           cameras: [], recordings: [] };
}
function load() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return defaults(); }
}
function save(cfg) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, FILE);
}

// rtsp://user:pass@host/... → split so the password never leaves the server.
function splitRtsp(url) {
  try {
    const u = new URL(String(url));
    const user = decodeURIComponent(u.username || ''), pass = decodeURIComponent(u.password || '');
    u.username = ''; u.password = '';
    return { url: u.toString(), user, pass };
  } catch { return { url: String(url || ''), user: '', pass: '' }; }
}
function maskRtsp(cam) {
  if (!cam.rtspUrl) return '';
  try {
    const u = new URL(cam.rtspUrl);
    if (cam.rtspUser) { u.username = encodeURIComponent(cam.rtspUser); if (cam.rtspPass) u.password = '****'; }
    return u.toString();
  } catch { return cam.rtspUrl; }
}
function publicCamera(cam) {
  const { rtspPass, revealPending, ...rest } = cam;
  return { ...rest, rtspUrl: maskRtsp(cam), hasPassword: !!rtspPass, canReveal: !!revealPending };
}
function upsertCamera(cfg, body) {
  const b = body || {};
  const existing = b.id ? cfg.cameras.find(c => c.id === b.id) : null;
  const cam = existing || { id: crypto.randomUUID() };
  if (b.name !== undefined) cam.name = String(b.name).slice(0, 80);
  if (b.station !== undefined) cam.station = String(b.station).slice(0, 80);
  if (b.rtspUrl !== undefined) {
    const s = splitRtsp(b.rtspUrl);
    cam.rtspUrl = s.url;
    if (s.user) cam.rtspUser = s.user;
    // A masked "****" coming back from the UI keeps the stored password.
    if (s.pass && s.pass !== '****') cam.rtspPass = s.pass;
  }
  if (b.rtspUser !== undefined) cam.rtspUser = String(b.rtspUser);
  if (b.rtspPass) cam.rtspPass = String(b.rtspPass);
  if (b.folder !== undefined) cam.folder = String(b.folder).slice(0, 300);
  if (b.filePattern !== undefined) cam.filePattern = String(b.filePattern).slice(0, 80);
  if (b.tz !== undefined) cam.tz = String(b.tz).slice(0, 6);
  if (b.clockOffsetSec !== undefined) cam.clockOffsetSec = Number(b.clockOffsetSec) || 0;
  if (!cam.filePattern) cam.filePattern = 'YYYY-MM-DD HH-mm-ss';
  if (!cam.tz) cam.tz = '+08:00';
  if (cam.clockOffsetSec === undefined) cam.clockOffsetSec = 0;
  if (!existing) cfg.cameras.push(cam);
  return cam;
}

// Parse a start time out of a file name using YYYY MM DD HH mm ss tokens
// (OBS default "2026-10-22 10-55-00.mkv" → 'YYYY-MM-DD HH-mm-ss').
function parseFileTime(fileName, pattern, tz) {
  const toks = { YYYY: '(\\d{4})', MM: '(\\d{2})', DD: '(\\d{2})', HH: '(\\d{2})', mm: '(\\d{2})', ss: '(\\d{2})' };
  const order = [];
  const re = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/YYYY|MM|DD|HH|mm|ss/g, t => { order.push(t); return toks[t]; });
  const m = String(fileName).match(new RegExp(re));
  if (!m) return null;
  const v = {}; order.forEach((t, i) => { v[t] = m[i + 1]; });
  const d = new Date(`${v.YYYY}-${v.MM}-${v.DD}T${v.HH || '00'}:${v.mm || '00'}:${v.ss || '00'}${tz || '+08:00'}`);
  return isNaN(d) ? null : d.toISOString();
}

function registerRecording(cfg, body) {
  const b = body || {};
  const fileName = String(b.fileName || '').trim();
  const station = String(b.station || '').trim();
  if (!fileName || !station) return { error: 'fileName and station are required' };
  const cam = cfg.cameras.find(c => c.station === station || c.name === station || c.id === b.cameraId);
  let startTime = b.startTime ? new Date(b.startTime) : null;
  if (!startTime || isNaN(startTime)) {
    const p = cam ? parseFileTime(fileName, cam.filePattern, cam.tz) : null;
    startTime = p ? new Date(p) : null;
  }
  if (!startTime) return { error: 'startTime missing and could not be parsed from fileName' };
  const durationSec = Math.max(0, Number(b.durationSec) || 0);
  const rec = { id: crypto.randomUUID(), fileName: fileName.slice(0, 300), station,
    cameraId: cam ? cam.id : null, folder: String(b.folder || (cam && cam.folder) || '').slice(0, 300),
    startTime: startTime.toISOString(), durationSec, registeredAt: new Date().toISOString() };
  // Same file re-registered (e.g. duration updated when OBS stops) replaces.
  cfg.recordings = cfg.recordings.filter(r => !(r.fileName === rec.fileName && r.station === station));
  cfg.recordings.push(rec);
  if (cfg.recordings.length > 20000) cfg.recordings = cfg.recordings.slice(-20000);
  return { recording: rec };
}


// ── Quick add: brand presets → RTSP URL ─────────────────────────────────────
const PRESETS = {
  tapo:      { label: 'TP-Link Tapo', path: { hd: '/stream1', sd: '/stream2' } },
  hikvision: { label: 'Hikvision',    path: { hd: '/Streaming/Channels/101', sd: '/Streaming/Channels/102' } },
  dahua:     { label: 'Dahua',        path: { hd: '/cam/realmonitor?channel=1&subtype=0', sd: '/cam/realmonitor?channel=1&subtype=1' } },
};
// OBS: Settings › Advanced › Recording › Filename Formatting → matches the
// default camera filePattern 'YYYY-MM-DD HH-mm-ss'.
const OBS_FILENAME_FORMAT = '%CCYY-%MM-%DD %hh-%mm-%ss';
function validIPv4(ip) {
  const p = String(ip || '').trim().split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255 && String(Number(x)) === x);
}
function buildRtspUrl({ brand = 'tapo', ip, port = 554, user, pass, quality = 'hd' } = {}) {
  const pre = PRESETS[brand];
  if (!pre) return { error: 'Unknown brand preset — use Custom RTSP URL' };
  if (!validIPv4(ip)) return { error: 'Camera IP must look like 192.168.1.50' };
  const pt = Number(port);
  if (!Number.isInteger(pt) || pt < 1 || pt > 65535) return { error: 'Port must be 1–65535' };
  if (!user || !pass) return { error: 'Camera account username and password are required' };
  const q = quality === 'sd' ? 'sd' : 'hd';
  const base = `rtsp://${String(ip).trim()}:${pt}${pre.path[q]}`;
  const full = `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${String(ip).trim()}:${pt}${pre.path[q]}`;
  return { url: full, base, quality: q };
}
function fullRtsp(cam) {
  try {
    const u = new URL(cam.rtspUrl);
    if (cam.rtspUser) u.username = encodeURIComponent(cam.rtspUser);
    if (cam.rtspPass) u.password = encodeURIComponent(cam.rtspPass);
    return u.toString();
  } catch { return cam.rtspUrl || ''; }
}

const norm = s => String(s || '').trim().toUpperCase();
// Read-only search of order scan states across batches.
function findOrders(db, q, userName) {
  const Q = norm(q); if (!Q) return [];
  const out = [];
  for (const b of (db.batches || [])) {
    const states = b.orderStates || {};
    for (const o of (b.orders || [])) {
      const keys = [o.order_number, o.waybill_number, o.tracking_number, o.gi_no, o.gi_number, o.reference];
      if (!keys.some(k => norm(k) === Q)) continue;
      const st = states[o.order_number] || {};
      out.push({ order: o.order_number, waybill: o.waybill_number || '', client: b.client_name || '',
        operator: st.operator || '', operatorName: userName(st.operator) || '',
        status: st.status || 'pending', startTime: st.startTime || null, endTime: st.endTime || null });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function stationCameras(cfg, hit) {
  const ids = [norm(hit.operator), norm(hit.operatorName)].filter(Boolean);
  return cfg.cameras.filter(c => ids.includes(norm(c.station)));
}

function matchVideo(cfg, hit) {
  const padB = Number(cfg.padBeforeSec) || 0, padA = Number(cfg.padAfterSec) || 0;
  const base = { ...hit, padBeforeSec: padB, padAfterSec: padA, videos: [] };
  if (!hit.startTime) return base;
  const s = new Date(hit.startTime).getTime();
  const e = new Date(hit.endTime || hit.startTime).getTime();
  base.windowStart = new Date(s - padB * 1000).toISOString();
  base.windowEnd = new Date(e + padA * 1000).toISOString();
  const cams = stationCameras(cfg, hit);
  base.cameras = cams.map(c => c.name);
  for (const cam of cams) {
    for (const r of cfg.recordings) {
      if (r.station !== cam.station && r.cameraId !== cam.id) continue;
      // Recorder clock correction: positive offset = camera clock runs ahead.
      const rs = new Date(r.startTime).getTime() - (cam.clockOffsetSec || 0) * 1000;
      const re = rs + (r.durationSec || 0) * 1000;
      if (s >= rs && (r.durationSec ? s <= re : true)) {
        const seek = Math.max(0, Math.round((s - padB * 1000 - rs) / 1000));
        base.videos.push({ camera: cam.name, fileName: r.fileName, folder: r.folder,
          recordingStart: r.startTime, seekSec: seek, seekHms: hms(seek),
          clipLengthSec: Math.round((e - s) / 1000) + padB + padA });
      }
    }
  }
  // Prefer the most recently started recording that contains the order.
  base.videos.sort((a, b) => b.recordingStart.localeCompare(a.recordingStart));
  return base;
}
function hms(n) { const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
  return [h, m, s].map(x => String(x).padStart(2, '0')).join(':'); }

function safeEq(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

module.exports = { init, load, save, defaults, splitRtsp, maskRtsp, publicCamera, upsertCamera,
  parseFileTime, registerRecording, PRESETS, OBS_FILENAME_FORMAT, validIPv4, buildRtspUrl, fullRtsp, findOrders, matchVideo, hms, safeEq };
