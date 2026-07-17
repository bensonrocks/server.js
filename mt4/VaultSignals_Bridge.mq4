//+------------------------------------------------------------------+
//| VaultSignals_Bridge.mq4                                          |
//| Connects MetaTrader 4 to VaultSignals dashboard                  |
//|                                                                  |
//| SETUP                                                            |
//| 1. Copy this file to MT4/MQL4/Experts/                           |
//| 2. Compile in MetaEditor (F7)                                    |
//| 3. In MT4: Tools > Options > Expert Advisors >                   |
//|    Allow WebRequest for listed URL, add your Railway URL         |
//| 4. Attach EA to any chart (XAUUSD or XAGUSD recommended)        |
//| 5. Set BridgeUrl and BridgeKey inputs                            |
//+------------------------------------------------------------------+
#property copyright "VaultSignals"
#property version   "1.0"
#property strict

//── Inputs ────────────────────────────────────────────────────────────
input string BridgeUrl      = "https://vaultsignals.up.railway.app"; // Server URL (no trailing slash)
input string BridgeKey      = "";   // MT_BRIDGE_KEY from Railway env vars
input int    TickIntervalS  = 1;    // Seconds between price pushes
input int    PosIntervalS   = 5;    // Seconds between position pushes
input int    SigIntervalS   = 30;   // Seconds between signal polls
input int    HbIntervalS    = 60;   // Seconds between heartbeats
input bool   AlertPopup     = true; // Show popup alert for new signals
input bool   AlertSound     = true; // Play sound for new signals

//── State ──────────────────────────────────────────────────────────────
datetime g_lastTick = 0;
datetime g_lastPos  = 0;
datetime g_lastSig  = 0;
datetime g_lastHb   = 0;
int      g_lastSigId = 0;

//──────────────────────────────────────────────────────────────────────
int OnInit()
{
  if (BridgeKey == "") {
    Alert("VaultSignals Bridge: BridgeKey is empty. Set it to your MT_BRIDGE_KEY.");
    return INIT_FAILED;
  }
  Comment("VaultSignals Bridge — CONNECTING…");
  DoHeartbeat();
  return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
  Comment("");
}

//──────────────────────────────────────────────────────────────────────
void OnTick()
{
  datetime now = TimeCurrent();

  if (now - g_lastHb >= HbIntervalS) {
    DoHeartbeat();
    g_lastHb = now;
  }

  if (now - g_lastTick >= TickIntervalS) {
    PushTick("XAUUSD");
    PushTick("XAGUSD");
    g_lastTick = now;
  }

  if (now - g_lastPos >= PosIntervalS) {
    PushPositions();
    g_lastPos = now;
  }

  if (now - g_lastSig >= SigIntervalS) {
    PollSignals();
    g_lastSig = now;
  }
}

//──────────────────────────────────────────────────────────────────────
void DoHeartbeat()
{
  string body = StringFormat(
    "{\"key\":\"%s\",\"terminal\":{\"platform\":\"MT4\",\"version\":\"%d\",\"broker\":\"%s\",\"account\":\"%d\"}}",
    BridgeKey,
    (int)TerminalInfoInteger(TERMINAL_BUILD),
    AccountInfoString(ACCOUNT_COMPANY),
    AccountNumber()
  );
  HttpPost("/api/mt/heartbeat", body);
  Comment("VaultSignals Bridge — ACTIVE | acct #" + IntegerToString(AccountNumber()));
}

//──────────────────────────────────────────────────────────────────────
void PushTick(string symbol)
{
  double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
  double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
  if (bid <= 0 || ask <= 0) return;

  int digits = (symbol == "XAUUSD") ? 2 : 3;
  string body = StringFormat(
    "{\"key\":\"%s\",\"symbol\":\"%s\",\"bid\":%s,\"ask\":%s}",
    BridgeKey, symbol,
    DoubleToString(bid, digits),
    DoubleToString(ask, digits)
  );
  HttpPost("/api/mt/tick", body);
}

//──────────────────────────────────────────────────────────────────────
void PushPositions()
{
  string arr = "";
  int total = OrdersTotal();
  int count = 0;

  for (int i = 0; i < total; i++) {
    if (!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
    string sym = OrderSymbol();
    if (sym != "XAUUSD" && sym != "XAGUSD") continue;

    int dp = (sym == "XAUUSD") ? 2 : 3;
    if (count > 0) arr += ",";
    arr += StringFormat(
      "{\"ticket\":%d,\"symbol\":\"%s\",\"type\":%d,\"lots\":%s,\"openPrice\":%s,\"sl\":%s,\"tp\":%s,\"profit\":%s,\"openTime\":\"%s\"}",
      OrderTicket(), sym, OrderType(),
      DoubleToString(OrderLots(), 2),
      DoubleToString(OrderOpenPrice(), dp),
      DoubleToString(OrderStopLoss(), dp),
      DoubleToString(OrderTakeProfit(), dp),
      DoubleToString(OrderProfit(), 2),
      TimeToStr(OrderOpenTime(), TIME_DATE | TIME_MINUTES)
    );
    count++;
  }

  string body = StringFormat("{\"key\":\"%s\",\"positions\":[%s]}", BridgeKey, arr);
  HttpPost("/api/mt/positions", body);
}

//──────────────────────────────────────────────────────────────────────
void PollSignals()
{
  string url = BridgeUrl + "/api/mt/signals?key=" + BridgeKey;
  string resp = HttpGet(url);
  if (StringLen(resp) < 10) return;

  // Walk through each "id": value in the response
  int searchFrom = 0;
  while (true) {
    int idPos = StringFind(resp, "\"id\":", searchFrom);
    if (idPos < 0) break;

    int numStart = idPos + 5;
    int numEnd   = numStart;
    while (numEnd < StringLen(resp) && StringGetCharacter(resp, numEnd) != ',' &&
           StringGetCharacter(resp, numEnd) != '}') numEnd++;
    int sigId = (int)StringToInteger(StringSubstr(resp, numStart, numEnd - numStart));

    if (sigId > g_lastSigId) {
      string instrument = ExtractString(resp, "\"instrument\":\"", idPos);
      string direction  = ExtractString(resp, "\"direction\":\"",  idPos);
      string entry      = ExtractNumber(resp, "\"entry\":",        idPos);
      string sl         = ExtractNumber(resp, "\"stopLoss\":",     idPos);
      string tp1        = ExtractNumber(resp, "\"tp1\":",          idPos);

      string msg = StringFormat(
        "VaultSignals SIGNAL\n%s  %s\nEntry: %s | SL: %s | TP1: %s\nCheck dashboard for full details.",
        StringToUpper(instrument), StringToUpper(direction), entry, sl, tp1
      );

      if (AlertPopup) Alert(msg);
      if (AlertSound)  PlaySound("alert.wav");

      // Ack signal
      string ackBody = StringFormat("{\"key\":\"%s\",\"id\":%d}", BridgeKey, sigId);
      HttpPost("/api/mt/ack", ackBody);

      g_lastSigId = sigId;
    }

    searchFrom = numEnd;
  }
}

//──────────────────────────────────────────────────────────────────────
// Helper: extract a quoted string value after a given key pattern
string ExtractString(string &json, string key, int fromPos)
{
  int kPos = StringFind(json, key, fromPos);
  if (kPos < 0 || kPos > fromPos + 1000) return "";
  int vStart = kPos + StringLen(key);
  int vEnd   = StringFind(json, "\"", vStart);
  if (vEnd < 0) return "";
  return StringSubstr(json, vStart, vEnd - vStart);
}

// Helper: extract a numeric value (unquoted) after a given key pattern
string ExtractNumber(string &json, string key, int fromPos)
{
  int kPos = StringFind(json, key, fromPos);
  if (kPos < 0 || kPos > fromPos + 1000) return "—";
  int vStart = kPos + StringLen(key);
  int vEnd   = vStart;
  while (vEnd < StringLen(json)) {
    ushort c = StringGetCharacter(json, vEnd);
    if (c == ',' || c == '}' || c == ']') break;
    vEnd++;
  }
  return StringSubstr(json, vStart, vEnd - vStart);
}

//──────────────────────────────────────────────────────────────────────
string HttpGet(string url)
{
  char   reqData[];
  char   resData[];
  string resHeaders;
  int code = WebRequest("GET", url, "Content-Type: application/json\r\n", 5000, reqData, resData, resHeaders);
  if (code < 0 || ArraySize(resData) == 0) return "";
  return CharArrayToString(resData, 0, ArraySize(resData), CP_UTF8);
}

string HttpPost(string path, string body)
{
  char   reqData[];
  char   resData[];
  string resHeaders;
  string url = BridgeUrl + path;
  StringToCharArray(body, reqData, 0, StringLen(body), CP_UTF8);
  ArrayResize(reqData, ArraySize(reqData) - 1); // strip null terminator
  int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, reqData, resData, resHeaders);
  if (code < 0 || ArraySize(resData) == 0) return "";
  return CharArrayToString(resData, 0, ArraySize(resData), CP_UTF8);
}
