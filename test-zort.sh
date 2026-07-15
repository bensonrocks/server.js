#!/bin/bash

# ZORT Integration Test Suite
# Usage: ./test-zort.sh [server-url] [tenant-id]

SERVER="${1:-http://localhost:3000}"
TENANT="${2:-default}"
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${COLOR_BLUE}=== ZORT Integration Test Suite ===${NC}\n"

# Credentials
CREDS='{
  "storeName": "bensonscottlee@gmail.com",
  "storename": "bensonscottlee@gmail.com",
  "apikey": "CgGeCuccHSlLyfvylquf2BHilySUJn4lgHEQhqXV0=",
  "apisecret": "VZJM3P4gwUu5BgPQeAtO/4SGrkr0EKT6YnbUeMbHV4="
}'

# Test 1: Save Credentials
echo -e "${COLOR_BLUE}TEST 1: Save ZORT Credentials${NC}"
RESULT=$(curl -s -X POST "$SERVER/api/connect/zort" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT" \
  -d "$CREDS")
if echo "$RESULT" | grep -q "ok\|success\|storeName"; then
  echo -e "${COLOR_GREEN}✅ Credentials saved${NC}"
else
  echo -e "${COLOR_RED}❌ Failed to save credentials${NC}"
  echo "$RESULT"
fi
echo ""

# Test 2: Check Connection Status
echo -e "${COLOR_BLUE}TEST 2: Check ZORT Connection Status${NC}"
RESULT=$(curl -s -X GET "$SERVER/api/connect/status" \
  -H "x-tenant-id: $TENANT")
if echo "$RESULT" | grep -q "zort"; then
  echo -e "${COLOR_GREEN}✅ Connection status retrieved${NC}"
  echo "$RESULT" | grep zort || echo "$RESULT"
else
  echo -e "${COLOR_RED}❌ Failed to get connection status${NC}"
  echo "$RESULT"
fi
echo ""

# Test 3: Fetch Orders
echo -e "${COLOR_BLUE}TEST 3: Fetch Orders from ZORT${NC}"
RESULT=$(curl -s -X POST "$SERVER/api/sync/zort" \
  -H "x-tenant-id: $TENANT")
if echo "$RESULT" | grep -q "ok\|orders\|data"; then
  echo -e "${COLOR_GREEN}✅ Orders fetched${NC}"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null | head -20 || echo "$RESULT"
else
  echo -e "${COLOR_RED}❌ Failed to fetch orders${NC}"
  echo "$RESULT"
fi
echo ""

# Test 4: Pull Inventory
echo -e "${COLOR_BLUE}TEST 4: Pull Inventory from ZORT${NC}"
RESULT=$(curl -s -X POST "$SERVER/api/connect/zort/inventory/pull" \
  -H "x-tenant-id: $TENANT")
if echo "$RESULT" | grep -q "ok\|fetched\|updated"; then
  echo -e "${COLOR_GREEN}✅ Inventory pulled${NC}"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo -e "${COLOR_RED}❌ Failed to pull inventory${NC}"
  echo "$RESULT"
fi
echo ""

# Test 5: Fetch Products
echo -e "${COLOR_BLUE}TEST 5: Sync Products to OMS${NC}"
RESULT=$(curl -s -X POST "$SERVER/api/connect/zort/products/sync" \
  -H "x-tenant-id: $TENANT")
if echo "$RESULT" | grep -q "ok\|count\|fetched"; then
  echo -e "${COLOR_GREEN}✅ Products synced${NC}"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
else
  echo -e "${COLOR_RED}❌ Failed to sync products${NC}"
  echo "$RESULT"
fi
echo ""

# Test 6: Fetch Customers
echo -e "${COLOR_BLUE}TEST 6: Fetch Customers from ZORT${NC}"
RESULT=$(curl -s -X GET "$SERVER/api/connect/zort/customers" \
  -H "x-tenant-id: $TENANT")
if echo "$RESULT" | grep -q "ok\|data\|name"; then
  echo -e "${COLOR_GREEN}✅ Customers fetched${NC}"
  echo "$RESULT" | python3 -m json.tool 2>/dev/null | head -20 || echo "$RESULT"
else
  echo -e "${COLOR_RED}❌ Failed to fetch customers${NC}"
  echo "$RESULT"
fi
echo ""

echo -e "${COLOR_BLUE}=== All tests complete ===${NC}"
