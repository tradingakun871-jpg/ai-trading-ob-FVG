#property strict
#property version   "2.00"
#property description "MT5 <-> AI Trading OB+FVG M1/M3 bridge with isolated Auto Execution V1."
#include <Trade/Trade.mqh>

input string ApiBaseUrl    = "https://ai-trading-ob-fvg-mtf-production.up.railway.app";
input string BridgeToken   = "PASTE_BRIDGE_TOKEN_HERE";
input string BridgeSymbol  = "XAUUSD";
input int    BackfillBars  = 2000;
input int    TimerSeconds  = 2;
input int    HttpTimeoutMs = 10000;

// MT5 execution layer only. Web AI strategy/statistics are never changed by these settings.
input bool   EnableAutoExecution = false;
input double FixedLot            = 0.01;
input ulong  MagicNumber         = 26091701;
input int    MaxDeviationPoints  = 30;

CTrade trade;
string g_symbol = "";
datetime g_currentM1Open = 0;

string TrimSlash(string s){while(StringLen(s)>0&&StringSubstr(s,StringLen(s)-1,1)=="/")s=StringSubstr(s,0,StringLen(s)-1);return s;}
string Num(double v){int digits=(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS);return DoubleToString(v,digits);}
string EscapeJson(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");return s;}

bool HttpRequest(string method,string endpoint,string body,string &response)
{
   string url=TrimSlash(ApiBaseUrl)+endpoint;
   string headers="Content-Type: application/json\r\nX-Bridge-Token: "+BridgeToken+"\r\n";
   char data[]; if(StringLen(body)>0){StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);} else ArrayResize(data,0);
   char result[]; string result_headers; ResetLastError();
   int code=WebRequest(method,url,headers,HttpTimeoutMs,data,result,result_headers);
   if(code==-1){Print("[OBFVG Bridge] WebRequest failed. Error=",GetLastError(),". Allow URL: ",TrimSlash(ApiBaseUrl));return false;}
   response=CharArrayToString(result,0,-1,CP_UTF8);
   if(code<200||code>=300){Print("[OBFVG Bridge] HTTP ",code," ",endpoint," -> ",response);return false;}
   return true;
}
bool HttpPost(string endpoint,string json,string &response){return HttpRequest("POST",endpoint,json,response);}
bool HttpGet(string endpoint,string &response){return HttpRequest("GET",endpoint,"",response);}

string CandleJson(MqlRates &r){return "{\"time\":"+IntegerToString((int)r.time)+",\"open\":"+Num(r.open)+",\"high\":"+Num(r.high)+",\"low\":"+Num(r.low)+",\"close\":"+Num(r.close)+",\"volume\":"+LongToString((long)r.tick_volume)+"}";}

bool SendBackfill()
{
   if(BackfillBars<=0)return true;
   MqlRates rates[];ArraySetAsSeries(rates,false);int copied=CopyRates(g_symbol,PERIOD_M1,1,BackfillBars,rates);
   if(copied<=0){Print("[OBFVG Bridge] Backfill CopyRates failed. Error=",GetLastError());return false;}
   string json="{\"symbol\":\""+g_symbol+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candles\":[";
   for(int i=0;i<copied;i++){if(i>0)json+=",";json+=CandleJson(rates[i]);}json+="]}";
   string response;bool ok=HttpPost("/api/mt5/backfill",json,response);if(ok)Print("[OBFVG Bridge] Backfill OK: ",copied," M1 candles imported. M3 built by server.");return ok;
}

bool SendClosedM1()
{
   MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(g_symbol,PERIOD_M1,1,1,r)!=1){Print("[OBFVG Bridge] Could not read last closed M1 candle. Error=",GetLastError());return false;}
   string json="{\"symbol\":\""+g_symbol+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candle\":"+CandleJson(r[0])+"}";
   string response;bool ok=HttpPost("/api/mt5/webhook",json,response);if(ok)Print("[OBFVG Bridge] M1 candle sent: ",TimeToString(r[0].time,TIME_DATE|TIME_MINUTES));return ok;
}

bool SendTick()
{
   MqlTick tick;if(!SymbolInfoTick(g_symbol,tick))return false;
   string json="{\"symbol\":\""+g_symbol+"\",\"time\":"+LongToString((long)tick.time)+",\"serverTime\":"+LongToString((long)TimeTradeServer())+",\"bid\":"+Num(tick.bid)+",\"ask\":"+Num(tick.ask)+"}";
   string response;return HttpPost("/api/mt5/tick",json,response);
}

string JsonString(string src,string key)
{
   string needle="\""+key+"\":";int p=StringFind(src,needle);if(p<0)return "";p+=StringLen(needle);while(p<StringLen(src)&&StringSubstr(src,p,1)==" ")p++;
   if(StringSubstr(src,p,1)=="\""){p++;int e=StringFind(src,"\"",p);if(e<0)return "";return StringSubstr(src,p,e-p);}int e=p;while(e<StringLen(src)){string c=StringSubstr(src,e,1);if(c==","||c=="}")break;e++;}return StringSubstr(src,p,e-p);
}
double JsonNumber(string src,string key){return StringToDouble(JsonString(src,key));}

void AckCommand(string id,string status,ulong ticket,string detail)
{
   string json="{\"id\":\""+EscapeJson(id)+"\",\"status\":\""+EscapeJson(status)+"\",\"ticket\":"+LongToString((long)ticket)+",\"detail\":\""+EscapeJson(detail)+"\"}";string response;HttpPost("/api/mt5/commands/ack",json,response);
}

string TicketKey(ulong ticket,string suffix){return "OBFVG_"+LongToString((long)MagicNumber)+"_"+LongToString((long)ticket)+"_"+suffix;}
void SaveManagement(ulong ticket,double tp1,double trigger){GlobalVariableSet(TicketKey(ticket,"TP1"),tp1);GlobalVariableSet(TicketKey(ticket,"TRG"),trigger);}

void ExecuteCommand(string obj)
{
   string id=JsonString(obj,"id"),symbol=JsonString(obj,"symbol"),side=JsonString(obj,"side");
   double sl=JsonNumber(obj,"sl"),tp1=JsonNumber(obj,"tp1"),tp4=JsonNumber(obj,"tp4"),pip=JsonNumber(obj,"pipSize"),buffer=JsonNumber(obj,"slMoveTriggerPips");
   if(id==""||symbol==""||(side!="BUY"&&side!="SELL")||sl<=0||tp1<=0||tp4<=0){AckCommand(id,"REJECTED",0,"invalid command");return;}
   if(symbol!=g_symbol){AckCommand(id,"REJECTED",0,"symbol mismatch");return;}
   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   string comment="OBFVG "+id;bool ok=false;
   if(side=="BUY")ok=trade.Buy(FixedLot,g_symbol,0,sl,tp4,comment);else ok=trade.Sell(FixedLot,g_symbol,0,sl,tp4,comment);
   if(!ok){string detail="retcode="+IntegerToString((int)trade.ResultRetcode())+" "+trade.ResultRetcodeDescription();Print("[AUTO] Order failed ",id," ",detail);AckCommand(id,"FAILED",0,detail);return;}
   ulong ticket=trade.ResultOrder();
   // On hedging accounts ResultOrder is the position ticket in normal market execution; find by magic if needed.
   if(ticket==0){for(int i=PositionsTotal()-1;i>=0;i--){ulong t=PositionGetTicket(i);if(t>0&&PositionGetInteger(POSITION_MAGIC)==(long)MagicNumber&&PositionGetString(POSITION_SYMBOL)==g_symbol){ticket=t;break;}}}
   double trigger=(side=="BUY")?tp1+buffer*pip:tp1-buffer*pip;SaveManagement(ticket,tp1,trigger);
   Print("[AUTO] EXECUTED id=",id," ticket=",ticket," side=",side," lot=",FixedLot," SL=",Num(sl)," TP4=",Num(tp4)," move-SL trigger=",Num(trigger)," -> TP1=",Num(tp1));
   AckCommand(id,"EXECUTED",ticket,"TP1+5p buffer management armed");
}

void PollCommands()
{
   if(!EnableAutoExecution)return;
   string response;if(!HttpGet("/api/mt5/commands",response))return;
   int p=StringFind(response,"\"commands\":[");if(p<0)return;p+=StringLen("\"commands\":[");
   while(p<StringLen(response))
   {
      int s=StringFind(response,"{",p);if(s<0)break;int depth=0,e=-1;
      for(int i=s;i<StringLen(response);i++){string c=StringSubstr(response,i,1);if(c=="{")depth++;else if(c=="}"){depth--;if(depth==0){e=i;break;}}}
      if(e<0)break;ExecuteCommand(StringSubstr(response,s,e-s+1));p=e+1;
   }
}

void ManageAutoPositions()
{
   if(!EnableAutoExecution)return;MqlTick tick;if(!SymbolInfoTick(g_symbol,tick))return;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);if(ticket==0||PositionGetInteger(POSITION_MAGIC)!=(long)MagicNumber||PositionGetString(POSITION_SYMBOL)!=g_symbol)continue;
      string kTp=TicketKey(ticket,"TP1"),kTr=TicketKey(ticket,"TRG");if(!GlobalVariableCheck(kTp)||!GlobalVariableCheck(kTr))continue;
      double tp1=GlobalVariableGet(kTp),trigger=GlobalVariableGet(kTr),sl=PositionGetDouble(POSITION_SL),tp=PositionGetDouble(POSITION_TP);long type=PositionGetInteger(POSITION_TYPE);
      bool reached=(type==POSITION_TYPE_BUY)?tick.bid>=trigger:tick.ask<=trigger;
      bool already=(type==POSITION_TYPE_BUY)?sl>=tp1:sl>0&&sl<=tp1;
      if(reached&&!already)
      {
         trade.SetExpertMagicNumber(MagicNumber);
         if(trade.PositionModify(ticket,tp1,tp))Print("[AUTO] SL MOVED ticket=",ticket," -> TP1 ",Num(tp1)," after 5 pip buffer.");
         else Print("[AUTO] SL move failed ticket=",ticket," retcode=",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
      }
   }
}

int OnInit()
{
   g_symbol=BridgeSymbol;if(StringLen(g_symbol)==0)g_symbol=_Symbol;
   if(StringFind(BridgeToken,"PASTE_")>=0||StringLen(BridgeToken)<16){Print("[OBFVG Bridge] BridgeToken has not been configured.");return INIT_PARAMETERS_INCORRECT;}
   if(!SymbolSelect(g_symbol,true)){Print("[OBFVG Bridge] Cannot select symbol: ",g_symbol);return INIT_FAILED;}
   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   g_currentM1Open=iTime(g_symbol,PERIOD_M1,0);EventSetTimer((int)MathMax(1,TimerSeconds));
   Print("[OBFVG Bridge] V2 starting for ",g_symbol,". API=",TrimSlash(ApiBaseUrl)," AutoExecution=",EnableAutoExecution?"ON":"OFF");
   SendBackfill();SendTick();return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer()
{
   datetime currentOpen=iTime(g_symbol,PERIOD_M1,0);
   if(currentOpen>0&&g_currentM1Open>0&&currentOpen!=g_currentM1Open){SendClosedM1();g_currentM1Open=currentOpen;}else if(g_currentM1Open==0&&currentOpen>0)g_currentM1Open=currentOpen;
   SendTick();PollCommands();ManageAutoPositions();
}
