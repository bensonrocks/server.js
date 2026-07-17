#!/bin/bash

# IdealScan → IdealOMS Migration Script
# Complete end-to-end migration in 3 steps

set -e

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║  IdealScan → IdealOMS Migration Tool               ║"
echo "║  Safe, reversible, 3-step process                  ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# Step 1: Backup
echo "🔒 Step 1: Create Backup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="data/idealoms_backup_${TIMESTAMP}.db"

if [ -f "data/idealoms.db" ]; then
  cp data/idealoms.db "$BACKUP_FILE"
  echo "✅ Backup created: $BACKUP_FILE"
  echo "   (Rollback available if needed)"
else
  echo "⚠️  No IdealScan database found (data/idealoms.db)"
  echo "   Migration may use seeded data instead"
fi

echo ""
echo "📂 Step 2: Export & Transform Data"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Create migration directory
mkdir -p data/migration

# Export
echo "📤 Exporting from IdealScan..."
node migration/export.js

# Transform
echo ""
echo "🔄 Transforming to IdealOMS schema..."
node migration/transform.js

echo ""
echo "🚀 Step 3: Import to IdealOMS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⏳ Starting IdealOMS server..."
echo "   (Make sure no other server is running on port 3000)"
echo ""

# Check if server is already running
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "✓ Server already running on port 3000"
else
  echo "Starting server... (will run in background)"
  PORT=3000 node server.js > /tmp/idealoms_migration.log 2>&1 &
  SERVER_PID=$!
  echo "  Server PID: $SERVER_PID"
  sleep 3
fi

# Import
echo ""
node migration/import.js

IMPORT_STATUS=$?

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║  Migration Complete!                               ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

if [ $IMPORT_STATUS -eq 0 ]; then
  echo "✅ SUCCESS: All orders imported"
  echo ""
  echo "📋 Next Steps:"
  echo "   1. Verify data in IdealOMS dashboard"
  echo "   2. Test picking wave workflow"
  echo "   3. Train staff on new interface"
  echo "   4. Schedule cutover"
  echo ""
  echo "📄 Report: data/migration/import_report.json"
  echo "🔒 Backup: $BACKUP_FILE"
  echo ""
else
  echo "⚠️  PARTIAL SUCCESS: Some orders failed"
  echo ""
  echo "📋 Review:"
  echo "   - Check data/migration/import_report.json"
  echo "   - See which orders failed and why"
  echo "   - Fix issues and retry"
  echo ""
  echo "🔒 Backup available: $BACKUP_FILE"
  echo ""
fi

# Cleanup
echo "📚 Documentation:"
echo "   - Read: MIGRATION_GUIDE_IDEALSCAN_TO_IDEALOMS.md"
echo "   - Contains: Full runbooks, troubleshooting, rollback procedures"
echo ""
