#!/usr/bin/env bash
# WHAT CI SEES, BEFORE CI SEES IT.
#
# On 13 Sep the suites job went red three times running, and every cause was
# the same shape: a suite reading a file that exists on THIS machine and is
# not in the repo — the build sandbox's Chromium, the session scratchpad, and
# finally two label PDFs under /root/.claude/uploads. Each passed in the
# working tree and could not pass anywhere else. Running the suites where the
# untracked files are sitting cannot detect that, however carefully you look.
#
# So: clone HEAD into a temp directory, which by construction contains only
# what is committed, and run the fence and the ci tier there. node_modules is
# copied rather than installed — the risk this guards is missing FILES, not
# missing dependencies, and npm ci adds minutes for nothing.
#
#   npm run test:fresh
#
# A clean run here is the evidence that a push will be green. It is not proof
# about the runner itself (a different OS, 2 cores, no /opt/pw-browsers), so
# the ci tier is also run with TEST_CHROMIUM pointed at nothing, which is the
# closest thing to "no browser on the box" that can be arranged locally.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ cloning HEAD (committed files only) into $WORK"
git -C "$REPO" clone -q "file://$REPO" "$WORK/checkout" --branch "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
cd "$WORK/checkout"
echo "  at $(git log --oneline -1)"

if [ -d "$REPO/node_modules" ]; then
  cp -r "$REPO/node_modules" ./node_modules
else
  echo "→ no node_modules to copy; installing"
  npm ci --ignore-scripts
fi

echo
echo "→ fence (npm test)"
npm test

echo
echo "→ ci tier, with no browser available"
TEST_CHROMIUM=/nonexistent/chromium PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run test:suites

echo
echo "Fresh-checkout verification passed. This is what CI runs."
