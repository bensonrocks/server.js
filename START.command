#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  ============================"
echo "    Order Dashboard"
echo "  ============================"
echo ""

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Download it from https://nodejs.org then run this again."
  exit 1
fi

echo "  Installing dependencies..."
npm install --quiet

echo "  Starting server..."
echo ""

# Show local IP for phone access
IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$IP" ]; then
  echo "  On your phone, open Chrome and go to:"
  echo "    http://$IP:3000"
  echo ""
fi

echo "  (Press Ctrl+C to stop)"
echo ""

node server.js
