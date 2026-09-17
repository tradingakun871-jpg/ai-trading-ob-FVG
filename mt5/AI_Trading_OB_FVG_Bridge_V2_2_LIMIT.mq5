#property strict
#property version   "2.20"
#property description "AI Trading OB+FVG M1/M3 Bridge V2.2 - broker-side first-touch LIMIT execution"
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

CTrade trade;
string g_symbol="";
datetime g_currentM1Open=0;

string I64(long v){return IntegerToString(v);}
string TrimSlash(string s){while(StringLen(s)>0 && StringSubstr(s,StringLen(s)-1,1)=="/")s=StringSubstr(s,0,StringLen(s)-1);return s;}
string Num(double v){int d=(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS);return DoubleToString(v,d);}
string EscapeJson(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");return s;}

bool HttpRequest(string method,string endpoint,string body,string &response)
{
   string url=TrimSlash(ApiBaseUrl)+endpoint;
   string headers="Content-Type: application/json\r\nX-Bridge-Token: "+BridgeToken+"\r\n";
   char data[];
   if(StringLen(body)>0){StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);}else ArrayResize(data,0);
   char result[];string result_headers;ResetLastError();
   int code=WebRequest(method,url,headers,HttpTimeoutMs,data,result,result_headers);
   if(code==-1){Print("[Bridge V2.2] WebRequest error=",GetLastError()," URL=",url);return false;}
   response=CharArrayToString(result,0,-1,CP_UTF8);
   if(code<200||code>=300){Print("[Bridge V2.2] HTTP ",code," ",endpoint," ",response);return false;}
   return true;
}
bool HttpPost(string ep,string json,string &resp){return HttpRequest("POST",ep,json,resp);}
bool HttpGet(string ep,string &resp){return HttpRequest("GET",ep,"",resp);}

string CandleJson(MqlRates &r)
{
   return "{\"time\":"+I64((long)r.time)+",\"open\":"+Num(r.open)+",\"high\":"+Num(r.high)+",\"low\":"+Num(r.low)+",\"close\":"+Num(r.close)+",\"volume\":"+I64((long)r.tick_volume)+"}";
}

bool SendBackfill()
{
   if(BackfillBars<=0)return true;
   MqlRates rates[];ArraySetAsSeries(rates,false);
   int copied=CopyRates(g_symbol,PERIOD_M1,1,BackfillBars,rates);
   if(copied<=0){Print("[Bridge V2.2] Backfill failed error=",GetLastError());return false;}
   string json="{\"symbol\":\""+g_symbol+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candles\":[";
   for(int i=0;i<copied;i++){if(i>0)json+=",";json+=CandleJson(rates[i]);}
   json+="]}";string resp;bool ok=HttpPost("/api/mt5/backfill",json,resp);
   if(ok)Print("[Bridge V2.2] Backfill OK ",copied);
   return ok;
}

bool SendClosedM1()
{
   MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(g_symbol,PERIOD_M1,1,1,r)!=1)return false;
   string json="{\"symbol\":\""+g_symbol+"\",\"timeframe\":\"M1\",\"autoAggregate\":true,\"candle\":"+CandleJson(r[0])+"}";
   string resp;return HttpPost("/api/mt5/webhook",json,resp);
}

bool SendTick()
{
   MqlTick t;if(!SymbolInfoTick(g_symbol,t))return false;
   string json="{\"symbol\":\""+g_symbol+"\",\"time\":"+I64((long)t.time)+",\"serverTime\":"+I64((long)TimeTradeServer())+",\"bid\":"+Num(t.bid)+",\"ask\":"+Num(t.ask)+"}";
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

void SaveLimitManagement(ulong orderTicket,double entry,double tp1,double trigger)
{
   GlobalVariableSet(GKey(orderTicket,"ENTRY"),entry);
   GlobalVariableSet(GKey(orderTicket,"TP1"),tp1);
   GlobalVariableSet(GKey(orderTicket,"TRG"),trigger);
}

void HandlePlaceLimit(string obj)
{
   string id=JsonValue(obj,"id"),setupId=JsonValue(obj,"setupId"),tf=JsonValue(obj,"timeframe"),symbol=JsonValue(obj,"symbol"),side=JsonValue(obj,"side");
   double entry=JsonNum(obj,"entry"),sl=JsonNum(obj,"sl"),tp1=JsonNum(obj,"tp1"),tp4=JsonNum(obj,"tp4"),pip=JsonNum(obj,"pipSize"),buffer=JsonNum(obj,"slMoveTriggerPips");
   if(id==""||setupId==""||tf==""||symbol==""||(side!="BUY"&&side!="SELL")||entry<=0||sl<=0||tp1<=0||tp4<=0){AckEx(id,"REJECTED",0,"invalid limit command",setupId,tf,side,entry,0);return;}
   if(symbol!=g_symbol){AckEx(id,"REJECTED",0,"symbol mismatch",setupId,tf,side,entry,0);return;}

   ulong existing=FindLimitOrder(tf,setupId);
   if(existing>0){AckEx(id,"PLACED",existing,"limit already exists",setupId,tf,side,entry,0);return;}

   MqlTick tick;if(!SymbolInfoTick(g_symbol,tick)){AckEx(id,"FAILED",0,"cannot read tick",setupId,tf,side,entry,0);return;}
   if(side=="BUY"&&entry>=tick.ask){AckEx(id,"MISSED",0,"BUY first-touch already reached/passed before LIMIT placement",setupId,tf,side,entry,0);return;}
   if(side=="SELL"&&entry<=tick.bid){AckEx(id,"MISSED",0,"SELL first-touch already reached/passed before LIMIT placement",setupId,tf,side,entry,0);return;}

   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   string comment=LimitComment(tf,setupId);bool ok=false;
   if(side=="BUY")ok=trade.BuyLimit(FixedLot,entry,g_symbol,sl,tp4,ORDER_TIME_GTC,0,comment);
   else ok=trade.SellLimit(FixedLot,entry,g_symbol,sl,tp4,ORDER_TIME_GTC,0,comment);
   if(!ok){string detail="retcode="+IntegerToString((int)trade.ResultRetcode())+" "+trade.ResultRetcodeDescription();Print("[LIMIT] PLACE FAILED ",id," ",detail);AckEx(id,"FAILED",0,detail,setupId,tf,side,entry,0);return;}

   ulong orderTicket=trade.ResultOrder();
   double trigger=(side=="BUY")?tp1+buffer*pip:tp1-buffer*pip;
   SaveLimitManagement(orderTicket,entry,tp1,trigger);
   Print("[LIMIT] PLACED id=",id," ticket=",orderTicket," side=",side," entry=",Num(entry)," SL=",Num(sl)," TP4=",Num(tp4));
   AckEx(id,"PLACED",orderTicket,"broker pending LIMIT armed",setupId,tf,side,entry,0);
}

void HandleCancelLimit(string obj)
{
   string id=JsonValue(obj,"id"),setupId=JsonValue(obj,"setupId"),tf=JsonValue(obj,"timeframe"),side=JsonValue(obj,"side");
   ulong ticket=FindLimitOrder(tf,setupId);
   if(ticket==0){AckEx(id,"CANCELLED",0,"pending order already absent",setupId,tf,side,0,0);return;}
   trade.SetExpertMagicNumber(MagicNumber);
   if(!trade.OrderDelete(ticket)){string detail="retcode="+IntegerToString((int)trade.ResultRetcode())+" "+trade.ResultRetcodeDescription();AckEx(id,"FAILED",ticket,detail,setupId,tf,side,0,0);return;}
   GlobalVariableDel(GKey(ticket,"ENTRY"));GlobalVariableDel(GKey(ticket,"TP1"));GlobalVariableDel(GKey(ticket,"TRG"));
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
   if(!EnableAutoExecution)return;MqlTick tick;if(!SymbolInfoTick(g_symbol,tick))return;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);if(ticket==0)continue;
      if(PositionGetInteger(POSITION_MAGIC)!=(long)MagicNumber)continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_symbol)continue;
      string ktp=GKey(ticket,"TP1"),ktr=GKey(ticket,"TRG");if(!GlobalVariableCheck(ktp)||!GlobalVariableCheck(ktr))continue;
      double tp1=GlobalVariableGet(ktp),trigger=GlobalVariableGet(ktr),sl=PositionGetDouble(POSITION_SL),tp=PositionGetDouble(POSITION_TP);long type=PositionGetInteger(POSITION_TYPE);
      bool reached=(type==POSITION_TYPE_BUY)?tick.bid>=trigger:tick.ask<=trigger;
      bool moved=(type==POSITION_TYPE_BUY)?sl>=tp1:(sl>0&&sl<=tp1);
      if(reached&&!moved)
      {
         trade.SetExpertMagicNumber(MagicNumber);
         if(trade.PositionModify(ticket,tp1,tp))Print("[AUTO] SL MOVED ticket=",ticket," -> TP1 ",Num(tp1));
         else Print("[AUTO] SL MOVE FAILED ticket=",ticket," ",trade.ResultRetcodeDescription());
      }
   }
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
   double fillPrice=HistoryDealGetDouble(trans.deal,DEAL_PRICE),plannedEntry=0,tp1=0,trigger=0;
   if(GlobalVariableCheck(GKey(orderTicket,"ENTRY")))plannedEntry=GlobalVariableGet(GKey(orderTicket,"ENTRY"));
   if(GlobalVariableCheck(GKey(orderTicket,"TP1")))tp1=GlobalVariableGet(GKey(orderTicket,"TP1"));
   if(GlobalVariableCheck(GKey(orderTicket,"TRG")))trigger=GlobalVariableGet(GKey(orderTicket,"TRG"));

   ulong positionId=(ulong)HistoryDealGetInteger(trans.deal,DEAL_POSITION_ID),positionTicket=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);if(t==0)continue;
      if(PositionGetInteger(POSITION_MAGIC)!=(long)MagicNumber||PositionGetString(POSITION_SYMBOL)!=g_symbol)continue;
      if((ulong)PositionGetInteger(POSITION_IDENTIFIER)==positionId){positionTicket=t;break;}
   }
   if(positionTicket==0)positionTicket=positionId;
   if(positionTicket>0&&tp1>0&&trigger>0){GlobalVariableSet(GKey(positionTicket,"TP1"),tp1);GlobalVariableSet(GKey(positionTicket,"TRG"),trigger);}

   Print("[LIMIT] FILLED setup=",setupId," position=",positionTicket," planned=",Num(plannedEntry)," fill=",Num(fillPrice));
   AckEx("fill-"+tf+"-"+setupId,"EXECUTED",positionTicket,"broker LIMIT filled",setupId,tf,side,plannedEntry,fillPrice);
}

int OnInit()
{
   g_symbol=BridgeSymbol;if(StringLen(g_symbol)==0)g_symbol=_Symbol;
   if(StringFind(BridgeToken,"PASTE_")>=0||StringLen(BridgeToken)<16){Print("[Bridge V2.2] Set BridgeToken first.");return INIT_PARAMETERS_INCORRECT;}
   if(!SymbolSelect(g_symbol,true))return INIT_FAILED;
   trade.SetExpertMagicNumber(MagicNumber);trade.SetDeviationInPoints(MaxDeviationPoints);
   g_currentM1Open=iTime(g_symbol,PERIOD_M1,0);EventSetTimer((int)MathMax(1,TimerSeconds));
   Print("[Bridge V2.2 LIMIT] START ",g_symbol," AutoExecution=",EnableAutoExecution," mode=FIRST_TOUCH_LIMIT");
   SendBackfill();SendTick();return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){EventKillTimer();}

void OnTimer()
{
   datetime currentOpen=iTime(g_symbol,PERIOD_M1,0);
   if(currentOpen>0&&g_currentM1Open>0&&currentOpen!=g_currentM1Open){SendClosedM1();g_currentM1Open=currentOpen;}
   else if(g_currentM1Open==0&&currentOpen>0)g_currentM1Open=currentOpen;
   SendTick();PollCommands();ManagePositions();
}
