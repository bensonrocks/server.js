'use strict';
// A small pool of worker_threads running lib/pdf-worker.js, so pdf-parse,
// pdfjs rendering and pdf-lib page splitting stop holding the request thread.
//
// Contract: every method returns the same value the in-process function
// returned, or THROWS — callers keep their own in-process implementation as
// the fallback, so a worker that cannot start (a broken native addon, a host
// without worker support) degrades to exactly what shipped before, never to
// "labels stopped importing".
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

const WORKER_FILE = path.join(__dirname, 'pdf-worker.js');
const SIZE        = Math.max(1, Math.min(4, parseInt(process.env.PDF_WORKERS || '', 10) || (os.cpus().length > 2 ? 2 : 1)));
const TASK_MS     = parseInt(process.env.PDF_WORKER_TASK_MS || '', 10) || 180000; // one op, generous for a 300-page file
const MAX_SPAWN_FAILS = 3;

class PdfPool {
  constructor() {
    this.workers  = [];          // { w, busy, current }
    this.queue    = [];          // { op, args, resolve, reject, transfer }
    this.seq      = 0;
    this.spawnFails = 0;
    this.disabled = process.env.PDF_WORKERS === '0';
    this.stats    = { done: 0, failed: 0, timedOut: 0, crashes: 0, msTotal: 0, queuedMax: 0 };
    this.caps     = null;        // what the worker reported at ping
  }

  available() { return !this.disabled && this.spawnFails < MAX_SPAWN_FAILS; }

  _spawn() {
    const slot = { w: null, busy: false, current: null };
    let w;
    try { w = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: 1536 } }); }
    catch (e) { this.spawnFails++; console.warn('[pdf-pool] worker failed to start:', e.message); return null; }
    slot.w = w;
    w.on('message', (m) => {
      const t = slot.current;
      if (!t || m.id !== t.id) return;
      clearTimeout(t.timer);
      slot.current = null; slot.busy = false;
      this.stats.msTotal += Date.now() - t.started;
      if (m.ok) { this.stats.done++; t.resolve(m.result); }
      else { this.stats.failed++; t.reject(new Error(m.error)); }
      this._pump();
    });
    const die = (why) => {
      const t = slot.current;
      this.stats.crashes++;
      this.workers = this.workers.filter(s => s !== slot);
      if (t) { clearTimeout(t.timer); slot.current = null; t.reject(new Error('pdf worker ' + why)); }
      // A worker that dies at boot (native addon) counts as a spawn failure;
      // one that dies mid-life is replaced on the next task.
      if (!this.caps) this.spawnFails++;
      this._pump();
    };
    w.on('error', (e) => die('error: ' + (e && e.message)));
    w.on('exit', (code) => { if (slot.current || this.workers.includes(slot)) die('exited ' + code); });
    this.workers.push(slot);
    return slot;
  }

  _pump() {
    if (!this.queue.length) return;
    let slot = this.workers.find(s => !s.busy);
    if (!slot && this.workers.length < SIZE) slot = this._spawn();
    if (!slot) {
      if (!this.workers.length && !this.available()) {
        // Nothing will ever run these — hand them back so callers fall back.
        for (const t of this.queue.splice(0)) t.reject(new Error('pdf worker unavailable'));
      }
      return;
    }
    const t = this.queue.shift();
    slot.busy = true; slot.current = t;
    t.started = Date.now();
    t.timer = setTimeout(() => {
      this.stats.timedOut++;
      try { slot.w.terminate(); } catch {}
    }, TASK_MS);
    try { slot.w.postMessage({ id: t.id, op: t.op, args: t.args }, t.transfer); }
    catch (e) { clearTimeout(t.timer); slot.busy = false; slot.current = null; t.reject(e); this._pump(); }
    if (this.queue.length) this._pump();
  }

  run(op, args, { transfer } = {}) {
    if (!this.available()) return Promise.reject(new Error('pdf worker unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.queue.push({ id, op, args, resolve, reject, transfer });
      this.stats.queuedMax = Math.max(this.stats.queuedMax, this.queue.length);
      this._pump();
    });
  }

  // Copy the caller's Buffer into its own ArrayBuffer and TRANSFER it (zero
  // copy across the thread boundary) — the caller's buffer is untouched.
  _pack(buffer) {
    const ab = new ArrayBuffer(buffer.length);
    new Uint8Array(ab).set(buffer);
    return { ab, transfer: [ab] };
  }

  async ping() {
    this.caps = await this.run('ping', {});
    return this.caps;
  }
  async pageTexts(buffer) {
    const { ab, transfer } = this._pack(buffer);
    return this.run('pageTexts', { buffer: ab }, { transfer });
  }
  async render(buffer, pageIndex, scale) {
    const { ab, transfer } = this._pack(buffer);
    const r = await this.run('render', { buffer: ab, pageIndex, scale }, { transfer });
    if (r && r.error) throw new Error(r.error);
    return r ? Buffer.from(r) : null;
  }
  async splitPages(buffer) {
    const { ab, transfer } = this._pack(buffer);
    const pages = await this.run('splitPages', { buffer: ab }, { transfer });
    return pages.map(p => Buffer.from(p));
  }

  snapshot() {
    return {
      enabled: this.available(), size: SIZE, alive: this.workers.length,
      busy: this.workers.filter(s => s.busy).length, queued: this.queue.length,
      caps: this.caps, ...this.stats,
      avgMs: this.stats.done ? Math.round(this.stats.msTotal / this.stats.done) : null,
    };
  }
}

module.exports = new PdfPool();
