#!/usr/bin/env node
// REFERENCE recorder agent for IdealOne Surveillance clips — runs on the
// WAREHOUSE PC next to the OBS recordings. Node 18+ and ffmpeg on PATH; no npm
// packages. Full recordings never leave this PC: it only cuts the requested
// window (pack start − pad … end + pad) and uploads that small MP4.
//
//   IDEALONE_URL=https://<your idealone> RECORDER_KEY=<key> RECORDINGS_DIR="D:\OBS" \
//     node surveillance-recorder-agent.js            # poll every 15 s
//     node surveillance-recorder-agent.js --once     # one pass, then exit
//
// API (all with header X-Recorder-Key):
//   GET  /api/public/surveillance/agent/clips             → { clips:[{id, fileName, folder, seekSec, durationSec}], maxMB }
//   POST /api/public/surveillance/agent/clips/:id/upload  (body: the MP4 bytes, Content-Type video/mp4)
//   POST /api/public/surveillance/agent/clips/:id/poster  (optional JPEG frame, image/jpeg)
//   POST /api/public/surveillance/agent/clips/:id/fail    { reason }
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const URL_ = (process.env.IDEALONE_URL || '').replace(/\/$/, '');
const KEY = process.env.RECORDER_KEY || '';
const DIRS = String(process.env.RECORDINGS_DIR || '.').split(path.delimiter).filter(Boolean);
const EVERY = Number(process.env.POLL_SECONDS || 15) * 1000;
const H = { 'X-Recorder-Key': KEY };
if (!URL_ || !KEY) { console.error('Set IDEALONE_URL and RECORDER_KEY'); process.exit(2); }

function findFile(c) {
  const cands = [c.folder && path.join(c.folder, c.fileName), ...DIRS.map(d => path.join(d, c.fileName))].filter(Boolean);
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
function cut(src, seek, dur, out) {
  // Re-encode (not -c copy) so the clip starts exactly at the seek point and
  // stays small: 540p H.264, CRF 28, AAC audio if present.
  const args = ['-v', 'error', '-y', '-ss', String(Math.max(0, seek)), '-i', src, '-t', String(Math.max(1, dur)),
    '-vf', 'scale=-2:min(540\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out];
  return new Promise((ok, bad) => execFile('ffmpeg', args, { timeout: 10 * 60000 }, (e, _o, err) => e ? bad(new Error((err || e.message).trim().slice(-300))) : ok()));
}
async function fail(id, reason) {
  await fetch(`${URL_}/api/public/surveillance/agent/clips/${id}/fail`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  console.log(`[clip ${id}] FAILED: ${reason}`);
}
async function pass() {
  const r = await fetch(`${URL_}/api/public/surveillance/agent/clips`, { headers: H });
  if (!r.ok) throw new Error(`poll ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const { clips, maxMB } = await r.json();
  for (const c of clips) {
    const src = findFile(c);
    if (!src) { await fail(c.id, `Recording not found on this PC: ${c.fileName}`); continue; }
    const out = path.join(os.tmpdir(), `idealone-clip-${c.id}.mp4`);
    try {
      await cut(src, c.seekSec, c.durationSec, out);
      const buf = fs.readFileSync(out);
      if (buf.length > maxMB * 1048576) { await fail(c.id, `Clip is ${(buf.length / 1048576).toFixed(1)} MB, over the ${maxMB} MB cap`); continue; }
      // Poster: a frame at the moment packing starts (seek + pad), best effort.
      const jpg = out.replace(/\.mp4$/, '.jpg');
      await new Promise(ok => execFile('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.min(c.padBeforeSec || 0, Math.max(0, c.durationSec - 1))), '-i', out, '-frames:v', '1', '-q:v', '4', jpg], () => ok()));
      const u = await fetch(`${URL_}/api/public/surveillance/agent/clips/${c.id}/upload`, { method: 'POST', headers: { ...H, 'Content-Type': 'video/mp4' }, body: buf });
      const j = await u.json().catch(() => ({}));
      if (!u.ok) throw new Error(`upload ${u.status}: ${j.error || ''}`);
      try { if (fs.existsSync(jpg)) await fetch(`${URL_}/api/public/surveillance/agent/clips/${c.id}/poster`, { method: 'POST', headers: { ...H, 'Content-Type': 'image/jpeg' }, body: fs.readFileSync(jpg) }); } catch {}
      try { fs.unlinkSync(jpg); } catch {}
      console.log(`[clip ${c.id}] ${c.order}: uploaded ${(buf.length / 1024).toFixed(0)} KB from ${path.basename(src)} @${c.seekSec}s +${c.durationSec}s`);
    } catch (e) { await fail(c.id, String(e.message || e)); }
    finally { try { fs.unlinkSync(out); } catch {} }
  }
  return clips.length;
}
(async () => {
  if (process.argv.includes('--once')) { const n = await pass(); console.log(`done, ${n} clip(s)`); return; }
  for (;;) { try { await pass(); } catch (e) { console.error(new Date().toISOString(), e.message); } await new Promise(r => setTimeout(r, EVERY)); }
})().catch(e => { console.error(e.message); process.exit(1); });
