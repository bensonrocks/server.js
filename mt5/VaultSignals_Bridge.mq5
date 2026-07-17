//+------------------------------------------------------------------+
//| VaultSignals_Bridge.mq5                                          |
//| Connects MetaTrader 5 to VaultSignals dashboard                  |
//|                                                                  |
//| SETUP                                                            |
//| 1. Copy this file to MT5/MQL5/Experts/                           |
//| 2. Compile in MetaEditor (F7)                                    |
//| 3. In MT5: Tools > Options > Expert Advisors >                   |
//|    Allow WebRequest for listed URL, add your Railway URL         |
//| 4. Attach EA to any chart                                        |
//| 5. Set BridgeUrl and BridgeKey inputs                            |
//+------------------------------------------------------------------+
#property copyright "VaultSignals"
#property version   "1.0"

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
    "{\"key\":\"%s\",\"terminal\":{\"platform\":\"MT5\",\"version\":\"%d\",\"broker\":\"%s\",\"account\":\"%d\"}}",
    BridgeKey,
    (int)TerminalInfoInteger(TERMINAL_BUILD),
    AccountInfoString(ACCOUNT_COMPANY),
    (int)AccountInfoInteger(ACCOUNT_LOGIN)
  );
  HttpPost("/api/mt/heartbeat", body);
  Comment("VaultSignals Bridge — ACTIVE | acct #" +
          IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)));
}

//──────────────────────────────────────────────────────────────────────
void PushTick(string symbol)
{
  MqlTick last;
  if (!SymbolInfoTick(symbol, last)) return;

  int digits = (symbol == "XAUUSD") ? 2 : 3;
  string body = StringFormat(
    "{\"key\":\"%s\",\"symbol\":\"%s\",\"bid\":%s,\"ask\":%s}",
    BridgeKey, symbol,
    DoubleToString(last.bid, digits),
    DoubleToString(last.ask, digits)
  );
  HttpPost("/api/mt/tick", body);
}

//──────────────────────────────────────────────────────────────────────
void PushPositions()
{
  string arr = "";
  int total = PositionsTotal();
  int count = 0;

  for (int i = 0; i < total; i++) {
    ulong ticket = PositionGetTicket(i);
    if (ticket == 0) continue;
    string sym = PositionGetString(POSITION_SYMBOL);
    if (sym != "XAUUSD" && sym != "XAGUSD") continue;

    int dp   = (sym == "XAUUSD") ? 2 : 3;
    int type = (int)PositionGetInteger(POSITION_TYPE); // 0=BUY,1=SELL
    if (count > 0) arr += ",";
    arr += StringFormat(
      "{\"ticket\":%d,\"symbol\":\"%s\",\"type\":%d,\"lots\":%s,\"openPrice\":%s,\"sl\":%s,\"tp\":%s,\"profit\":%s,\"openTime\":\"%s\"}",
      (int)ticket, sym, type,
      DoubleToString(PositionGetDouble(POSITION_VOLUME), 2),
      DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), dp),
      DoubleToString(PositionGetDouble(POSITION_SL), dp),
      DoubleToString(PositionGetDouble(POSITION_TP), dp),
      DoubleToString(PositionGetDouble(POSITION_PROFIT), 2),
      TimeToString((datetime)PositionGetInteger(POSITION_TIME), TIME_DATE | TIME_MINUTES)
    );
    count++;
  }

  string body = StringFormat("{\"key\":\"%s\",\"positions\":[%s]}", BridgeKey, arr);
  HttpPost("/api/mt/positions", body);
}

//──────────────────────────────────────────────────────────────────────
void PollSignals()
{
  string url  = BridgeUrl + "/api/mt/signals?key=" + BridgeKey;
  string resp = HttpGet(url);
  if (StringLen(resp) < 10) return;

  int searchFrom = 0;
  while (true) {
    int idPos = StringFind(resp, "\"id\":", searchFrom);
    if (idPos < 0) break;

    int numStart = idPos + 5;
    int numEnd   = numStart;
    while (numEnd < StringLen(resp)) {
      ushort c = StringGetCharacter(resp, numEnd);
      if (c == ',' || c == '}' || c == ']') break;
      numEnd++;
    }
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

      string ackBody = StringFormat("{\"key\":\"%s\",\"id\":%d}", BridgeKey, sigId);
      HttpPost("/api/mt/ack", ackBody);

      g_lastSigId = sigId;
    }

    searchFrom = numEnd;
  }
}

//──────────────────────────────────────────────────────────────────────
string ExtractString(string &json, string key, int fromPos)
{
  int kPos = StringFind(json, key, fromPos);
  if (kPos < 0 || kPos > fromPos + 1000) return "";
  int vStart = kPos + StringLen(key);
  int vEnd   = StringFind(json, "\"", vStart);
  if (vEnd < 0) return "";
  return StringSubstr(json, vStart, vEnd - vStart);
}

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
  int len = StringToCharArray(body, reqData, 0, -1, CP_UTF8) - 1; // -1 strips null
  if (len > 0) ArrayResize(reqData, len);
  int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, reqData, resData, resHeaders);
  if (code < 0 || ArraySize(resData) == 0) return "";
  return CharArrayToString(resData, 0, ArraySize(resData), CP_UTF8);
}
