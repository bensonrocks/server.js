# IDEALSCAN — Project Notes for Claude

## OCR Parsing Rules (lib/ocr-parse.js)

### Location codes must NEVER become SKUs
Warehouse bin/location codes like `AB-005001-A`, `AB-006-001-B`, `BC-003-035`, `AC-007-003-B`
look like product codes but are shelf positions. The pattern is:
- 1–3 letter prefix
- 1–3 hyphen-separated digit groups (2–6 digits each)
- optional hyphen + 1–2 letter suffix

`LOCATION_CODE_PAT = /^[A-Z]{1,3}(-\d{2,6}){1,3}(-[A-Z]{1,2})?$/i`

This is checked and skipped **before** any token is accepted as a SKU. Do not narrow this pattern.

### S/5 OCR confusion in order numbers
OCR frequently misreads the letter `S` as the digit `5` (and similarly O→0, B→8, G→6, I→1).
When an extracted order number is **7 or more all-digit characters**, apply `fixOcrLeadingChar()`
which substitutes the leading digit for its letter equivalent:
- `5` → `S`
- `0` → `O`
- `8` → `B`
- `6` → `G`
- `1` → `I`

Example: `500037495` (9 all-digit chars) → `S00037495`

This is applied after both the inline and two-line order number extraction paths.

## Git

- Branch: `claude/order-processing-wms-fulfillment-6mf8o4`
- Commit suffix required:
  ```
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DuieZfw6EN7FaZSYKtjtbV
  ```
- Never push to any other branch without explicit permission
- Never skip hooks (--no-verify)
- Do NOT create a pull request unless explicitly asked

## Auth

- Master key: `process.env.MASTER_KEY || '201432547E'`
- User auth: `x-auth-token` header checked against `activeSessions` Map
- Admin routes use `checkMaster(req, res)`
