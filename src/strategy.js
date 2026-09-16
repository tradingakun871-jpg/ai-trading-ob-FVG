const clone = (v) => JSON.parse(JSON.stringify(v));

export const defaultConfig = {
  symbol: 'XAUUSD',
  timeframe: 'M3',
  atrPeriod: 14,
  displacementAtr: 1.5,
  pivotStrength: 4,
  pipSize: 0.1,
  maxSwingSlPips: 50,
  fvgEntryMode: 'first_touch',
  rr: [1, 2, 3, 4],
  maxObFvgBars: 6,
  maxFreshAgeBars: 300,
  setupExpiryBars: 100,
};

const tr = (a, b) => Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close));

function atr(candles, period) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) sum += tr(candles[i], candles[i - 1]);
  return sum / period;
}

function entryFromFvg(dir, top, bottom, mode, touchPrice) {
  if (mode === 'top') return top;
  if (mode === 'bottom') return bottom;
  if (mode === 'mid') return (top + bottom) / 2;
  return touchPrice ?? (dir === 'buy' ? top : bottom);
}

function targets(dir, entry, sl, rr) {
  const risk = Math.abs(entry - sl);
  return rr.map((r) => dir === 'buy' ? entry + risk * r : entry - risk * r);
}

export class StrategyEngine {
  constructor(config = {}) {
    this.config = { ...defaultConfig, ...config };
    this.reset();
  }

  reset() {
    this.candles = [];
    this.obs = [];
    this.fvgs = [];
    this.setups = [];
    this.trades = [];
    this.skipped = 0;
    this.lastSignal = null;
  }

  updateConfig(patch = {}) {
    this.config = { ...this.config, ...patch };
    return clone(this.config);
  }

  ingest(candle) {
    const c = {
      time: Number(candle.time ?? Date.now()),
      open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close),
      volume: Number(candle.volume ?? 0),
    };
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) throw new Error('Invalid OHLC candle');
    this.candles.push(c);
    if (this.candles.length > 5000) this.candles.shift();
    const i = this.candles.length - 1;
    this.detectOb(i);
    this.detectFvg(i);
    this.refreshFreshness(i);
    this.matchSetups(i);
    this.processSetups(i);
    this.processTrades(i);
    return this.snapshot();
  }

  detectOb(i) {
    if (i < 2) return;
    const a = atr(this.candles.slice(0, i + 1), this.config.atrPeriod);
    if (!a) return;
    const c = this.candles[i], p = this.candles[i - 1];
    const bullDisp = c.close > c.open && c.close - c.open >= a * this.config.displacementAtr;
    const bearDisp = c.close < c.open && c.open - c.close >= a * this.config.displacementAtr;
    if (bullDisp && p.close < p.open) this.obs.push({ id:`ob-${i}-b`, dir:'buy', top:p.high, bottom:p.low, sl:p.low, born:i-1, fresh:true, paired:false });
    if (bearDisp && p.close > p.open) this.obs.push({ id:`ob-${i}-s`, dir:'sell', top:p.high, bottom:p.low, sl:p.high, born:i-1, fresh:true, paired:false });
  }

  detectFvg(i) {
    if (i < 2) return;
    const c = this.candles[i], a = this.candles[i - 2];
    if (c.low > a.high) this.fvgs.push({ id:`fvg-${i}-b`, dir:'buy', top:c.low, bottom:a.high, born:i, fresh:true });
    if (c.high < a.low) this.fvgs.push({ id:`fvg-${i}-s`, dir:'sell', top:a.low, bottom:c.high, born:i, fresh:true });
  }

  refreshFreshness(i) {
    const c = this.candles[i];
    for (const ob of this.obs) {
      if (!ob.fresh || i <= ob.born + 1) continue;
      if (i - ob.born > this.config.maxFreshAgeBars || (c.high >= ob.bottom && c.low <= ob.top)) ob.fresh = false;
    }
    for (const f of this.fvgs) {
      if (!f.fresh || i <= f.born) continue;
      if (i - f.born > this.config.maxFreshAgeBars || (c.high >= f.bottom && c.low <= f.top)) f.fresh = false;
    }
    this.obs = this.obs.slice(-100);
    this.fvgs = this.fvgs.slice(-150);
  }

  matchSetups(i) {
    const freshNewFvgs = this.fvgs.filter((f) => f.born === i);
    for (const fvg of freshNewFvgs) {
      const ob = [...this.obs].reverse().find((o) => o.dir === fvg.dir && o.fresh && !o.paired && i - o.born >= 1 && i - o.born <= this.config.maxObFvgBars + 1);
      if (!ob) continue;
      ob.paired = true;
      this.setups = this.setups.filter((s) => s.dir !== fvg.dir || s.status !== 'pending');
      this.setups.push({ id:`setup-${i}-${fvg.dir}`, dir:fvg.dir, obId:ob.id, fvgId:fvg.id, fvgTop:fvg.top, fvgBottom:fvg.bottom, structuralSl:ob.sl, born:i, status:'pending' });
    }
  }

  processSetups(i) {
    const c = this.candles[i];
    for (const s of this.setups) {
      if (s.status !== 'pending' || i <= s.born) continue;
      if (i - s.born > this.config.setupExpiryBars) { s.status = 'expired'; continue; }
      const touched = c.high >= s.fvgBottom && c.low <= s.fvgTop;
      if (!touched) continue;
      const touch = s.dir === 'buy' ? s.fvgTop : s.fvgBottom;
      const entry = entryFromFvg(s.dir, s.fvgTop, s.fvgBottom, this.config.fvgEntryMode, touch);
      const sl = s.structuralSl;
      const slPips = Math.abs(entry - sl) / this.config.pipSize;
      if (slPips > this.config.maxSwingSlPips) { s.status = 'skipped'; this.skipped++; continue; }
      const tps = targets(s.dir, entry, sl, this.config.rr);
      const trade = { id:`trade-${i}-${s.dir}`, setupId:s.id, dir:s.dir, entry, sl, slPips, tps, opened:i, status:'live', tpHits:[false,false,false,false], result:null };
      this.trades.push(trade);
      s.status = 'filled';
      this.lastSignal = { ...trade, symbol:this.config.symbol, timeframe:this.config.timeframe, time:c.time };
    }
  }

  processTrades(i) {
    const c = this.candles[i];
    for (const t of this.trades) {
      if (t.status !== 'live') continue;
      const slHit = t.dir === 'buy' ? c.low <= t.sl : c.high >= t.sl;
      if (slHit) { t.status = 'closed'; t.result = 'SL'; t.closed = i; continue; }
      t.tps.forEach((tp, n) => { if (!t.tpHits[n] && (t.dir === 'buy' ? c.high >= tp : c.low <= tp)) t.tpHits[n] = true; });
      if (t.tpHits[3]) { t.status = 'closed'; t.result = 'TP4'; t.closed = i; }
    }
    this.trades = this.trades.slice(-500);
  }

  stats() {
    const closedOrLive = this.trades;
    const total = closedOrLive.length;
    const wr = [0,1,2,3].map((n) => {
      const resolved = closedOrLive.filter((t) => t.status === 'closed' || t.tpHits[n]);
      const wins = resolved.filter((t) => t.tpHits[n]).length;
      return { target:n+1, wins, resolved:resolved.length, winrate:resolved.length ? +(wins/resolved.length*100).toFixed(1) : 0 };
    });
    return { total, skipped:this.skipped, winrates:wr };
  }

  snapshot() {
    return {
      config: clone(this.config),
      price: this.candles.at(-1)?.close ?? null,
      freshOB: this.obs.filter((x) => x.fresh),
      freshFVG: this.fvgs.filter((x) => x.fresh),
      pending: this.setups.filter((x) => x.status === 'pending'),
      liveTrades: this.trades.filter((x) => x.status === 'live'),
      history: this.trades.slice(-100).reverse(),
      stats: this.stats(),
      lastSignal: this.lastSignal,
    };
  }
}
