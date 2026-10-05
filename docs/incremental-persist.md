# Incremental db.json persist

Default **off**. Production keeps today's full `JSON.stringify` + atomic rewrite of the hot tenant `db.json` until this is turned on.

The freeze under concurrent scanning is that rewrite: every persist walks the whole in-memory hot database on the Node request thread. Debounce (fewer rewrites) and hot/cold archive (a smaller hot file) do not change that shape. With the flag on, a scan re-stringifies the one order state that changed (and an audit-log append, if the scan wrote one) and streams the already-built JSON for everything else. The file on disk stays ordinary `db.json`.

Cold shards under `archive/cold/` are not part of the hot object and are not written by this path.

## Enable

On the Railway service (or any process environment):

```
DB_INCREMENTAL_PERSIST=on
```

Accepted on-values: `1`, `on`, `true`, `yes` (any case). Restart the service so every process sees it. Confirm on `GET /api/version` → `db.incrementalEnabled: true`, and after the first save `db.mode` is `rebuild` (that first save still stringifies the whole hot file into fragments) and later scan saves show `db.mode: "incremental"` with `stringifiedBytes` far below `bytes`.

Optional:

```
DB_INCREMENTAL_REBUILD_MS=600000
```

Safety rebuild interval in milliseconds. Default 10 minutes. A rebuild pays one full stringify, then fragments are trusted again. Set `0` to disable periodic rebuilds (the first save after boot still builds fragments).

Do not change `HOT_COLD_*`, store modes, or anything else to turn this on.

## Disable / rollback

Either is enough:

1. Unset `DB_INCREMENTAL_PERSIST`, or set it to `off`, `0`, `false`, or `no`, and restart. The next save is the legacy full rewrite. No migration, no file-format change.
2. Revert the pull request.

In-flight scans stay covered by the scan journal (`scan-journal.ndjson`), which is unchanged. The offline scan queue is unchanged.

## What 10 scanners should see

Each barcode count still mutates the in-memory order and appends the scan journal immediately. The debounced save (scan-rate window, about 1s after the last scan and at most 6s) no longer walks the ~95 MB hot file on the thread. Handlers for the other nine users keep running during that save: assembly of a scan is one small `JSON.stringify`, and the disk copy yields the event loop about once per megabyte.

A completion is a normal save (shorter debounce) and uses the same incremental assembly.

The first save after boot, a save after the in-memory database object is replaced, and the periodic rebuild still stringify the whole hot file once. Those are the moments a multi-second stall can still happen.

## Residual limits

- One Node process and one volume. Ten users share one event loop and one disk. This removes the shared full-file stringify from the scan hot path; it does not add replicas.
- The ~95 MB file is still written (atomically, via a temp file and rename). Disk IO remains. The copy yields so request handlers can run between slices.
- Fragment buffers hold another copy of the hot JSON in RAM. On an 8 GB service that is acceptable; watch memory after enabling.
- A mutation that never goes through the tracked object (for example writing a nested value taken from `Object.getOwnPropertyDescriptor`) is healed by the next full rebuild, not by the next scan save.
- Crash window: the journal still covers counted scans between saves. `flushDb()` and SIGTERM still flush immediately and wait until the rename finishes.

## Where to look

`lib/incremental-persist.js` builds the fragments. `server.js` `_persistDb` calls it only when the flag is on, and falls back to `JSON.stringify` of the hot cache if assembly throws. `readDb` returns a tracking proxy only when the flag is on.
