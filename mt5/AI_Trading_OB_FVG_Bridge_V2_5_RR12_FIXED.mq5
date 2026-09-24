#property strict
#property version   "2.50"
#property description "AI Trading OB+FVG M1/M3 Bridge V2.5 - fixed RR 1:2, no SL+ / BE / trailing, persistent DXY"
#include <Trade/Trade.mqh>

input string ApiBaseUrl="https://ai-trading-ob-fvg-mtf-production.up.railway.app";
input string BridgeToken="PASTE_BRIDGE_TOKEN_HERE";
input string BridgeSymbol="XAUUSD";
input int BackfillBars=2000;
input int TimerSeconds=2;
input int HttpTimeoutMs=10000;

input bool EnableAutoExecution=false;
input double FixedLot=0.01;
input ulong MagicNumber=26091701;
input int MaxDeviationPoints=30;

// Fixed execution policy requested: SL remains at the original structural SL,
// TP is always exactly 2R from planned entry. No BE, SL+, trailing, or profit lock.
#define FIXED_RR 2.0

// DXY persistent shadow feed. Does not block M1/M3 entries by itself.
input bool EnableDxyFeed=true;
input string DxySymbol="AUTO";          // AUTO, DXY, USDX, or broker-specific symbol
input int DxyBackfillBars=240;          // >=21 recommended; 240 gives recovery context
input int DxyRefreshMinutes=1;          // periodic reseed after Railway/container restart
input int DxyTickSeconds=2;              // send live DXY bid/ask; keeps Railway DXY freshness valid

CTrade trade;
string g_symbol="";
string g_dxySymbol="";
datetime g_currentM1Open=0;
datetime g_currentDxyM1Open=0;
datetime g_lastDxyBackfillAttempt=0;

string I64(long v){return IntegerToString(v);}
string TrimSlash(string s){while(StringLen(s)>0 && StringSubstr(s,StringLen(s)-1,1)=="/")s=StringSubstr(s,0,StringLen(s)-1);return s;}
string NumFor(string symbol,double v){int d=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);if(d<0)d=5;return DoubleToString(v,d);}
string Num(double v){return NumFor(g_symbol,v);}
string EscapeJson(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");return s;}

bool HttpRequest(string method,string endpoint,string body,string &response)
{
   string url=TrimSlash(ApiBaseUrl)+endpoint;
   string headers="Content-Type: application/json\r\nX-Bridge-Token: "+BridgeToken+"\r\n";
   char data[];
   if(StringLen(body)>0){StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);}else ArrayResize(data,0);
   char result[];string result_headers;ResetLastError();
   int code=WebRequest(method,url,headers,HttpTimeoutMs,data,result,result_headers);
   if(code==-1){Print("[Bridge V2.5] WebRequest error=",GetLastError()," URL=",url);return false;}
   response=CharArrayToString(result,0,-1,CP_UTF8);
   if(code<200||code>=300){Print("[Bridge V2.5] HTTP ",code," ",endpoint," ",response);return false;}
   return true;
}
bool HttpPost(string ep,string json,string &resp){return HttpRequest("POST",ep,json,resp);}
bool HttpGet(string ep,string &resp){return HttpRequest("GET",ep,"",resp);}

string CandleJsonForSymbol(MqlRates &r,string symbol)
{
   return "{\"time\":"+I64((long)r.time)+",\"open\":"+NumFor(symbol,r.open)+",\"high\":"+NumFor(symbol,r.high)+",\"low\":"+NumFor(symbol,r.low)+",\"close\":"+NumFor(symbol,r.close)+",\"volume\":"+I64((long)r.tick_volume)+"}";
}
string CandleJson(MqlRates &r){return CandleJsonForSymbol(r,g_symbol);}

int DxyNameScore(string name)
{
   string u=name;StringToUpper(u);
   if(StringFind(u,"DXY")>=0)return 100;
   if(StringFind(u,"USDX")>=0)return 95;
   if(StringFind(u,"USDOLLAR")>=0)return 90;
   if(StringFind(u,"USDINDEX")>=0)return 85;
   if(u=="DX"||StringFind(u,"DX.")==0||StringFind(u,"DX_")==0||StringFind(u,"DX#")==0)return 70;
   return 0;
}

string DetectDxySymbol()
{
   string configured=DxySymbol,uc=configured;StringToUpper(uc);
   if(StringLen(configured)>0&&uc!="AUTO")
   {
      if(SymbolSelect(configured,true))return configured;
      Print("[DXY V2.5] Configured symbol not available: ",configured,". Falling back to AUTO.");
   }

   string preferred[4]={"DXY","USDX","USDOLLAR","USDINDEX"};
   for(int p=0;p<4;p++)if(SymbolSelect(preferred[p],true))return preferred[p];

   int total=SymbolsTotal(false),bestScore=0;string best="";
   for(int i=0;i<total;i++)
   {
      string name=SymbolName(i,false);int score=DxyNameScore(name);
      if(score<=bestScore)continue;
      if(SymbolSelect(name,true)){best=name;bestScore=score;}
   }
   return best;
}

bool SendBackfill()
{
   if(BackfillBars<=0)return true;
   MqlRates rates[];ArraySetAsSeries(rates,false);
   int copied=CopyRates(g_symbol,PERIOD_M1,1,BackfillBars,rates);
   if(copied<=0){Print("[Bridge V2.5] XAU backfill failed error=",GetLastError());return false;}
   string json="{\"symbol\":\""+EscapeJson(g_symbol)+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candles\":[";
   for(int i=0;i<copied;i++){if(i>0)json+=",";json+=CandleJson(rates[i]);}
   json+="]}";string resp;bool ok=HttpPost("/api/mt5/backfill",json,resp);
   if(ok)Print("[Bridge V2.5] XAU backfill OK ",copied);
   return ok;
}

bool SendDxyBackfill()
{
   if(!EnableDxyFeed||g_dxySymbol=="")return false;
   g_lastDxyBackfillAttempt=TimeCurrent();
   int bars=(int)MathMax(30,DxyBackfillBars);
   MqlRates rates[];ArraySetAsSeries(rates,false);
   int copied=CopyRates(g_dxySymbol,PERIOD_M1,1,bars,rates);
   if(copied<=0){Print("[DXY V2.5] Backfill failed symbol=",g_dxySymbol," error=",GetLastError());return false;}
   MqlTick t;double bid=0,ask=0;if(SymbolInfoTick(g_dxySymbol,t)){bid=t.bid;ask=t.ask;}
   string json="{\"symbol\":\""+EscapeJson(g_dxySymbol)+"\",\"bid\":"+NumFor(g_dxySymbol,bid)+",\"ask\":"+NumFor(g_dxySymbol,ask)+",\"candles\":[";
   for(int i=0;i<copied;i++){if(i>0)json+=",";json+=CandleJsonForSymbol(rates[i],g_dxySymbol);}
   json+="]}";string resp;bool ok=HttpPost("/api/mt5/dxy-candle",json,resp);
   if(ok)Print("[DXY V2.5] Backfill OK symbol=",g_dxySymbol," bars=",copied);
   return ok;
}

bool SendClosedM1()
{
   MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(g_symbol,PERIOD_M1,1,1,r)!=1)return false;
   string json="{\"symbol\":\""+EscapeJson(g_symbol)+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candle\":"+CandleJson(r[0])+"}";
   string resp;return HttpPost("/api/mt5/webhook",json,resp);
}

bool SendDxyTick()
{
   if(!EnableDxyFeed||g_dxySymbol=="")return false;
   MqlTick t;if(!SymbolInfoTick(g_dxySymbol,t)||t.bid<=0)return false;
   string json="{\"symbol\":\""+EscapeJson(g_dxySymbol)+"\",\"bid\":"+NumFor(g_dxySymbol,t.bid)+",\"ask\":"+NumFor(g_dxySymbol,t.ask)+",\"tickOnly\":true,\"time\":"+I64((long)t.time)+"}";
   string resp;bool ok=HttpPost("/api/mt5/dxy-candle",json,resp);
   if(!ok)Print("[DXY V2.5] LIVE tick send failed symbol=",g_dxySymbol);
   return ok;
}

bool SendClosedDxyM1()
{
   if(!EnableDxyFeed||g_dxySymbol=="")return false;
   MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(g_dxySymbol,PERIOD_M1,1,1,r)!=1)return false;
   MqlTick t;double bid=0,ask=0;if(SymbolInfoTick(g_dxySymbol,t)){bid=t.bid;ask=t.ask;}
   string json="{\"symbol\":\""+EscapeJson(g_dxySymbol)+"\",\"bid\":"+NumFor(g_dxySymbol,bid)+",\"ask\":"+NumFor(g_dxySymbol,ask)+",\"candle\":"+CandleJsonForSymbol(r[0],g_dxySymbol)+"}";
   string resp;bool ok=HttpPost("/api/mt5/dxy-candle",json,resp);
   if(ok)Print("[DXY V2.5] Closed M1 sent ",g_dxySymbol," ",TimeToString(r[0].time,TIME_DATE|TIME_MINUTES));
   return ok;
}

bool SendTick()
{
   MqlTick t;if(!SymbolInfoTick(g_symbol,t))return false;
   string json="{\"symbol\":\""+EscapeJson(g_symbol)+"\",\"time\":"+I64((long)t.time)+",\"serverTime\":"+I64((long)TimeTradeServer())+",\"bid\":"+Num(t.bid)+",\"ask\":"+Num(t.ask)+"}";
   string resp;return HttpPost("/api/mt5/tick",json,resp);
}

string JsonValue(string src,string key)
{
   string n="\""+key+"\":";int p=StringFind(src,n);if(p<0)return "";
   p+=StringLen(n);while(p<StringLen(src)&&StringSubstr(src,p,1)==" ")p++;
   if(StringSubstr(src,p,1)=="\""){p++;int e=StringFind(src,"\"",p);if(e<0)return "";return StringSubstr(src,p,e-p);}
   int e=p;while(e<StringLen(src)){string c=StringSubstr(src,e,1);if(c==","||c=="}")break;e++;}
   return StringSubstr(src,p,e-p);
}
double JsonNum(string src,string key){return StringToDouble(JsonValue(src,key));}

void AckEx(string id,string status,ulong ticket,string detail,string setupId,string tf,string side,double entry,double fillPrice)
{
   string json="{\"id\":\""+EscapeJson(id)+"\",\"status\":\""+EscapeJson(status)+"\",\"ticket\":"+I64((long)ticket)+",\"detail\":\""+EscapeJson(detail)+"\",\"setupId\":\""+EscapeJson(setupId)+"\",\"timeframe\":\""+EscapeJson(tf)+"\",\"side\":\""+EscapeJson(side)+"\",\"entry\":"+Num(entry)+",\"fillPrice\":"+Num(fillPrice)+"}";
   string resp;HttpPost("/api/mt5/commands/ack",json,resp);
}

string GKey(ulong ticket,string suffix){return "OBFVG_"+I64((long)MagicNumber)+"_"+I64((long)ticket)+"_"+suffix;}
string LimitComment(string tf,string setupId){return "OBL|"+tf+"|"+setupId;}

bool ParseLimitComment(string comment,string &tf,string &setupId)
{
   if(StringFind(comment,"OBL|")!=0)return false;
   int p=StringFind(comment,"|",4);if(p<0)return false;
   tf=StringSubstr(comment,4,p-4);setupId=StringSubstr(comment,p+1);
   return StringLen(tf)>0&&StringLen(setupId)>0;
}

ulong FindManagedPosition(string tf,string setupId)
{
   string want=LimitComment(tf,setupId);
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);if(ticket==0)continue;
      if(PositionGetInteger(POSITION_MAGIC)!=(long)MagicNumber)continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_symbol)continue;
      if(PositionGetString(POSITION_COMMENT)==want)return ticket;
   }
   return 0;
}

ulong FindLimitOrder(string tf,string setupId)
{
   string want=LimitComment(tf,setupId);
   for(int i=OrdersTotal()-1;i>=0;i--)
   {
      ulong ticket=OrderGetTicket(i);if(ticket==0)continue;
      if(OrderGetInteger(ORDER_MAGIC)!=(long)MagicNumber)continue;
      if(OrderGetString(ORDER_SYMBOL)!=g_symbol)continue;
      if(OrderGetString(ORDER_COMMENT)==want)return ticket;
   }
   return 0;
}

void HandlePlaceLimit(string obj)
{
   string id=JsonValue(obj,"id"),setupId=JsonValue(obj,"setupId"),tf=JsonValue(obj,"timeframe"),symbol=JsonValue(obj,"symbol"),side=JsonValue(obj,"side");
   double entry=JsonNum(obj,"entry"),sl=JsonNum(obj,"sl");
   double risk=MathAbs(entry-sl);
   double fixedTp=(side=="BUY")?entry+risk*FIXED_RR:entry-risk*FIXED_RR;

   if(id==""||setupId==""||tf==""||symbol==""||(side!="BUY"&&side!="SELL")||entry<=0||sl<=0||risk<=0||fixedTp<=0){AckEx(id,"REJECTED",0,"invalid fixed RR 1:2 limit command",setupId,tf,side,entry,0);return;}
   if(side=="BUY"&&sl>=entry){AckEx(id,"REJECTED",0,"BUY structural SL must be below entry",setupId,tf,side,entry,0);return;}
   if(side=="SELL"&&sl<=entry){AckEx(id,"REJECTED",0,"SELL structural SL must be above entry",setupId,tf,side,entry,0);return;}
   if(symbol!=g_symbol){AckEx(id,"REJECTED",0,"symbol mismatch",setupId,tf,side,entry,0);return;}

   ulong pos=FindManagedPosition(tf,setupId);
   if(pos>0){double fill=0;if(PositionSelectByTicket(pos))fill=PositionGetDouble(POSITION_PRICE_OPEN);AckEx(id,"EXECUTED",pos,"position already exists - recovery acknowledged",setupId,tf,side,entry,fill);return;}
   ulong existing=FindLimitOrder(tf,setupId);
   if(existing>0){AckEx(id,"PLACED",existing,"limit already exists - recovery acknowledged",setupId,tf,side,entry,0);return;}

   MqlTick tick;if(!SymbolInfoTick(g_symbol,tick)){AckEx(id,"FAILED",0,"cannot read tick",setupId,tf,side,entry,0);return;}
   if(side=="BUY"&&entry>=tick.ask){AckEx(id,"MISSED",0,"BUY first-touch already reached/passed before LIMIT placement",setupId,tf,side,entry,0);return;}
   if(side=="SELL"&&entry<=tick.bid){AckEx(id,"MISSED",0,"SELL first-touch already reached/passed before LIMIT placement",setupId,tf,side,entry,0);return;}

   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   string comment=LimitComment(tf,setupId);bool ok=false;
   if(side=="BUY")ok=trade.BuyLimit(FixedLot,entry,g_symbol,sl,fixedTp,ORDER_TIME_GTC,0,comment);
   else ok=trade.SellLimit(FixedLot,entry,g_symbol,sl,fixedTp,ORDER_TIME_GTC,0,comment);
   if(!ok){string detail="retcode="+IntegerToString((int)trade.ResultRetcode())+" "+trade.ResultRetcodeDescription();Print("[LIMIT] PLACE FAILED ",id," ",detail);AckEx(id,"FAILED",0,detail,setupId,tf,side,entry,0);return;}

   ulong orderTicket=trade.ResultOrder();
   GlobalVariableSet(GKey(orderTicket,"ENTRY"),entry);
   Print("[LIMIT] PLACED FIXED_RR12 id=",id," ticket=",orderTicket," side=",side," entry=",Num(entry)," SL=",Num(sl)," TP=",Num(fixedTp)," NO_SL_PLUS");
   AckEx(id,"PLACED",orderTicket,"broker pending LIMIT armed fixed RR 1:2 no SL+",setupId,tf,side,entry,0);
}

void HandleCancelLimit(string obj)
{
   string id=JsonValue(obj,"id"),setupId=JsonValue(obj,"setupId"),tf=JsonValue(obj,"timeframe"),side=JsonValue(obj,"side");
   ulong ticket=FindLimitOrder(tf,setupId);
   if(ticket==0){AckEx(id,"CANCELLED",0,"pending order already absent",setupId,tf,side,0,0);return;}
   trade.SetExpertMagicNumber(MagicNumber);
   if(!trade.OrderDelete(ticket)){string detail="retcode="+IntegerToString((int)trade.ResultRetcode())+" "+trade.ResultRetcodeDescription();AckEx(id,"FAILED",ticket,detail,setupId,tf,side,0,0);return;}
   string cleanKeys[10]={"ENTRY","TP1","TP2","TP3","TP4","P1","P2","P3","P4","TRG"};
   for(int ck=0;ck<10;ck++)GlobalVariableDel(GKey(ticket,cleanKeys[ck]));
   Print("[LIMIT] CANCELLED id=",id," ticket=",ticket," setup=",setupId);
   AckEx(id,"CANCELLED",ticket,"invalidated/expired/replaced",setupId,tf,side,0,0);
}

void ExecuteCommand(string obj)
{
   string action=JsonValue(obj,"action");
   if(action=="PLACE_LIMIT")HandlePlaceLimit(obj);
   else if(action=="CANCEL_LIMIT")HandleCancelLimit(obj);
}

void PollCommands()
{
   if(!EnableAutoExecution)return;
   string response;if(!HttpGet("/api/mt5/limit-commands",response))return;
   int p=StringFind(response,"\"commands\":[");if(p<0)return;p+=StringLen("\"commands\":[");
   while(p<StringLen(response))
   {
      int s=StringFind(response,"{",p);if(s<0)break;int depth=0,e=-1;
      for(int i=s;i<StringLen(response);i++){string c=StringSubstr(response,i,1);if(c=="{")depth++;else if(c=="}"){depth--;if(depth==0){e=i;break;}}}
      if(e<0)break;ExecuteCommand(StringSubstr(response,s,e-s+1));p=e+1;
   }
}

void ManagePositions()
{
   // Intentionally empty in V2.5.
   // Once a LIMIT is filled, broker SL and TP stay fixed until either SL or TP is hit.
   // No breakeven, no SL+, no trailing stop, no TP-probability profit lock.
}

void OnTradeTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request,const MqlTradeResult &result)
{
   if(trans.type!=TRADE_TRANSACTION_DEAL_ADD||trans.deal==0)return;
   if(!HistoryDealSelect(trans.deal))return;
   if(HistoryDealGetInteger(trans.deal,DEAL_MAGIC)!=(long)MagicNumber)return;
   long entryType=HistoryDealGetInteger(trans.deal,DEAL_ENTRY);if(entryType!=DEAL_ENTRY_IN&&entryType!=DEAL_ENTRY_INOUT)return;

   ulong orderTicket=(ulong)HistoryDealGetInteger(trans.deal,DEAL_ORDER);
   string comment=HistoryDealGetString(trans.deal,DEAL_COMMENT);
   if(StringFind(comment,"OBL|")!=0&&orderTicket>0&&HistoryOrderSelect(orderTicket))comment=HistoryOrderGetString(orderTicket,ORDER_COMMENT);
   string tf="",setupId="";if(!ParseLimitComment(comment,tf,setupId))return;

   long dealType=HistoryDealGetInteger(trans.deal,DEAL_TYPE);string side=(dealType==DEAL_TYPE_BUY)?"BUY":"SELL";
   double fillPrice=HistoryDealGetDouble(trans.deal,DEAL_PRICE),plannedEntry=0;
   if(GlobalVariableCheck(GKey(orderTicket,"ENTRY")))plannedEntry=GlobalVariableGet(GKey(orderTicket,"ENTRY"));
   if(plannedEntry<=0&&orderTicket>0&&HistoryOrderSelect(orderTicket))plannedEntry=HistoryOrderGetDouble(orderTicket,ORDER_PRICE_OPEN);

   ulong positionId=(ulong)HistoryDealGetInteger(trans.deal,DEAL_POSITION_ID),positionTicket=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);if(t==0)continue;
      if(PositionGetInteger(POSITION_MAGIC)!=(long)MagicNumber||PositionGetString(POSITION_SYMBOL)!=g_symbol)continue;
      if((ulong)PositionGetInteger(POSITION_IDENTIFIER)==positionId){positionTicket=t;break;}
   }
   if(positionTicket==0)positionTicket=positionId;

   Print("[LIMIT] FILLED FIXED_RR12 setup=",setupId," position=",positionTicket," planned=",Num(plannedEntry)," fill=",Num(fillPrice)," NO_SL_PLUS");
   AckEx("fill-"+tf+"-"+setupId,"EXECUTED",positionTicket,"broker LIMIT filled fixed RR 1:2 no SL+",setupId,tf,side,plannedEntry,fillPrice);
}

int OnInit()
{
   g_symbol=BridgeSymbol;if(StringLen(g_symbol)==0)g_symbol=_Symbol;
   if(StringFind(BridgeToken,"PASTE_")>=0||StringLen(BridgeToken)<16){Print("[Bridge V2.5] Set BridgeToken first.");return INIT_PARAMETERS_INCORRECT;}
   if(!SymbolSelect(g_symbol,true))return INIT_FAILED;
   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   g_currentM1Open=iTime(g_symbol,PERIOD_M1,0);

   if(EnableDxyFeed)
   {
      g_dxySymbol=DetectDxySymbol();
      if(g_dxySymbol=="")Print("[DXY V2.5] No DXY/USDX symbol detected. Set DxySymbol manually to broker symbol.");
      else
      {
         g_currentDxyM1Open=iTime(g_dxySymbol,PERIOD_M1,0);
         Print("[DXY V2.5] ACTIVE symbol=",g_dxySymbol," backfillBars=",DxyBackfillBars," refresh=",DxyRefreshMinutes,"m");
      }
   }

   EventSetTimer((int)MathMax(1,TimerSeconds));
   Print("[Bridge V2.5 LIMIT] START ",g_symbol," AutoExecution=",EnableAutoExecution," mode=FIRST_TOUCH_LIMIT FIXED_RR=1:2 NO_SL_PLUS DXY=",(g_dxySymbol==""?"OFF":g_dxySymbol));
   SendBackfill();
   if(g_dxySymbol!="")SendDxyBackfill();
   SendTick();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){EventKillTimer();}

void OnTimer()
{
   datetime currentOpen=iTime(g_symbol,PERIOD_M1,0);
   if(currentOpen>0&&g_currentM1Open>0&&currentOpen!=g_currentM1Open){SendClosedM1();g_currentM1Open=currentOpen;}
   else if(g_currentM1Open==0&&currentOpen>0)g_currentM1Open=currentOpen;

   if(EnableDxyFeed&&g_dxySymbol!="")
   {
      datetime dxyOpen=iTime(g_dxySymbol,PERIOD_M1,0);
      if(dxyOpen>0&&g_currentDxyM1Open>0&&dxyOpen!=g_currentDxyM1Open){SendClosedDxyM1();g_currentDxyM1Open=dxyOpen;}
      else if(g_currentDxyM1Open==0&&dxyOpen>0)g_currentDxyM1Open=dxyOpen;

      // Live DXY must be pushed independently from the 1-minute candle/backfill.
      // Railway uses lastSeen freshness for the execution gate; without this the
      // server can receive valid DXY candles yet still report WAIT_DXY_LIVE.
      SendDxyTick();

      int refreshSec=(int)MathMax(60,DxyRefreshMinutes*60);
      if(g_lastDxyBackfillAttempt==0||TimeCurrent()-g_lastDxyBackfillAttempt>=refreshSec)SendDxyBackfill();
   }

   SendTick();PollCommands();ManagePositions();
}
