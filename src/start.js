import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

// Runtime compatibility routes. Trading strategy logic is untouched.
const marker = "app.post('/api/telegram/test',async(q,r)=>{";
const legacyMarker = "app.post('/api/telegram/test', async (req,res) => {";
const uiRoute = `app.post('/api/telegram/test-ui', async (req,res) => {
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured on server.' });
  const raw = String(req.body?.message || '✅ AI Trading OB+FVG Telegram test berhasil.').trim();
  const message = raw.slice(0, 500);
  const ok = await sendTelegram(message, {event:'TEST'});
  res.status(ok ? 200 : 502).json({ ok, apiMs:telegramMetrics.lastApiMs });
});

`;
const dailyTestRoute = `app.post('/api/telegram/daily-test', async (_req,res) => {
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured on server.' });
  const ok = await sendDailySetupReport('MANUAL_TEST');
  res.status(ok ? 200 : 502).json({ ok, event:'DAILY_SETUP', apiMs:telegramMetrics.lastApiMs });
});

`;

let source = fs.readFileSync(serverPath, 'utf8');
const routeMarker = source.includes(marker) ? marker : legacyMarker;
if (!source.includes(routeMarker)) throw new Error('Telegram route marker not found');
if (!source.includes("app.post('/api/telegram/test-ui'")) source = source.replace(routeMarker, uiRoute + routeMarker);
if (!source.includes("app.post('/api/telegram/daily-test'")) source = source.replace(routeMarker, dailyTestRoute + routeMarker);

// Add a second Telegram destination while preserving the existing private Chat ID.
source = source.replace(
  "TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||'';",
  "TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID||'', TELEGRAM_GROUP_CHAT_ID=process.env.TELEGRAM_GROUP_CHAT_ID||'';"
);
const oldSend = "async function sendTelegram(text,meta={}){if(!telegramReady())return false;const started=Date.now();try{const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:true})});const apiMs=Date.now()-started;if(!r.ok){console.error('Telegram send failed:',r.status,await r.text());return false}Object.assign(telegramMetrics,{lastSentAt:Date.now(),lastApiMs:apiMs,lastEvent:meta.event||'MESSAGE',lastTimeframe:meta.tf||null});console.log(`Telegram sent event=${telegramMetrics.lastEvent} tf=${telegramMetrics.lastTimeframe||'-'} apiMs=${apiMs}`);return true}catch(e){console.error('Telegram error:',e.message);return false}}";
const dualSend = "async function sendTelegram(text,meta={}){if(!telegramReady())return false;const started=Date.now();const targets=[['PRIVATE',TELEGRAM_CHAT_ID],['GROUP',TELEGRAM_GROUP_CHAT_ID]].filter(([,id])=>Boolean(id));let allOk=true;try{for(const [label,chatId] of targets){const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});if(!r.ok){allOk=false;console.error(`Telegram ${label} send failed:`,r.status,await r.text())}else console.log(`Telegram destination=${label} delivered`)}const apiMs=Date.now()-started;Object.assign(telegramMetrics,{lastSentAt:allOk?Date.now():telegramMetrics.lastSentAt,lastApiMs:apiMs,lastEvent:meta.event||'MESSAGE',lastTimeframe:meta.tf||null});console.log(`Telegram sent event=${telegramMetrics.lastEvent} tf=${telegramMetrics.lastTimeframe||'-'} destinations=${targets.length} status=${allOk?'SENT':'PARTIAL_OR_FAILED'} apiMs=${apiMs}`);return allOk}catch(e){console.error('Telegram error:',e.message);return false}}";
if (!source.includes('TELEGRAM_GROUP_CHAT_ID')) throw new Error('Telegram group variable patch failed');
if (source.includes(oldSend)) source = source.replace(oldSend, dualSend);
else if (!source.includes('destinations=${targets.length}')) throw new Error('Telegram dual-send patch marker not found');

fs.writeFileSync(serverPath, source, 'utf8');
await import('./server.js');
