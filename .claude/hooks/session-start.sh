#!/bin/bash

# Only run in remote Claude Code on the web environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

log()  { echo "[session-start] $*"; }
warn() { echo "[session-start] WARN: $*" >&2; }
fail() { echo "[session-start] ERROR: $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Start PostgreSQL
#    systemd is not the init system in this container, so we must start
#    pg_ctlcluster directly. After an unclean shutdown (container kill),
#    the PID file may be stale and WAL recovery adds a few seconds.
# ---------------------------------------------------------------------------
if pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  log "PostgreSQL already running."
else
  log "Starting PostgreSQL..."

  # Clean up a stale PID file left behind by an unclean shutdown
  PGPID="/var/run/postgresql/16-main.pid"
  if [ -f "$PGPID" ] && ! kill -0 "$(cat "$PGPID" 2>/dev/null)" 2>/dev/null; then
    log "Removing stale PID file."
    rm -f "$PGPID"
  fi

  # Start the cluster (may print a warning about stale files — that's fine)
  pg_ctlcluster 16 main start 2>&1 || true

  # Wait up to 30 s — unclean shutdowns trigger WAL recovery which takes time
  READY=false
  for i in $(seq 1 30); do
    if pg_isready -h localhost -p 5432 -q 2>/dev/null; then
      READY=true
      break
    fi
    sleep 1
  done

  if [ "$READY" = "true" ]; then
    log "PostgreSQL ready."
  else
    fail "PostgreSQL did not become ready within 30 seconds."
    pg_lsclusters
    tail -20 /var/log/postgresql/postgresql-16-main.log >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. Install Node dependencies
# ---------------------------------------------------------------------------
log "Installing npm dependencies..."
cd "$CLAUDE_PROJECT_DIR"

if ! npm install 2>&1; then
  warn "npm install failed on first attempt, retrying..."
  if ! npm install 2>&1; then
    fail "npm install failed after retry. Continuing anyway."
  fi
fi
log "npm install done."

# ---------------------------------------------------------------------------
# 3. Apply any pending Prisma migrations
# ---------------------------------------------------------------------------
log "Applying Prisma migrations..."
if npx prisma migrate deploy 2>&1; then
  log "Migrations up to date."
else
  fail "prisma migrate deploy failed — check DATABASE_URL and schema."
fi

log "Session start complete."
