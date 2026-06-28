#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code on the web environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Start PostgreSQL — systemd is not available in this container,
# so the cluster must be started manually each session.
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "Starting PostgreSQL..."
  pg_ctlcluster 16 main start
  # Wait for it to be ready (up to 15s)
  for i in $(seq 1 15); do
    pg_isready -h localhost -p 5432 -q 2>/dev/null && break
    sleep 1
  done
  echo "PostgreSQL ready."
else
  echo "PostgreSQL already running."
fi

# Install Node dependencies
echo "Installing npm dependencies..."
cd "$CLAUDE_PROJECT_DIR"
npm install

# Apply any pending Prisma migrations (non-interactive, safe for CI/remote)
echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Session start complete."
