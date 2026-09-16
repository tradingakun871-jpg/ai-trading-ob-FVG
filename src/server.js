import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrategyEngine, defaultConfig } from './strategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const engine = new StrategyEngine(defaultConfig);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => res.json({ ok:true, service:'ai-trading-ob-fvg', time:new Date().toISOString() }));
app.get('/api/status', (_req, res) => res.json(engine.snapshot()));
app.get('/api/config', (_req, res) => res.json(engine.config));
app.post('/api/config', (req, res) => res.json(engine.updateConfig(req.body || {})));
app.get('/api/signals', (_req, res) => res.json({ lastSignal:engine.lastSignal, history:engine.trades.slice(-100).reverse(), stats:engine.stats() }));
app.post('/api/candle', (req, res) => {
  try { res.json(engine.ingest(req.body)); }
  catch (e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/candles', (req, res) => {
  try {
    const candles = Array.isArray(req.body) ? req.body : req.body.candles;
    if (!Array.isArray(candles)) return res.status(400).json({ error:'candles array required' });
    for (const c of candles) engine.ingest(c);
    res.json(engine.snapshot());
  } catch (e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/reset', (_req, res) => { engine.reset(); res.json({ ok:true }); });

app.post('/api/mt5/webhook', (req, res) => {
  try {
    const body = req.body || {};
    if (body.symbol) engine.updateConfig({ symbol:body.symbol, timeframe:body.timeframe || engine.config.timeframe });
    const result = engine.ingest(body.candle || body);
    res.json({ ok:true, signal:result.lastSignal, status:result });
  } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.listen(port, () => console.log(`AI Trading OB+FVG listening on :${port}`));
