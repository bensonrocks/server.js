# Improvement log — one entry per Sunday

Baseline, 10 Sep 2026 (before Week 1):

| Measure | Value |
|---|---|
| `server.js` lines | 30,700 |
| Tests running in CI | 1 suite, 6 checks |
| Tests outside the repo | roughly 20 suites, several hundred checks |
| db.json write cost | measured from this week; read it off the Health Check |
| Response p99 (Railway, 7d) | 20 s spikes every few minutes |
| Egress | 40–80 MB bursts, uncompressed (fixed 10 Sep: gzip/brotli) |
