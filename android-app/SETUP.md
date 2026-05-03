# Order Dashboard — Android App

React Native app that connects to the Node.js order server and gives admins a native mobile interface.

## Screens

| Screen | Description |
|---|---|
| **Dashboard** | Stats cards, client/channel/status filters, live search, order list |
| **Order Detail** | Full order info — items, totals, shipping, source |
| **Ingest Email** | Paste a standardised email body to add an order |
| **Settings** | Configure server URL, test connection |

## Quick Start

### 1. Prerequisites
- Node.js 18+
- JDK 17
- Android Studio with an emulator (API 33+) or a physical Android device

### 2. Init the React Native project

```bash
npx react-native init OrderDashboard --template react-native-template-typescript
cd OrderDashboard
```

### 3. Copy source files

Copy these files from the repo's `android-app/` folder into the project root:

```
App.tsx
src/
  types.ts
  api.ts
  theme.ts
  screens/
    DashboardScreen.tsx
    OrderDetailScreen.tsx
    IngestEmailScreen.tsx
    SettingsScreen.tsx
  components/
    StatCard.tsx
    OrderCard.tsx
    ChannelBadge.tsx
    StatusBadge.tsx
    FilterChip.tsx
```

### 4. Install dependencies

```bash
npm install \
  @react-native-async-storage/async-storage \
  @react-navigation/native \
  @react-navigation/native-stack \
  react-native-safe-area-context \
  react-native-screens

# Link native modules
npx pod-install   # iOS only
```

### 5. Start the order server

```bash
# In the repo root
npm start
```

### 6. Run the app

```bash
# Android emulator — server URL is auto-set to http://10.0.2.2:3000
npx react-native run-android

# Physical device — open Settings in the app and set the URL to
# your machine's local IP, e.g. http://192.168.1.50:3000
```

## Email Format

Clients email orders in this standardised format. Admins paste the body into the Ingest Email screen:

```
---ORDER-START---
ORDER_ID: ORD-2026-XXX
CLIENT_ID: my-client
CLIENT_NAME: My Client
CHANNEL: email
ORDER_DATE: 2026-05-03T10:00:00Z
STATUS: confirmed
CURRENCY: USD
NOTES: Optional notes

---ITEMS---
SKU|NAME|QTY|UNIT_PRICE
PROD-001|Product Name|2|29.99

---SHIPPING---
RECIPIENT: John Doe
ADDRESS_LINE1: 123 Main St
CITY: New York
STATE: NY
ZIP: 10001
COUNTRY: US

---TOTALS---
SUBTOTAL: 59.98
SHIPPING: 5.99
TAX: 5.40
TOTAL: 71.37
---ORDER-END---
```
