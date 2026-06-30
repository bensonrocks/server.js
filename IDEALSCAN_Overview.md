# IDEALSCAN — System Overview

## What Problem It Solves

Warehouses receive client order files (CSV/XLSX), print picklists, physically pick items, then manually verify each order before shipping. This process is slow, error-prone, and leaves no audit trail.

IDEALSCAN replaces the manual verification workflow with a live scan system — from file upload to printed shipping label — all in one place.

---

## Features

### 1. Order Upload & Processing
Admin uploads a client order file (CSV or XLSX). The system auto-maps column headers regardless of naming convention (SKU, qty, waybill, address, platform, etc.) and outputs a WMS-format picklist ready for the warehouse management system.

**Saves:** Hours of manual reformatting per batch.

---

### 2. Live Scan Verification
Warehouse staff open an order on-screen and scan or type each item barcode. The system tracks quantity scanned vs. quantity expected and delivers an instant verdict:

- **READY TO SHIP** — all quantities match
- **NEEDS REVIEW** — mismatch flagged in red

A timer records how long each order took from first scan to completion.

**Saves:** Manual tally sheets, counting errors, and mis-picks reaching the customer.

---

### 3. Waybill Scan Bar
Staff scan the waybill barcode on a shipping label and are taken directly to that order's scan screen — no searching through a list of 40+ orders.

**Saves:** 30–60 seconds per order × hundreds of orders per day.

---

### 4. Full Delivery Info On-Screen
During scanning, staff see the buyer's full name, complete delivery address, phone number, and platform (Shopee, Lazada, etc.) so they can verify the right parcel is going to the right person before it leaves the warehouse.

**Saves:** Wrong-address shipments and customer complaints.

---

### 5. Waybill Label Printing
After an order is fully verified correct, the system prompts to print a shipping label. The label includes:

- Carrier name as header (defaults to **IDEALOMS** if unspecified)
- Buyer name and full delivery address
- Phone number
- Items and quantities
- Platform/channel
- CODE128 barcode of the waybill number (large, scanner-friendly)

The prompt auto-dismisses after 3 seconds if no action is taken. Labels can be reprinted anytime from completed order cards.

**Saves:** Designing labels manually and switching between systems.

---

### 6. Per-User Printer Settings
Each user at each workstation can configure their own printer name and preferred label size (100×160 mm, 100×150 mm, or 4"×6"). Settings are saved per account so print jobs always target the correct printer for that station.

**Saves:** Printing to the wrong printer and reprinting waste.

---

### 7. Admin Panel
Accessible to admin-role users only. Includes:

- **Upload History** — every batch with filename, operator, client, date, and order count
- **User Management** — create and delete accounts, assign warehouse or admin roles
- **WMS Template** — customise output column mapping
- **Email** — configure SMTP for notifications
- **System** — export full audit trail (operator, scan times, quantities) as XLSX; reset data

**Saves:** Manual logging, compliance preparation, and audit requests.

---

### 8. Role-Based Access
| Role | Access |
|---|---|
| **Admin** | Upload, manage users, export audit trail, all settings |
| **Warehouse** | Orders view and scanning only — no admin functions visible |

**Saves:** Training errors and accidental data changes by floor staff.

---

### 9. Data Persistence
All data — users, order batches, scan history — is stored on a persistent volume and survives server restarts and redeployments. In-progress batches are never lost.

**Saves:** Loss of work on every server update.

---

## Real-World Impact Summary

| Area | Before IDEALSCAN | After IDEALSCAN |
|---|---|---|
| Order file preparation | Manual reformatting per client | Auto-mapped in seconds |
| Pick verification | Paper tally sheets | Live scan with instant verdict |
| Finding an order | Scroll through a list | Scan the waybill barcode |
| Label printing | Manual or separate system | One click after verification |
| Delivery address visibility | Not visible during scanning | Full address shown on screen |
| Audit trail | None or manual spreadsheet | Auto-captured, exportable XLSX |
| Multi-station printing | Common mis-routing | Per-user printer profile |
| Data loss on redeploy | Every time | Persistent volume storage |

---

## User Roles

| Account | Role | What They Do |
|---|---|---|
| Admin | Admin | Uploads files, manages users, exports reports |
| Warehouse Staff | Warehouse | Scans orders, prints labels |

---

*IDEALSCAN — Fulfillment Scanning System*
