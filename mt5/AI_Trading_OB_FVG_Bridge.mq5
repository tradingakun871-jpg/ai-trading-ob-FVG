#property strict
#property version   "1.00"
#property description "MT5 -> AI Trading OB+FVG MTF bridge. Attach to any chart; sends XAUUSD M1 closed candles and live ticks."

input string ApiBaseUrl   = "https://ai-trading-ob-fvg-mtf-production.up.railway.app";
input string BridgeToken  = "PASTE_BRIDGE_TOKEN_HERE";
input string BridgeSymbol = "XAUUSD";
input int    BackfillBars = 2000;
input int    TimerSeconds = 2;
input int    HttpTimeoutMs = 10000;

string g_symbol = "";
datetime g_currentM1Open = 0;

string TrimSlash(string s)
{
   while(StringLen(s) > 0 && StringSubstr(s, StringLen(s)-1, 1) == "/")
      s = StringSubstr(s, 0, StringLen(s)-1);
   return s;
}

string Num(double v)
{
   int digits = (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS);
   return DoubleToString(v, digits);
}

bool HttpPost(string endpoint, string json, string &response)
{
   string url = TrimSlash(ApiBaseUrl) + endpoint;
   string headers = "Content-Type: application/json\r\nX-Bridge-Token: " + BridgeToken + "\r\n";

   char data[];
   StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0)
      ArrayResize(data, ArraySize(data)-1);

   char result[];
   string result_headers;
   ResetLastError();
   int code = WebRequest("POST", url, headers, HttpTimeoutMs, data, result, result_headers);
   if(code == -1)
   {
      int err = GetLastError();
      Print("[OBFVG Bridge] WebRequest failed. Error=", err,
            ". Add this URL in MT5: Tools > Options > Expert Advisors > Allow WebRequest: ", TrimSlash(ApiBaseUrl));
      return false;
   }

   response = CharArrayToString(result, 0, -1, CP_UTF8);
   if(code < 200 || code >= 300)
   {
      Print("[OBFVG Bridge] HTTP ", code, " ", endpoint, " -> ", response);
      return false;
   }
   return true;
}

string CandleJson(MqlRates &r)
{
   return "{\"time\":" + IntegerToString((int)r.time) +
          ",\"open\":" + Num(r.open) +
          ",\"high\":" + Num(r.high) +
          ",\"low\":" + Num(r.low) +
          ",\"close\":" + Num(r.close) +
          ",\"volume\":" + LongToString((long)r.tick_volume) + "}";
}

bool SendBackfill()
{
   if(BackfillBars <= 0)
      return true;

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(g_symbol, PERIOD_M1, 1, BackfillBars, rates);
   if(copied <= 0)
   {
      Print("[OBFVG Bridge] Backfill CopyRates failed. Error=", GetLastError());
      return false;
   }

   string json = "{\"symbol\":\"" + g_symbol + "\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candles\":[";
   for(int i=0; i<copied; i++)
   {
      if(i > 0) json += ",";
      json += CandleJson(rates[i]);
   }
   json += "]}";

   string response;
   bool ok = HttpPost("/api/mt5/backfill", json, response);
   if(ok)
      Print("[OBFVG Bridge] Backfill OK: ", copied, " M1 candles imported. M3/M5 built by server.");
   return ok;
}

bool SendClosedM1()
{
   MqlRates r[];
   ArraySetAsSeries(r, true);
   if(CopyRates(g_symbol, PERIOD_M1, 1, 1, r) != 1)
   {
      Print("[OBFVG Bridge] Could not read last closed M1 candle. Error=", GetLastError());
      return false;
   }

   string json = "{\"symbol\":\"" + g_symbol + "\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candle\":" + CandleJson(r[0]) + "}";
   string response;
   bool ok = HttpPost("/api/mt5/webhook", json, response);
   if(ok)
      Print("[OBFVG Bridge] M1 candle sent: ", TimeToString(r[0].time, TIME_DATE|TIME_MINUTES));
   return ok;
}

bool SendTick()
{
   MqlTick tick;
   if(!SymbolInfoTick(g_symbol, tick))
      return false;

   string json = "{\"symbol\":\"" + g_symbol +
                 "\",\"time\":" + LongToString((long)tick.time) +
                 ",\"serverTime\":" + LongToString((long)TimeTradeServer()) +
                 ",\"bid\":" + Num(tick.bid) +
                 ",\"ask\":" + Num(tick.ask) + "}";
   string response;
   return HttpPost("/api/mt5/tick", json, response);
}

int OnInit()
{
   g_symbol = BridgeSymbol;
   if(StringLen(g_symbol) == 0)
      g_symbol = _Symbol;

   if(StringFind(BridgeToken, "PASTE_") >= 0 || StringLen(BridgeToken) < 16)
   {
      Print("[OBFVG Bridge] BridgeToken has not been configured.");
      return INIT_PARAMETERS_INCORRECT;
   }

   if(!SymbolSelect(g_symbol, true))
   {
      Print("[OBFVG Bridge] Cannot select symbol: ", g_symbol);
      return INIT_FAILED;
   }

   g_currentM1Open = iTime(g_symbol, PERIOD_M1, 0);
   EventSetTimer((int)MathMax(1, TimerSeconds));

   Print("[OBFVG Bridge] Starting for ", g_symbol, ". API=", TrimSlash(ApiBaseUrl));
   SendBackfill();
   SendTick();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   datetime currentOpen = iTime(g_symbol, PERIOD_M1, 0);
   if(currentOpen > 0 && g_currentM1Open > 0 && currentOpen != g_currentM1Open)
   {
      SendClosedM1();
      g_currentM1Open = currentOpen;
   }
   else if(g_currentM1Open == 0 && currentOpen > 0)
   {
      g_currentM1Open = currentOpen;
   }

   SendTick();
}
