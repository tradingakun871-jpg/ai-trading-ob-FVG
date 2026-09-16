const clone = (v) => JSON.parse(JSON.stringify(v));

export const defaultConfig = {
  symbol: 'XAUUSD',
  timeframe: 'M1',
  atrPeriod: 14,
  displacementAtr: 1.5,
  pivotStrength: 4,
  pipSize: 0.1,
  maxSwingSlPips: 50,
  slBufferPips: 5,
  fvgEntryMode: 'first_touch',
  rr: [1, 2, 3, 4],
  maxObFvgBars: 6,
  maxFreshAgeBars: 300,
  setupExpiryBars: 100,
};

const tr = (a, b) => Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close));
const normTime = (v) => {
  const n = Number(v ?? Date.now());
  return n < 1e12 ? n * 1000 : n;
};
const tradeOutcome = (t) => t.tpHits?.[0] ? 'WIN' : (t.status === 'closed' && t.result === 'SL' ? 'LOSS' : 'OPEN');

function atr(candles, period) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) sum += tr(candles[i], candles[i - 1]);
  return sum / period;
}

function plannedEntry(dir, top, bottom, mode) {
  if (mode === 'top') return top;
  if (mode === 'bottom') return bottom;
  if (mode === 'mid') return (top + bottom) / 2;
  return dir === 'buy' ? top : bottom;
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
    const safePatch = { ...patch };
    if (safePatch.rr && !Array.isArray(safePatch.rr)) delete safePatch.rr;
    this.config = { ...this.config, ...safePatch };
    return clone(this.config);
  }

  ingest(candle) {
    const c = {
      time: normTime(candle.time),
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
    if (bullDisp && p.close < p.open) this.obs.push({ id:`ob-${i}-b`, dir:'buy', top:p.high, bottom:p.low, sl:p.low, born:i-1, bornTime:p.time, fresh:true, paired:false });
    if (bearDisp && p.close > p.open) this.obs.push({ id:`ob-${i}-s`, dir:'sell', top:p.high, bottom:p.low, sl:p.high, born:i-1, bornTime:p.time, fresh:true, paired:false });
  }

  detectFvg(i) {
    if (i < 2) return;
    const c = this.candles[i], a = this.candles[i - 2];
    if (c.low > a.high) this.fvgs.push({ id:`fvg-${i}-b`, dir:'buy', top:c.low, bottom:a.high, born:i, bornTime:c.time, fresh:true });
    if (c.high < a.low) this.fvgs.push({ id:`fvg-${i}-s`, dir:'sell', top:a.low, bottom:c.high, born:i, bornTime:c.time, fresh:true });
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
      this.setups.push({
        id:`setup-${i}-${fvg.dir}`, dir:fvg.dir, obId:ob.id, fvgId:fvg.id,
        fvgTop:fvg.top, fvgBottom:fvg.bottom, structuralSl:ob.sl,
        plannedEntry: plannedEntry(fvg.dir, fvg.top, fvg.bottom, this.config.fvgEntryMode),
        born:i, bornTime:this.candles[i].time, status:'pending'
      });
    }
  }

  processSetups(i) {
    const c = this.candles[i];
    for (const s of this.setups) {
      if (s.status !== 'pending' || i <= s.born) continue;
      if (i - s.born > this.config.setupExpiryBars) { s.status = 'expired'; continue; }

      const entry = plannedEntry(s.dir, s.fvgTop, s.fvgBottom, this.config.fvgEntryMode);
      s.plannedEntry = entry;
      const entryTouched = c.high >= entry && c.low <= entry;

      // A setup is NOT a trade until its exact entry level has been touched.
      // Pending / expired setups never enter this.trades, history, or winrate stats.
      if (!entryTouched) continue;

      const structuralSl = s.structuralSl;
      const structuralSlPips = Math.abs(entry - structuralSl) / this.config.pipSize;

      // Keep the original Swing Max rule: first validate the raw swing distance.
      // Only after the setup passes, place the actual stop 5 pips (default)
      // beyond the swing to reduce spike/stop-hunt exposure.
      if (structuralSlPips > this.config.maxSwingSlPips) {
        s.status = 'skipped';
        s.skipReason = `Swing SL ${structuralSlPips.toFixed(1)} pips > ${this.config.maxSwingSlPips}`;
        this.skipped++;
        continue;
      }

      const bufferPips = Math.max(0, Number(this.config.slBufferPips ?? 0));
      const bufferPrice = bufferPips * this.config.pipSize;
      const sl = s.dir === 'buy' ? structuralSl - bufferPrice : structuralSl + bufferPrice;
      const slPips = Math.abs(entry - sl) / this.config.pipSize;

      const tps = targets(s.dir, entry, sl, this.config.rr);
      const trade = {
        id:`trade-${this.config.timeframe}-${i}-${s.dir}`, setupId:s.id, timeframe:this.config.timeframe,
        dir:s.dir, entry, structuralSl, structuralSlPips, slBufferPips:bufferPips, sl, slPips, tps, opened:i, openedTime:c.time,
        entryConfirmed:true,
        status:'live', tpHits:[false,false,false,false], result:null,
        armedFrom:i + 1
      };
      this.trades.push(trade);
      s.status = 'filled';
      this.lastSignal = { ...trade, symbol:this.config.symbol, timeframe:this.config.timeframe, time:c.time };
    }
  }

  processTrades(i) {
    const c = this.candles[i];
    for (const t of this.trades) {
      if (t.status !== 'live' || !t.entryConfirmed) continue;

      // TP/SL evaluation starts only on the candle AFTER entry was confirmed.
      // Therefore price reaching a TP/SL zone before entry cannot create a win/loss.
      if (i < (t.armedFrom ?? t.opened + 1)) continue;

      const slHit = t.dir === 'buy' ? c.low <= t.sl : c.high >= t.sl;
      if (slHit) {
        t.status = 'closed'; t.result = 'SL'; t.closed = i; t.closedTime = c.time;
        continue;
      }
      t.tps.forEach((tp, n) => {
        if (!t.tpHits[n] && (t.dir === 'buy' ? c.high >= tp : c.low <= tp)) t.tpHits[n] = true;
      });
      if (t.tpHits[3]) {
        t.status = 'closed'; t.result = 'TP4'; t.closed = i; t.closedTime = c.time;
      }
    }
    this.trades = this.trades.slice(-500);
  }

  stats() {
    // this.trades contains confirmed entries only.
    const all = this.trades.filter((t) => t.entryConfirmed === true);

    // Primary/overall winrate rule:
    // TP1 touched = WIN. SL before TP1 = LOSS. Live/unresolved trades are excluded.
    const primaryWins = all.filter((t) => t.tpHits[0]).length;
    const primaryLosses = all.filter((t) => !t.tpHits[0] && t.status === 'closed' && t.result === 'SL').length;
    const primaryResolved = primaryWins + primaryLosses;
    const primary = {
      wins: primaryWins,
      losses: primaryLosses,
      resolved: primaryResolved,
      winrate: primaryResolved ? +(primaryWins / primaryResolved * 100).toFixed(1) : 0
    };

    const wr = [0,1,2,3].map((n) => {
      const wins = all.filter((t) => t.tpHits[n]).length;
      const losses = all.filter((t) => !t.tpHits[n] && t.status === 'closed' && t.result === 'SL').length;
      const resolved = wins + losses;
      return { target:n+1, wins, losses, resolved, winrate:resolved ? +(wins/resolved*100).toFixed(1) : 0 };
    });
    return {
      total:all.length,
      confirmedEntries:all.length,
      live:all.filter(t => t.status === 'live').length,
      skipped:this.skipped,
      primary,
      winrates:wr
    };
  }

  snapshot() {
    return {
      config: clone(this.config),
      price: this.candles.at(-1)?.close ?? null,
      lastCandleTime: this.candles.at(-1)?.time ?? null,
      freshOB: this.obs.filter((x) => x.fresh),
      freshFVG: this.fvgs.filter((x) => x.fresh),
      pending: this.setups.filter((x) => x.status === 'pending'),
      liveTrades: this.trades.filter((x) => x.entryConfirmed === true && x.status === 'live'),
      history: this.trades.filter((x) => x.entryConfirmed === true).slice(-100).reverse().map((t) => ({ ...t, outcome:tradeOutcome(t) })),
      stats: this.stats(),
      lastSignal: this.lastSignal,
    };
  }
}
