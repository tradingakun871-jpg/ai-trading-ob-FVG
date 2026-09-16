import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

// Keep MT5/bridge endpoints protected, but allow the website's Telegram test
// button to send only to the private Chat ID already stored on Railway.
// No Telegram token or Chat ID is ever returned to the browser.
const marker = "app.post('/api/telegram/test', async (req,res) => {";
const uiRoute = `app.post('/api/telegram/test-ui', async (req,res) => {
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured on server.' });
  const raw = String(req.body?.message || '✅ AI Trading OB+FVG Telegram privat test berhasil.').trim();
  const message = raw.slice(0, 500);
  const ok = await sendTelegram(message);
  res.status(ok ? 200 : 502).json({ ok });
});

`;

let source = fs.readFileSync(serverPath, 'utf8');
if (!source.includes("app.post('/api/telegram/test-ui'")) {
  if (!source.includes(marker)) throw new Error('Telegram route marker not found');
  source = source.replace(marker, uiRoute + marker);
  fs.writeFileSync(serverPath, source, 'utf8');
}

await import('./server.js');
