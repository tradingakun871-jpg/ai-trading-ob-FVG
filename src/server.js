import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategyEngine, defaultConfig } from './strategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const TFS = ['M1', 'M3', 'M5'];
const TF_MIN = { M1:1, M3:3, M5:5 };
const engines = Object.fromEntries(TFS.map(tf => [tf, new StrategyEngine({ ...defaultConfig, timeframe:tf })]));
const rollups = { M3:null, M5:null };

app.use(express.json({ limit:'4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

function ingestOne(tfRaw, candleRaw, autoAggregate = true) {
  const tf = normTf(tfRaw);
  const candle = normCandle(candleRaw);
  const result = engines[tf].ingest(candle);
  if (tf === 'M1' && autoAggregate) {
    for (const higher of ['M3','M5']) {
      const completed = rollupM1(candle, higher);
      if (completed) engines[higher].ingest(completed);
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
    strategy: 'Fresh OB + FVG | Swing SL Max 50 pips | TP 1R-4R',
    timeframes,
    lastSignal: signals[0] || null,
    history: histories,
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
        winrate: overallWinrate,
        rule: 'Hanya entry yang sudah tersentuh yang dihitung. TP1 = WIN; SL sebelum TP1 = LOSS; pending/belum entry tidak dihitung.'
      }
    }
  };
}

app.get('/api/health', (_req,res) => res.json({ ok:true, service:'ai-trading-ob-fvg-mtf', timeframes:TFS, time:new Date().toISOString() }));
app.get('/api/status', (_req,res) => res.json(combinedSnapshot()));
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
    ingestOne(tf, candle, body.autoAggregate !== false);
    res.json(combinedSnapshot());
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/candles', (req,res) => {
  try {
    const body = req.body || {};
    const candles = Array.isArray(body) ? body : body.candles;
    if (!Array.isArray(candles)) return res.status(400).json({ error:'candles array required' });
    const defaultTf = body.timeframe || 'M1';
    for (const c of candles) ingestOne(c.timeframe || defaultTf, c.candle || c, body.autoAggregate !== false);
    res.json(combinedSnapshot());
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/reset', (req,res) => {
  try {
    if (req.body?.timeframe) engines[normTf(req.body.timeframe)].reset();
    else { TFS.forEach(tf => engines[tf].reset()); rollups.M3 = null; rollups.M5 = null; }
    res.json({ ok:true, status:combinedSnapshot() });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/mt5/webhook', (req,res) => {
  try {
    const body = req.body || {};
    const tf = body.timeframe || body.candle?.timeframe || 'M1';
    if (body.symbol) TFS.forEach(x => engines[x].updateConfig({ symbol:body.symbol, timeframe:x }));
    ingestOne(tf, body.candle || body, body.autoAggregate !== false);
    const snap = combinedSnapshot();
    res.json({ ok:true, signal:snap.lastSignal, status:snap });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.use((_req,res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.listen(port, () => console.log(`AI Trading OB+FVG MTF listening on :${port}`));
