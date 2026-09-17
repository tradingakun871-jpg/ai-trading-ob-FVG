import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');
const marker = "app.post('/api/telegram/test',async(q,r)=>{";
const legacyMarker = "app.post('/api/telegram/test', async (req,res) => {";
const uiRoute = `app.post('/api/telegram/test-ui', async (req,res) => { if (!telegramReady()) return res.status(409).json({ok:false,error:'Telegram is not configured on server.'}); const raw=String(req.body?.message||'✅ AI Trading OB+FVG Telegram test berhasil.').trim(); const ok=await sendTelegram(raw.slice(0,500),{event:'TEST'}); res.status(ok?200:502).json({ok,apiMs:telegramMetrics.lastApiMs}); });\n`;
const dailyTestRoute = `app.post('/api/telegram/daily-test', async (_req,res) => { if (!telegramReady()) return res.status(409).json({ok:false,error:'Telegram is not configured on server.'}); const ok=await sendDailySetupReport('MANUAL_TEST'); res.status(ok?200:502).json({ok,event:'DAILY_SETUP',apiMs:telegramMetrics.lastApiMs}); });\n`;
let source=fs.readFileSync(serverPath,'utf8');
const routeMarker=source.includes(marker)?marker:legacyMarker;
if(!source.includes(routeMarker))throw new Error('Telegram route marker not found');
if(!source.includes("app.post('/api/telegram/test-ui'"))source=source.replace(routeMarker,uiRoute+routeMarker);
if(!source.includes("app.post('/api/telegram/daily-test'"))source=source.replace(routeMarker,dailyTestRoute+routeMarker);

source=source.replace("TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||'';","TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||'', TELEGRAM_GROUP_CHAT_ID=process.env.TELEGRAM_GROUP_CHAT_ID||'';");
const oldSend="async function sendTelegram(text,meta={}){if(!telegramReady())return false;const started=Date.now();try{const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:true})});const apiMs=Date.now()-started;if(!r.ok){console.error('Telegram send failed:',r.status,await r.text());return false}Object.assign(telegramMetrics,{lastSentAt:Date.now(),lastApiMs:apiMs,lastEvent:meta.event||'MESSAGE',lastTimeframe:meta.tf||null});console.log(`Telegram sent event=${telegramMetrics.lastEvent} tf=${telegramMetrics.lastTimeframe||'-'} apiMs=${apiMs}`);return true}catch(e){console.error('Telegram error:',e.message);return false}}";
const dualSend="async function sendTelegram(text,meta={}){if(!telegramReady())return false;const started=Date.now();const targets=[['PRIVATE',TELEGRAM_CHAT_ID],['GROUP',TELEGRAM_GROUP_CHAT_ID]].filter(([,id])=>Boolean(id));let allOk=true;try{for(const [label,chatId] of targets){const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});if(!r.ok){allOk=false;console.error(`Telegram ${label} send failed:`,r.status,await r.text())}else console.log(`Telegram destination=${label} delivered`)}const apiMs=Date.now()-started;Object.assign(telegramMetrics,{lastSentAt:allOk?Date.now():telegramMetrics.lastSentAt,lastApiMs:apiMs,lastEvent:meta.event||'MESSAGE',lastTimeframe:meta.tf||null});return allOk}catch(e){console.error('Telegram error:',e.message);return false}}";
if(!source.includes('TELEGRAM_GROUP_CHAT_ID'))throw new Error('Telegram group variable patch failed');
if(source.includes(oldSend))source=source.replace(oldSend,dualSend);

const autoExecPrelude=`
const AUTO_TRADE=String(process.env.AUTO_TRADE||'false').toLowerCase()==='true';
const mt5Exec={queue:[],seen:new Set(),acked:new Map(),lastPoll:null,lastAck:null};
async function sendMt5Private(text,meta={}){if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return false;const started=Date.now();try{const resp=await fetch(\`https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage\`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:true})});const apiMs=Date.now()-started;if(!resp.ok){console.error('Telegram PRIVATE MT5 send failed:',resp.status,await resp.text());return false}Object.assign(telegramMetrics,{lastSentAt:Date.now(),lastApiMs:apiMs,lastEvent:meta.event||'MT5_EXECUTION',lastTimeframe:meta.tf||null});return true}catch(e){console.error('Telegram PRIVATE MT5 error:',e.message);return false}}
function enqueueMt5Order(tf,t){if(!AUTO_TRADE||!t||mt5Exec.seen.has(t.id))return;mt5Exec.seen.add(t.id);mt5Exec.queue.push({id:String(t.id),symbol:engines[tf].config.symbol,timeframe:tf,side:String(t.dir).toUpperCase(),entry:Number(t.entry),sl:Number(t.sl),tp1:Number(t.tps[0]),tp2:Number(t.tps[1]),tp3:Number(t.tps[2]),tp4:Number(t.tps[3]),pipSize:Number(engines[tf].config.pipSize||0.1),slMoveTriggerPips:5,slMoveTo:'TP1',createdAt:Date.now()});console.log(\`MT5 auto execution queued id=\${t.id} tf=\${tf} side=\${String(t.dir).toUpperCase()}\`)}
`;
if(!source.includes('const mt5Exec='))source=source.replace("const mt5={lastSeen:null",autoExecPrelude+"\nconst mt5={lastSeen:null");
const dispatchNeedle="if(!p){transitions++;void sendTelegram(entryMessage(tf,t),{event:'ENTRY',tf});continue}";
const dispatchReplacement="if(!p){transitions++;enqueueMt5Order(tf,t);void sendTelegram(entryMessage(tf,t),{event:'ENTRY',tf});continue}";
if(source.includes(dispatchNeedle))source=source.replace(dispatchNeedle,dispatchReplacement);else if(!source.includes('enqueueMt5Order(tf,t)'))throw new Error('MT5 auto execution entry hook marker not found');

// Realtime execution uses actual MT5 sides: BUY trigger on Ask, SELL trigger on Bid.
const oldRealtime="function processRealtimeTick(price,time){let changed=false,transitions=0;for(const tf of TFS){const e=engines[tf],bt=tradeMap(e),bp=pendingSet(e),r=e.processTick({price,time});if(!r.changed)continue;changed=true;transitions+=dispatchTransitions(tf,bt,bp)}if(changed){mt5.lastRealtimeTransition=Date.now();scheduleDbSync()}return{changed,transitions}}";
const newRealtime="function processRealtimeTick(bid,ask,time){let changed=false,transitions=0;for(const tf of TFS){const e=engines[tf],bt=tradeMap(e),bp=pendingSet(e),r=e.processTick({bid,ask,price:bid,time});if(!r.changed)continue;changed=true;transitions+=dispatchTransitions(tf,bt,bp)}if(changed){mt5.lastRealtimeTransition=Date.now();scheduleDbSync()}return{changed,transitions}}";
if(source.includes(oldRealtime))source=source.replace(oldRealtime,newRealtime);else if(!source.includes('function processRealtimeTick(bid,ask,time)'))throw new Error('Realtime bid/ask patch marker not found');
const oldTick="const price=Number.isFinite(Number(mt5.bid))?Number(mt5.bid):Number(mt5.ask),realtime=Number.isFinite(price)?processRealtimeTick(price,mt5.lastTick):{changed:false,transitions:0};";
const newTick="const bid=Number(mt5.bid),ask=Number(mt5.ask),realtime=(Number.isFinite(bid)||Number.isFinite(ask))?processRealtimeTick(bid,ask,mt5.lastTick):{changed:false,transitions:0};";
if(source.includes(oldTick))source=source.replace(oldTick,newTick);else if(!source.includes('processRealtimeTick(bid,ask,mt5.lastTick)'))throw new Error('MT5 tick bid/ask route patch marker not found');

const autoExecRoutes=`
app.get('/api/mt5/commands',(q,r)=>{if(!requireBridge(q,r))return;mt5Exec.lastPoll=Date.now();if(!AUTO_TRADE)return r.json({ok:true,autoTrade:false,commands:[]});r.json({ok:true,autoTrade:true,commands:mt5Exec.queue.slice(0,10)});});
app.post('/api/mt5/commands/ack',(q,r)=>{if(!requireBridge(q,r))return;const b=q.body||{},id=String(b.id||'');if(!id)return r.status(400).json({ok:false,error:'id required'});if(mt5Exec.acked.has(id))return r.json({ok:true,duplicate:true});const idx=mt5Exec.queue.findIndex(x=>x.id===id);const cmd=idx>=0?mt5Exec.queue[idx]:null;if(idx>=0)mt5Exec.queue.splice(idx,1);mt5Exec.acked.set(id,{...b,ackedAt:Date.now()});if(mt5Exec.acked.size>500)mt5Exec.acked.delete(mt5Exec.acked.keys().next().value);mt5Exec.lastAck=Date.now();const status=String(b.status||'UNKNOWN').toUpperCase(),ticket=String(b.ticket||'-'),detail=String(b.detail||'-');console.log(\`MT5 execution ack id=\${id} status=\${status} ticket=\${ticket}\`);const tf=cmd?.timeframe||'-',side=cmd?.side||'-';if(status==='EXECUTED'){void sendMt5Private(\`✅ MT5 EXECUTED\\nSymbol: \${cmd?.symbol||'XAUUSD'}\\nTF: \${tf}\\nSide: \${side}\\nTicket: \${ticket}\\nEntry AI: \${cmd?.entry??'-'}\\nSL: \${cmd?.sl??'-'}\\nTP1: \${cmd?.tp1??'-'}\\nTP4: \${cmd?.tp4??'-'}\\nManagement: TP1 + 5 pips → SL ke TP1\\nSignal ID: \${id}\`,{event:'MT5_EXECUTED',tf})}else if(status==='FAILED'||status==='REJECTED'){void sendMt5Private(\`❌ MT5 \${status}\\nSymbol: \${cmd?.symbol||'XAUUSD'}\\nTF: \${tf}\\nSide: \${side}\\nTicket: \${ticket}\\nReason: \${detail}\\nSignal ID: \${id}\`,{event:'MT5_'+status,tf})}r.json({ok:true})});
app.get('/api/mt5/auto-status',(q,r)=>{if(!requireBridge(q,r))return;r.json({ok:true,autoTrade:AUTO_TRADE,queued:mt5Exec.queue.length,acked:mt5Exec.acked.size,lastPoll:mt5Exec.lastPoll,lastAck:mt5Exec.lastAck,management:'MT5 only: TP1 + 5 pips => SL moves to TP1'});});
`;
if(!source.includes("app.get('/api/mt5/commands'"))source=source.replace("app.get('/api/health'",autoExecRoutes+"\napp.get('/api/health'");
fs.writeFileSync(serverPath,source,'utf8');
await import('./server.js');
