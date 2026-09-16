import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategyEngine, defaultConfig } from './strategy.js';
import { initDatabase, syncEngineToDatabase, getPerformance, getHistoricalEntries, databaseEnabled } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const TFS = ['M1', 'M3', 'M5'];
const TF_MIN = { M1:1, M3:3, M5:5 };
const engines = Object.fromEntries(TFS.map(tf => [tf, new StrategyEngine({ ...defaultConfig, timeframe:tf })]));
const rollups = { M3:null, M5:null };

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_NOTIFY_PENDING = String(process.env.TELEGRAM_NOTIFY_PENDING || 'false').toLowerCase() === 'true';

const mt5 = {
  lastSeen:null,
  lastCandle:null,
  lastTick:null,
  lastRealtimeTransition:null,
  symbol:'XAUUSD',
  bid:null,
  ask:null,
  serverTime:null
};

const telegramMetrics = {
  lastSentAt:null,
  lastApiMs:null,
  lastEvent:null,
  lastTimeframe:null
};

app.use(express.json({ limit:'4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

let dbReady = false;
try {
  dbReady = await initDatabase();
  if (dbReady) console.log('Trading database initialized');
  else console.warn('Trading database disabled: DATABASE_URL not configured');
} catch (e) {
  console.error('Trading database init failed:', e.message);
}

let dbSyncTimer = null;
async function syncAllToDatabase() {
  if (!dbReady || !databaseEnabled()) return false;
  await Promise.all(TFS.map(tf => syncEngineToDatabase(tf, engines[tf])));
  return true;
}
function scheduleDbSync() {
  if (!dbReady || !databaseEnabled()) return;
  if (dbSyncTimer) clearTimeout(dbSyncTimer);
  dbSyncTimer = setTimeout(() => {
    dbSyncTimer = null;
    syncAllToDatabase().catch(e => console.error('Database sync failed:', e.message));
  }, 300);
}

const normTf = (v) => {
  const s = String(v || 'M1').toUpperCase().replace('MIN','M');
  if (['1','M1'].includes(s)) return 'M1';
  if (['3','M3'].includes(s)) return 'M3';
  if (['5','M5'].includes(s)) return 'M5';
  throw new Error('timeframe must be M1, M3, or M5');
};
const normTime = (v) => { const n = Number(v ?? Date.now()); return n < 1e12 ? n * 1000 : n; };
const normCandle = (c) => ({
  time:normTime(c.time), open:Number(c.open), high:Number(c.high), low:Number(c.low), close:Number(c.close), volume:Number(c.volume ?? 0)
});
const fmt = (v) => Number(v).toFixed(3);
const telegramReady = () => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const mt5Connected = () => Boolean(mt5.lastSeen && Date.now() - mt5.lastSeen < 90_000);

function requireBridge(req, res) {
  if (!BRIDGE_TOKEN) {
    res.status(503).json({ ok:false, error:'BRIDGE_TOKEN is not configured on server' });
    return false;
  }
  const token = req.get('x-bridge-token') || req.query.token || '';
  if (token !== BRIDGE_TOKEN) {
    res.status(401).json({ ok:false, error:'invalid bridge token' });
    return false;
  }
  return true;
}

async function sendTelegram(text, meta = {}) {
  if (!telegramReady()) return false;
  const started = Date.now();
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        chat_id:TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview:true
      })
    });
    const apiMs = Date.now() - started;
    if (!r.ok) {
      const body = await r.text();
      console.error('Telegram send failed:', r.status, body);
      return false;
    }
    telegramMetrics.lastSentAt = Date.now();
    telegramMetrics.lastApiMs = apiMs;
    telegramMetrics.lastEvent = meta.event || 'MESSAGE';
    telegramMetrics.lastTimeframe = meta.tf || null;
    console.log(`Telegram sent event=${telegramMetrics.lastEvent} tf=${telegramMetrics.lastTimeframe || '-'} apiMs=${apiMs}`);
    return true;
  } catch (e) {
    console.error('Telegram error:', e.message);
    return false;
  }
}

function tradeMap(engine) {
  return new Map(engine.trades.map(t => [t.id, {
    status:t.status,
    result:t.result,
    tpHits:[...t.tpHits]
  }]));
}

function pendingSet(engine) {
  return new Set(engine.setups.filter(s => s.status === 'pending').map(s => s.id));
}

function entryMessage(tf, t) {
  const side = t.dir.toUpperCase();
  const icon = t.dir === 'buy' ? '🟢' : '🔴';
  return [
    `${icon} ENTRY ${side} ${engines[tf].config.symbol} ${tf}`,
    `Entry: ${fmt(t.entry)}`,
    `SL: ${fmt(t.sl)} (${Number(t.slPips).toFixed(1)} pips)`,
    `TP1: ${fmt(t.tps[0])}`,
    `TP2: ${fmt(t.tps[1])}`,
    `TP3: ${fmt(t.tps[2])}`,
    `TP4: ${fmt(t.tps[3])}`,
    `Method: Fresh OB + FVG`,
    `Rule: Swing SL max ${engines[tf].config.maxSwingSlPips} pips`
  ].join('\n');
}

function tpMessage(tf, t, highestIndex) {
  const reached = highestIndex + 1;
  return [
    `✅ ${engines[tf].config.symbol} ${tf} ${t.dir.toUpperCase()} — TP${reached} HIT`,
    `Entry: ${fmt(t.entry)}`,
    `TP${reached}: ${fmt(t.tps[highestIndex])}`,
    reached >= 1 ? `Status winrate utama: WIN` : ''
  ].filter(Boolean).join('\n');
}

function slMessage(tf, t) {
  const primaryAlreadyWon = Boolean(t.tpHits?.[0]);
  return [
    `⛔ ${engines[tf].config.symbol} ${tf} ${t.dir.toUpperCase()} — SL HIT`,
    `Entry: ${fmt(t.entry)}`,
    `SL: ${fmt(t.sl)}`,
    primaryAlreadyWon ? `TP1 sudah tercapai sebelumnya — winrate utama tetap WIN` : `TP1 belum tercapai — hasil utama LOSS`
  ].join('\n');
}

function pendingMessage(tf, s) {
  return [
    `⏳ SETUP ${s.dir.toUpperCase()} ${engines[tf].config.symbol} ${tf}`,
    `Entry rencana: ${fmt(s.plannedEntry)}`,
    `FVG: ${fmt(s.fvgBottom)} - ${fmt(s.fvgTop)}`,
    `Status: PENDING — belum dihitung sampai Entry tersentuh`
  ].join('\n');
}

function dispatchTransitions(tf, beforeTrades, beforePending) {
  const engine = engines[tf];
  let transitions = 0;

  for (const t of engine.trades) {
    const prev = beforeTrades.get(t.id);
    if (!prev) {
      transitions++;
      void sendTelegram(entryMessage(tf, t), { event:'ENTRY', tf });
      continue;
    }

    let highestNewTp = -1;
    for (let i = 0; i < t.tpHits.length; i++) {
      if (!prev.tpHits[i] && t.tpHits[i]) highestNewTp = i;
    }
    if (highestNewTp >= 0) {
      transitions++;
      void sendTelegram(tpMessage(tf, t, highestNewTp), { event:`TP${highestNewTp + 1}`, tf });
    }

    if (prev.status === 'live' && t.status === 'closed' && t.result === 'SL') {
      transitions++;
      void sendTelegram(slMessage(tf, t), { event:'SL', tf });
    }
  }

  if (TELEGRAM_NOTIFY_PENDING) {
    for (const s of engine.setups) {
      if (s.status === 'pending' && !beforePending.has(s.id)) {
        transitions++;
        void sendTelegram(pendingMessage(tf, s), { event:'PENDING', tf });
      }
    }
  }
  return transitions;
}

function ingestEngine(tf, candle, notify = true) {
  const engine = engines[tf];
  const beforeTrades = notify ? tradeMap(engine) : null;
  const beforePending = notify ? pendingSet(engine) : null;
  const result = engine.ingest(candle);
  if (notify) dispatchTransitions(tf, beforeTrades, beforePending);
  return result;
}

function processRealtimeTick(price, time) {
  let changed = false;
  let transitions = 0;
  for (const tf of TFS) {
    const engine = engines[tf];
    const beforeTrades = tradeMap(engine);
    const beforePending = pendingSet(engine);
    const result = engine.processTick({ price, time });
    if (!result.changed) continue;
    changed = true;
    transitions += dispatchTransitions(tf, beforeTrades, beforePending);
  }
  if (changed) {
    mt5.lastRealtimeTransition = Date.now();
    scheduleDbSync();
  }
  return { changed, transitions };
}

function rollupM1(candle, tf) {
  const mins = TF_MIN[tf];
  const bucketMs = mins * 60_000;
  const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
  const cur = rollups[tf];
  if (!cur || cur.time !== bucket) {
    const completed = cur ? { ...cur } : null;
    rollups[tf] = { time:bucket, open:candle.open, high:candle.high, low:candle.low, close:candle.close, volume:candle.volume || 0 };
    return completed;
  }
  cur.high = Math.max(cur.high, candle.high);
  cur.low = Math.min(cur.low, candle.low);
  cur.close = candle.close;
  cur.volume += candle.volume || 0;
  return null;
}

function ingestOne(tfRaw, candleRaw, autoAggregate = true, notify = true) {
  const tf = normTf(tfRaw);
  const candle = normCandle(candleRaw);
  const result = ingestEngine(tf, candle, notify);
  if (tf === 'M1' && autoAggregate) {
    for (const higher of ['M3','M5']) {
      const completed = rollupM1(candle, higher);
      if (completed) ingestEngine(higher, completed, notify);
    }
  }
  return result;
}

function combinedSnapshot() {
  const timeframes = Object.fromEntries(TFS.map(tf => [tf, engines[tf].snapshot()]));
  const histories = TFS.flatMap(tf => timeframes[tf].history.map(x => ({ ...x, timeframe:tf })))
    .sort((a,b) => (b.openedTime || 0) - (a.openedTime || 0)).slice(0, 300);
  const signals = TFS.map(tf => timeframes[tf].lastSignal).filter(Boolean).sort((a,b) => (b.time||0)-(a.time||0));

  const overallWins = TFS.reduce((n,tf)=>n + timeframes[tf].stats.primary.wins, 0);
  const overallLosses = TFS.reduce((n,tf)=>n + timeframes[tf].stats.primary.losses, 0);
  const overallResolved = overallWins + overallLosses;
  const overallWinrate = overallResolved ? +(overallWins / overallResolved * 100).toFixed(1) : 0;
  const confirmedEntries = TFS.reduce((n,tf)=>n + timeframes[tf].stats.confirmedEntries, 0);

  return {
    symbol: engines.M1.config.symbol,
    livePrice: mt5.bid ?? timeframes.M1.price,
    strategy: 'Fresh OB + FVG | Hybrid Realtime Tick | Swing SL Max 50 pips | TP 1R-4R',
    hybridRealtime:true,
    timeframes,
    lastSignal: signals[0] || null,
    history: histories,
    database: { configured:databaseEnabled(), ready:dbReady },
    integrations: {
      mt5: {
        connected:mt5Connected(),
        hybridRealtime:true,
        lastSeen:mt5.lastSeen,
        lastCandle:mt5.lastCandle,
        lastTick:mt5.lastTick,
        lastRealtimeTransition:mt5.lastRealtimeTransition,
        symbol:mt5.symbol,
        bid:mt5.bid,
        ask:mt5.ask,
        serverTime:mt5.serverTime
      },
      telegram: {
        configured:telegramReady(),
        notifyPending:TELEGRAM_NOTIFY_PENDING,
        lastSentAt:telegramMetrics.lastSentAt,
        lastApiMs:telegramMetrics.lastApiMs,
        lastEvent:telegramMetrics.lastEvent,
        lastTimeframe:telegramMetrics.lastTimeframe
      }
    },
    combined: {
      confirmedEntries,
      totalTrades: confirmedEntries,
      liveTrades: TFS.reduce((n,tf)=>n+timeframes[tf].stats.live,0),
      pending: TFS.reduce((n,tf)=>n+timeframes[tf].pending.length,0),
      skipped: TFS.reduce((n,tf)=>n+timeframes[tf].stats.skipped,0),
      overall: {
        wins: overallWins,
        losses: overallLosses,
        resolved: overallResolved,
        winrate:overallWinrate,
        rule:'Hanya entry yang sudah tersentuh yang dihitung. TP1 = WIN; SL sebelum TP1 = LOSS; pending/belum entry tidak dihitung.'
      }
    }
  };
}

app.get('/api/health', (_req,res) => res.json({
  ok:true,
  service:'ai-trading-ob-fvg-mtf',
  timeframes:TFS,
  hybridRealtime:true,
  mt5Connected:mt5Connected(),
  telegramConfigured:telegramReady(),
  databaseConfigured:databaseEnabled(),
  databaseReady:dbReady,
  time:new Date().toISOString()
}));
app.get('/api/status', (_req,res) => res.json(combinedSnapshot()));
app.get('/api/integrations', (_req,res) => res.json(combinedSnapshot().integrations));
app.get('/api/performance', async (_req,res) => {
  try {
    if (!dbReady) return res.status(503).json({ error:'database not ready' });
    res.json(await getPerformance());
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.get('/api/history', async (req,res) => {
  try {
    if (!dbReady) return res.status(503).json({ error:'database not ready' });
    const timeframe = req.query.timeframe ? normTf(req.query.timeframe) : null;
    const history = await getHistoricalEntries({ timeframe, limit:req.query.limit || 500 });
    res.json({ history, database:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/status/:tf', (req,res) => {
  try { res.json(engines[normTf(req.params.tf)].snapshot()); }
  catch(e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/config', (_req,res) => res.json({
  shared: { ...engines.M1.config, timeframe:undefined },
  timeframes:Object.fromEntries(TFS.map(tf => [tf, engines[tf].config]))
}));
app.post('/api/config', (req,res) => {
  try {
    const patch = { ...(req.body || {}) };
    const onlyTf = patch.timeframe ? normTf(patch.timeframe) : null;
    delete patch.timeframe;
    const target = onlyTf ? [onlyTf] : TFS;
    target.forEach(tf => engines[tf].updateConfig({ ...patch, timeframe:tf }));
    res.json({ ok:true, config:Object.fromEntries(TFS.map(tf => [tf, engines[tf].config])) });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/signals', (req,res) => {
  try {
    const tf = req.query.timeframe ? normTf(req.query.timeframe) : null;
    if (tf) return res.json({ timeframe:tf, lastSignal:engines[tf].lastSignal, history:engines[tf].snapshot().history, stats:engines[tf].stats() });
    const snap = combinedSnapshot();
    res.json({ lastSignal:snap.lastSignal, history:snap.history, overall:snap.combined.overall, stats:Object.fromEntries(TFS.map(x=>[x,engines[x].stats()])) });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/candle', (req,res) => {
  try {
    const body = req.body || {};
    const candle = body.candle || body;
    const tf = body.timeframe || candle.timeframe || 'M1';
    ingestOne(tf, candle, body.autoAggregate !== false, body.notify === true);
    scheduleDbSync();
    res.json(combinedSnapshot());
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/candles', (req,res) => {
  try {
    const body = req.body || {};
    const candles = Array.isArray(body) ? body : body.candles;
    if (!Array.isArray(candles)) return res.status(400).json({ error:'candles array required' });
    const defaultTf = body.timeframe || 'M1';
    for (const c of candles) ingestOne(c.timeframe || defaultTf, c.candle || c, body.autoAggregate !== false, body.notify === true);
    scheduleDbSync();
    res.json(combinedSnapshot());
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/reset', (req,res) => {
  try {
    if (req.body?.timeframe) engines[normTf(req.body.timeframe)].reset();
    else { TFS.forEach(tf => engines[tf].reset()); rollups.M3 = null; rollups.M5 = null; }
    res.json({ ok:true, status:combinedSnapshot(), databasePreserved:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post('/api/mt5/backfill', async (req,res) => {
  if (!requireBridge(req,res)) return;
  try {
    const body = req.body || {};
    const candles = body.candles;
    if (!Array.isArray(candles)) return res.status(400).json({ ok:false, error:'candles array required' });
    const tf = body.timeframe || 'M1';
    if (normTf(tf) !== 'M1' && body.autoAggregate !== false) return res.status(400).json({ ok:false, error:'autoAggregate backfill must use M1 source only' });
    if (body.symbol) {
      mt5.symbol = body.symbol;
      TFS.forEach(x => engines[x].updateConfig({ symbol:body.symbol, timeframe:x }));
    }
    for (const c of candles) ingestOne(c.timeframe || tf, c, body.autoAggregate !== false, false);
    mt5.lastSeen = Date.now();
    await syncAllToDatabase();
    res.json({ ok:true, imported:candles.length, databaseSynced:dbReady, status:combinedSnapshot() });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/api/mt5/tick', (req,res) => {
  if (!requireBridge(req,res)) return;
  try {
    const body = req.body || {};
    mt5.lastSeen = Date.now();
    mt5.lastTick = normTime(body.time ?? Date.now());
    mt5.serverTime = body.serverTime ? normTime(body.serverTime) : mt5.lastTick;
    mt5.symbol = body.symbol || mt5.symbol;
    mt5.bid = Number.isFinite(Number(body.bid)) ? Number(body.bid) : mt5.bid;
    mt5.ask = Number.isFinite(Number(body.ask)) ? Number(body.ask) : mt5.ask;

    // Hybrid realtime execution uses the same BID stream as the MT5 candle
    // strategy reference. OB/FVG discovery remains candle-close only.
    const realtimePrice = Number.isFinite(Number(mt5.bid)) ? Number(mt5.bid) : Number(mt5.ask);
    const realtime = Number.isFinite(realtimePrice)
      ? processRealtimeTick(realtimePrice, mt5.lastTick)
      : { changed:false, transitions:0 };

    res.json({
      ok:true,
      mt5Connected:true,
      hybridRealtime:true,
      realtimeChanged:realtime.changed,
      transitions:realtime.transitions
    });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/api/mt5/webhook', (req,res) => {
  if (!requireBridge(req,res)) return;
  try {
    const body = req.body || {};
    const tf = body.timeframe || body.candle?.timeframe || 'M1';
    if (body.symbol) {
      mt5.symbol = body.symbol;
      TFS.forEach(x => engines[x].updateConfig({ symbol:body.symbol, timeframe:x }));
    }
    mt5.lastSeen = Date.now();
    const candle = body.candle || body;
    mt5.lastCandle = normTime(candle.time ?? Date.now());
    ingestOne(tf, candle, body.autoAggregate !== false, true);
    scheduleDbSync();
    const snap = combinedSnapshot();
    res.json({ ok:true, signal:snap.lastSignal, integrations:snap.integrations, status:snap });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.post('/api/telegram/test-ui', async (req,res) => {
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured on server.' });
  const raw = String(req.body?.message || '✅ AI Trading OB+FVG Telegram privat test berhasil.').trim();
  const message = raw.slice(0, 500);
  const ok = await sendTelegram(message, { event:'TEST' });
  res.status(ok ? 200 : 502).json({ ok, apiMs:telegramMetrics.lastApiMs });
});

app.post('/api/telegram/test', async (req,res) => {
  if (!requireBridge(req,res)) return;
  if (!telegramReady()) return res.status(409).json({ ok:false, error:'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.' });
  const ok = await sendTelegram(req.body?.message || '✅ AI Trading OB+FVG Telegram connected. M1 / M3 / M5 notifications are active.', { event:'TEST' });
  res.status(ok ? 200 : 502).json({ ok, apiMs:telegramMetrics.lastApiMs });
});

app.use((_req,res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.listen(port, () => console.log(`AI Trading OB+FVG MTF listening on :${port}`));