import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

// Keep MT5/bridge endpoints protected, but allow the website's Telegram tests
// to send only to the private Chat ID already stored on Railway.
// No Telegram token or Chat ID is ever returned to the browser.
const marker = "app.post('/api/telegram/test',async(q,r)=>{";
const legacyMarker = "app.post('/api/telegram/test', async (req,res) => {";
const uiRoute = `app.post('/api/telegram/test-ui', async (req,res) => {
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured on server.' });
  const raw = String(req.body?.message || '✅ AI Trading OB+FVG Telegram privat test berhasil.').trim();
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
fs.writeFileSync(serverPath, source, 'utf8');

await import('./server.js');
