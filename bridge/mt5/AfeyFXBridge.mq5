//+------------------------------------------------------------------+
//| AfeyFX Bridge — connects this MT5 terminal to AfeyFX              |
//|                                                                    |
//| The EA connects OUT to your AfeyFX server over HTTPS (WebRequest).|
//| Your MT5 password never leaves this terminal. Every request is     |
//| signed with HMAC-SHA256 (timestamp + nonce + method + path + body |
//| hash) using the terminal secret shown once in AfeyFX.             |
//|                                                                    |
//| Setup (see docs/BROKERS.md):                                       |
//|  1. Tools → Options → Expert Advisors: "Allow algorithmic trading" |
//|     and "Allow WebRequest for listed URL" → add your AfeyFX URL.   |
//|  2. Put the terminal secret in MQL5/Files/AfeyFXBridge/secret.txt  |
//|     (one line). It is not an input so it is not shown on charts.   |
//|  3. Attach the EA to one chart; set BridgeUrl and TerminalId.      |
//|                                                                    |
//| Status: protocol reference implementation. It has NOT been         |
//| compiled/tested in CI (no MetaEditor there). Compile it in         |
//| MetaEditor and test on a DEMO account before any real account.     |
//+------------------------------------------------------------------+
#property copyright "AfeyFX"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

input string BridgeUrl        = "https://trade.example.com/api/bridge/mt5"; // AfeyFX bridge base URL
input string TerminalId       = "";          // Terminal ID from AfeyFX → Broker Connections
input string QuoteSymbols     = "EURUSD,GBPUSD,USDJPY,XAUUSD"; // symbols to stream (comma separated)
input int    PollMs           = 1000;        // command poll / quote interval
input int    HeartbeatSec     = 5;           // account + positions sync interval
input long   MagicNumber      = 26051;       // magic number for AfeyFX orders
input bool   AllowRealAccount = false;       // must be true to execute commands on a REAL account
input int    MaxDeviationPts  = 20;          // max slippage in points for market orders

CTrade   g_trade;
string   g_secret = "";
string   g_symbols[];
datetime g_lastHeartbeat = 0;
datetime g_lastSymbols = 0;
bool     g_helloOk = false;
string   g_pendingReports[];   // JSON report objects waiting for an acknowledgement
string   g_done[];             // command ids already executed (persisted)

//--- small helpers ---------------------------------------------------
string JsonEscape(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   return s;
  }
string Q(string s) { return "\"" + JsonEscape(s) + "\""; }
string D(double v, int digits = 8) { return DoubleToString(v, digits); }

string Hex(const uchar &b[])
  {
   string out = "";
   for(int i = 0; i < ArraySize(b); i++) out += StringFormat("%02x", b[i]);
   return out;
  }

void Utf8(string s, uchar &out[])
  {
   StringToCharArray(s, out, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(out) > 0 && out[ArraySize(out) - 1] == 0) ArrayResize(out, ArraySize(out) - 1); // drop terminator
  }

bool Sha256(const uchar &data[], uchar &out[])
  {
   uchar nokey[];
   return CryptEncode(CRYPT_HASH_SHA256, data, nokey, out) > 0;
  }

//--- HMAC-SHA256 (RFC 2104) built on CryptEncode ---------------------
string HmacSha256Hex(string key, string message)
  {
   uchar k[], m[], kpad[64], inner[], innerHash[], outer[], outerHash[];
   Utf8(key, k);
   Utf8(message, m);
   if(ArraySize(k) > 64) { uchar hk[]; Sha256(k, hk); ArrayCopy(k, hk); ArrayResize(k, 32); }
   ArrayInitialize(kpad, 0);
   ArrayCopy(kpad, k, 0, 0, MathMin(ArraySize(k), 64));
   ArrayResize(inner, 64 + ArraySize(m));
   for(int i = 0; i < 64; i++) inner[i] = (uchar)(kpad[i] ^ 0x36);
   ArrayCopy(inner, m, 64);
   Sha256(inner, innerHash);
   ArrayResize(outer, 64 + ArraySize(innerHash));
   for(int i = 0; i < 64; i++) outer[i] = (uchar)(kpad[i] ^ 0x5c);
   ArrayCopy(outer, innerHash, 64);
   Sha256(outer, outerHash);
   return Hex(outerHash);
  }

string PathOf(string endpoint)
  {
   // Signed path = the URL path of BridgeUrl + endpoint, e.g. /api/bridge/mt5/heartbeat
   string u = BridgeUrl;
   int p = StringFind(u, "://");
   if(p >= 0) u = StringSubstr(u, p + 3);
   int slash = StringFind(u, "/");
   string path = slash >= 0 ? StringSubstr(u, slash) : "";
   if(StringLen(path) > 0 && StringGetCharacter(path, StringLen(path) - 1) == '/') path = StringSubstr(path, 0, StringLen(path) - 1);
   return path + "/" + endpoint;
  }

//--- signed POST; returns HTTP status (or -1) and the response text --
int Post(string endpoint, string json, string &response)
  {
   uchar body[];
   Utf8(json, body);
   uchar bodyHash[];
   Sha256(body, bodyHash);
   string ts = IntegerToString((long)TimeGMT() * 1000);
   string nonce = IntegerToString((long)GetTickCount64()) + "-" + IntegerToString(MathRand()) + "-" + IntegerToString(MathRand());
   string sig = HmacSha256Hex(g_secret, ts + "\n" + nonce + "\nPOST\n" + PathOf(endpoint) + "\n" + Hex(bodyHash));
   string headers = "Content-Type: application/json\r\nX-AFX-Terminal: " + TerminalId + "\r\nX-AFX-Timestamp: " + ts + "\r\nX-AFX-Nonce: " + nonce + "\r\nX-AFX-Signature: " + sig + "\r\n";
   char data[], result[];
   ArrayResize(data, ArraySize(body));
   for(int i = 0; i < ArraySize(body); i++) data[i] = (char)body[i];
   string rh;
   ResetLastError();
   int status = WebRequest("POST", BridgeUrl + "/" + endpoint, headers, 5000, data, result, rh);
   if(status == -1) { PrintFormat("AfeyFX: WebRequest failed (%d). Is %s in the allowed URL list?", GetLastError(), BridgeUrl); return -1; }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(status >= 400) PrintFormat("AfeyFX: %s → HTTP %d %s", endpoint, status, StringSubstr(response, 0, 200));
   return status;
  }

//--- persistence of executed command ids (at-most-once execution) ---
string DoneFile() { return "AfeyFXBridge\\done_" + TerminalId + ".txt"; }

void LoadDone()
  {
   ArrayResize(g_done, 0);
   int h = FileOpen(DoneFile(), FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      if(StringLen(line) > 0) { int n = ArraySize(g_done); ArrayResize(g_done, n + 1); g_done[n] = line; }
     }
   FileClose(h);
  }

bool IsDone(string id)
  {
   for(int i = 0; i < ArraySize(g_done); i++) if(g_done[i] == id || g_done[i] == id + "|started") return true;
   return false;
  }

void MarkDone(string entry)
  {
   int h = FileOpen(DoneFile(), FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, entry + "\n");
   FileClose(h);
   int n = ArraySize(g_done); ArrayResize(g_done, n + 1); g_done[n] = entry;
  }

void QueueReport(string commandId, string status, int retcode, string message, ulong order, ulong deal, ulong position, double price, double volume)
  {
   string r = "{\"commandId\":" + Q(commandId) + ",\"status\":" + Q(status) + ",\"retcode\":" + IntegerToString(retcode) +
              ",\"message\":" + Q(message) + ",\"order\":" + Q(IntegerToString((long)order)) + ",\"deal\":" + Q(IntegerToString((long)deal)) +
              ",\"position\":" + Q(IntegerToString((long)position)) + ",\"price\":" + D(price) + ",\"volume\":" + D(volume, 2) + ",\"time\":" + IntegerToString((long)TimeGMT() * 1000) + "}";
   int n = ArraySize(g_pendingReports); ArrayResize(g_pendingReports, n + 1); g_pendingReports[n] = r;
  }

void FlushReports()
  {
   if(ArraySize(g_pendingReports) == 0) return;
   string body = "{\"reports\":[";
   for(int i = 0; i < ArraySize(g_pendingReports); i++) body += (i ? "," : "") + g_pendingReports[i];
   body += "]}";
   string resp;
   if(Post("reports", body, resp) == 200) ArrayResize(g_pendingReports, 0); // server acknowledges idempotently
  }

//--- protocol messages ----------------------------------------------
bool Hello()
  {
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string tradeMode = mode == ACCOUNT_TRADE_MODE_REAL ? "real" : (mode == ACCOUNT_TRADE_MODE_CONTEST ? "contest" : "demo");
   string body = "{\"login\":" + Q(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))) + ",\"server\":" + Q(AccountInfoString(ACCOUNT_SERVER)) +
                 ",\"company\":" + Q(AccountInfoString(ACCOUNT_COMPANY)) + ",\"currency\":" + Q(AccountInfoString(ACCOUNT_CURRENCY)) +
                 ",\"name\":" + Q(AccountInfoString(ACCOUNT_NAME)) + ",\"tradeMode\":" + Q(tradeMode) + ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) +
                 ",\"eaVersion\":\"1.00\",\"terminalTime\":" + IntegerToString((long)TimeGMT() * 1000) + "}";
   string resp;
   int st = Post("hello", body, resp);
   g_helloOk = st == 200;
   if(!g_helloOk) Print("AfeyFX: hello refused: ", resp);
   return g_helloOk;
  }

void SendSymbols()
  {
   string body = "{\"symbols\":[";
   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      string s = g_symbols[i];
      if(!SymbolSelect(s, true)) continue;
      long tm = SymbolInfoInteger(s, SYMBOL_TRADE_MODE);
      string tradeMode = tm == SYMBOL_TRADE_MODE_FULL ? "full" : (tm == SYMBOL_TRADE_MODE_LONGONLY ? "long" : (tm == SYMBOL_TRADE_MODE_SHORTONLY ? "short" : (tm == SYMBOL_TRADE_MODE_CLOSEONLY ? "closeonly" : "disabled")));
      body += (i ? "," : "") + "{\"name\":" + Q(s) + ",\"description\":" + Q(SymbolInfoString(s, SYMBOL_DESCRIPTION)) +
              ",\"digits\":" + IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS)) + ",\"contractSize\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE)) +
              ",\"tickSize\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) + ",\"tickValue\":" + D(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE), 10) +
              ",\"volumeMin\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) + ",\"volumeMax\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 4) +
              ",\"volumeStep\":" + D(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) + ",\"tradeMode\":" + Q(tradeMode) +
              ",\"currencyProfit\":" + Q(SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT)) + ",\"currencyMargin\":" + Q(SymbolInfoString(s, SYMBOL_CURRENCY_MARGIN)) +
              ",\"path\":" + Q(SymbolInfoString(s, SYMBOL_PATH)) + "}";
     }
   body += "]}";
   string resp;
   if(Post("symbols", body, resp) == 200) g_lastSymbols = TimeGMT();
  }

void SendQuotes()
  {
   string body = "{\"quotes\":[";
   int n = 0;
   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      MqlTick t;
      if(!SymbolInfoTick(g_symbols[i], t)) continue;
      body += (n++ ? "," : "") + "{\"s\":" + Q(g_symbols[i]) + ",\"b\":" + D(t.bid) + ",\"a\":" + D(t.ask) + ",\"t\":" + IntegerToString((long)t.time_msc) + "}";
     }
   body += "]}";
   string resp;
   if(n > 0) Post("quotes", body, resp);
  }

string PositionsJson()
  {
   string out = "[";
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      out += (i ? "," : "") + "{\"ticket\":" + Q(IntegerToString((long)ticket)) + ",\"symbol\":" + Q(PositionGetString(POSITION_SYMBOL)) +
             ",\"type\":" + Q(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") + ",\"volume\":" + D(PositionGetDouble(POSITION_VOLUME), 2) +
             ",\"priceOpen\":" + D(PositionGetDouble(POSITION_PRICE_OPEN)) + ",\"priceCurrent\":" + D(PositionGetDouble(POSITION_PRICE_CURRENT)) +
             ",\"sl\":" + D(PositionGetDouble(POSITION_SL)) + ",\"tp\":" + D(PositionGetDouble(POSITION_TP)) + ",\"profit\":" + D(PositionGetDouble(POSITION_PROFIT), 2) +
             ",\"time\":" + IntegerToString((long)PositionGetInteger(POSITION_TIME) * 1000) + ",\"comment\":" + Q(PositionGetString(POSITION_COMMENT)) +
             ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC)) + "}";
     }
   return out + "]";
  }

string OrdersJson()
  {
   string out = "[";
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      out += (i ? "," : "") + "{\"ticket\":" + Q(IntegerToString((long)ticket)) + ",\"symbol\":" + Q(OrderGetString(ORDER_SYMBOL)) +
             ",\"type\":" + Q(EnumToString((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE))) + ",\"volume\":" + D(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) +
             ",\"price\":" + D(OrderGetDouble(ORDER_PRICE_OPEN)) + ",\"sl\":" + D(OrderGetDouble(ORDER_SL)) + ",\"tp\":" + D(OrderGetDouble(ORDER_TP)) +
             ",\"comment\":" + Q(OrderGetString(ORDER_COMMENT)) + "}";
     }
   return out + "]";
  }

string DealsJson()
  {
   string out = "[";
   if(!HistorySelect(TimeCurrent() - 7 * 86400, TimeCurrent() + 60)) return "[]";
   int total = HistoryDealsTotal(), n = 0;
   for(int i = MathMax(0, total - 200); i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      string e = entry == DEAL_ENTRY_IN ? "in" : (entry == DEAL_ENTRY_OUT ? "out" : (entry == DEAL_ENTRY_INOUT ? "inout" : "out_by"));
      out += (n++ ? "," : "") + "{\"ticket\":" + Q(IntegerToString((long)d)) + ",\"order\":" + Q(IntegerToString(HistoryDealGetInteger(d, DEAL_ORDER))) +
             ",\"positionId\":" + Q(IntegerToString(HistoryDealGetInteger(d, DEAL_POSITION_ID))) + ",\"symbol\":" + Q(HistoryDealGetString(d, DEAL_SYMBOL)) +
             ",\"entry\":" + Q(e) + ",\"type\":" + Q(HistoryDealGetInteger(d, DEAL_TYPE) == DEAL_TYPE_BUY ? "buy" : "sell") +
             ",\"volume\":" + D(HistoryDealGetDouble(d, DEAL_VOLUME), 2) + ",\"price\":" + D(HistoryDealGetDouble(d, DEAL_PRICE)) +
             ",\"profit\":" + D(HistoryDealGetDouble(d, DEAL_PROFIT), 2) + ",\"commission\":" + D(HistoryDealGetDouble(d, DEAL_COMMISSION), 2) +
             ",\"swap\":" + D(HistoryDealGetDouble(d, DEAL_SWAP), 2) + ",\"time\":" + IntegerToString((long)HistoryDealGetInteger(d, DEAL_TIME) * 1000) +
             ",\"comment\":" + Q(HistoryDealGetString(d, DEAL_COMMENT)) + "}";
     }
   return out + "]";
  }

void Heartbeat()
  {
   string body = "{\"balance\":" + D(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + D(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                 ",\"margin\":" + D(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",\"freeMargin\":" + D(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
                 ",\"marginLevel\":" + D(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",\"positions\":" + PositionsJson() +
                 ",\"orders\":" + OrdersJson() + ",\"deals\":" + DealsJson() + "}";
   string resp;
   int st = Post("heartbeat", body, resp);
   if(st == 409) { g_helloOk = false; return; }
   if(st == 200) { g_lastHeartbeat = TimeGMT(); HandleCommands(resp); }
  }

//--- command execution (at most once, never after the deadline) ------
void HandleCommands(string text)
  {
   string lines[];
   int n = StringSplit(text, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string f[];
      if(StringSplit(lines[i], '|', f) < 12 || f[0] != "CMD") continue;
      string id = f[1], type = f[2], sym = f[3], side = f[4], otype = f[5];
      double vol = StringToDouble(f[6]), price = StringToDouble(f[7]), sl = StringToDouble(f[8]), tp = StringToDouble(f[9]);
      ulong ticket = (ulong)StringToInteger(f[10]);
      long deadline = StringToInteger(f[11]);
      if(IsDone(id)) continue;                                      // already executed (or interrupted)
      if((long)TimeGMT() > deadline) { MarkDone(id); QueueReport(id, "expired", 0, "Deadline passed before execution", 0, 0, 0, 0, 0); continue; }
      if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !AllowRealAccount) { MarkDone(id); QueueReport(id, "rejected", 0, "AllowRealAccount is false in the EA inputs", 0, 0, 0, 0, 0); continue; }
      MarkDone(id + "|started");                                    // crash after this point → never re-executed
      Execute(id, type, sym, side, otype, vol, price, sl, tp, ticket);
      MarkDone(id);
     }
   FlushReports();
  }

void Execute(string id, string type, string sym, string side, string otype, double vol, double price, double sl, double tp, ulong ticket)
  {
   g_trade.SetExpertMagicNumber(MagicNumber);
   g_trade.SetDeviationInPoints(MaxDeviationPts);
   bool ok = false;
   if(type == "order.place")
     {
      SymbolSelect(sym, true);
      if(otype == "market") ok = side == "buy" ? g_trade.Buy(vol, sym, 0, sl, tp, id) : g_trade.Sell(vol, sym, 0, sl, tp, id);
      else if(otype == "limit") ok = side == "buy" ? g_trade.BuyLimit(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, id) : g_trade.SellLimit(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, id);
      else if(otype == "stop") ok = side == "buy" ? g_trade.BuyStop(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, id) : g_trade.SellStop(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, id);
     }
   else if(type == "position.close") ok = (vol > 0 && PositionSelectByTicket(ticket) && vol < PositionGetDouble(POSITION_VOLUME)) ? g_trade.PositionClosePartial(ticket, vol) : g_trade.PositionClose(ticket);
   else if(type == "order.cancel") ok = g_trade.OrderDelete(ticket);
   else if(type == "order.modify")
     {
      if(PositionSelectByTicket(ticket)) ok = g_trade.PositionModify(ticket, sl, tp);
      else ok = g_trade.OrderModify(ticket, price, sl, tp, ORDER_TIME_GTC, 0);
     }
   uint rc = g_trade.ResultRetcode();
   ulong deal = g_trade.ResultDeal(), order = g_trade.ResultOrder(), position = 0;
   if(deal > 0 && HistoryDealSelect(deal)) position = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
   if(type == "position.close" || type == "order.modify" || type == "order.cancel") position = ticket;
   string status = "rejected";
   if(ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL)) status = type == "order.place" && otype == "market" ? "filled" : "done";
   else if(ok && rc == TRADE_RETCODE_PLACED) status = "placed";
   else if(rc == TRADE_RETCODE_TIMEOUT || rc == 0) status = "unknown";        // let the server reconcile
   QueueReport(id, status, (int)rc, g_trade.ResultRetcodeDescription(), order, deal, position, g_trade.ResultPrice(), g_trade.ResultVolume());
  }

//--- lifecycle ------------------------------------------------------
int OnInit()
  {
   if(StringLen(TerminalId) < 8) { Print("AfeyFX: set TerminalId"); return INIT_PARAMETERS_INCORRECT; }
   int h = FileOpen("AfeyFXBridge\\secret.txt", FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Print("AfeyFX: put the terminal secret in MQL5/Files/AfeyFXBridge/secret.txt"); return INIT_FAILED; }
   g_secret = FileReadString(h);
   FileClose(h);
   StringTrimLeft(g_secret); StringTrimRight(g_secret);
   StringSplit(QuoteSymbols, ',', g_symbols);
   for(int i = 0; i < ArraySize(g_symbols); i++) { StringTrimLeft(g_symbols[i]); StringTrimRight(g_symbols[i]); SymbolSelect(g_symbols[i], true); }
   LoadDone();
   MathSrand((uint)GetTickCount());
   EventSetMillisecondTimer(MathMax(250, PollMs));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
  {
   if(!g_helloOk) { if(!Hello()) return; SendSymbols(); }
   SendQuotes();
   if(TimeGMT() - g_lastHeartbeat >= HeartbeatSec) Heartbeat();
   else { string resp; if(Post("poll", "{}", resp) == 200) HandleCommands(resp); }   // fast command pickup
   if(TimeGMT() - g_lastSymbols >= 600) SendSymbols();
   FlushReports();
  }
//+------------------------------------------------------------------+
