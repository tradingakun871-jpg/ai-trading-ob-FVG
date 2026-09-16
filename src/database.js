import pg from 'pg';

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

export async function initDatabase() {
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS trading_setups (
    id TEXT PRIMARY KEY,
    timeframe TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    setup_time BIGINT,
    opened_time BIGINT,
    closed_time BIGINT,
    entry DOUBLE PRECISION,
    structural_sl DOUBLE PRECISION,
    sl DOUBLE PRECISION,
    sl_pips DOUBLE PRECISION,
    tp1 DOUBLE PRECISION,
    tp2 DOUBLE PRECISION,
    tp3 DOUBLE PRECISION,
    tp4 DOUBLE PRECISION,
    tp1_hit BOOLEAN DEFAULT FALSE,
    tp2_hit BOOLEAN DEFAULT FALSE,
    tp3_hit BOOLEAN DEFAULT FALSE,
    tp4_hit BOOLEAN DEFAULT FALSE,
    outcome TEXT,
    pnl_pips DOUBLE PRECISION,
    skip_reason TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_opened ON trading_setups(opened_time)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_tf ON trading_setups(timeframe)');
  return true;
}

const n = v => Number.isFinite(Number(v)) ? Number(v) : null;

export async function syncEngineToDatabase(tf, engine) {
  if (!pool) return;
  const symbol = engine.config.symbol;
  const rows = [
    ...engine.setups.map(s => ({ ...s, _kind:'setup' })),
    ...engine.trades.map(t => ({ ...t, _kind:'trade' }))
  ];
  for (const x of rows) {
    const entry = n(x.entry ?? x.plannedEntry);
    const sl = n(x.sl);
    const pipSize = Number(engine.config.pipSize || 0.1);
    const tpHits = Array.isArray(x.tpHits) ? x.tpHits : [false,false,false,false];
    const won = Boolean(tpHits[0]);
    const closedLoss = x.status === 'closed' && x.result === 'SL' && !won;
    let pnlPips = null;
    if (won && entry != null && Array.isArray(x.tps)) {
      let highest = 0; for (let i=0;i<tpHits.length;i++) if (tpHits[i]) highest=i+1;
      pnlPips = highest * (n(x.slPips) || (sl != null ? Math.abs(entry-sl)/pipSize : 0));
    } else if (closedLoss) pnlPips = -(n(x.slPips) || (entry != null && sl != null ? Math.abs(entry-sl)/pipSize : 0));
    const id = `${tf}:${x._kind}:${x.id}`;
    await pool.query(`INSERT INTO trading_setups
      (id,timeframe,symbol,direction,status,setup_time,opened_time,closed_time,entry,structural_sl,sl,sl_pips,tp1,tp2,tp3,tp4,tp1_hit,tp2_hit,tp3_hit,tp4_hit,outcome,pnl_pips,skip_reason,payload,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,opened_time=EXCLUDED.opened_time,closed_time=EXCLUDED.closed_time,entry=EXCLUDED.entry,structural_sl=EXCLUDED.structural_sl,sl=EXCLUDED.sl,sl_pips=EXCLUDED.sl_pips,tp1=EXCLUDED.tp1,tp2=EXCLUDED.tp2,tp3=EXCLUDED.tp3,tp4=EXCLUDED.tp4,tp1_hit=EXCLUDED.tp1_hit,tp2_hit=EXCLUDED.tp2_hit,tp3_hit=EXCLUDED.tp3_hit,tp4_hit=EXCLUDED.tp4_hit,outcome=EXCLUDED.outcome,pnl_pips=EXCLUDED.pnl_pips,skip_reason=EXCLUDED.skip_reason,payload=EXCLUDED.payload,updated_at=NOW()`,
      [id,tf,symbol,x.dir,x.status,n(x.time),n(x.openedTime),n(x.closedTime),entry,n(x.structuralSl),sl,n(x.slPips),n(x.tps?.[0]),n(x.tps?.[1]),n(x.tps?.[2]),n(x.tps?.[3]),!!tpHits[0],!!tpHits[1],!!tpHits[2],!!tpHits[3],won?'WIN':closedLoss?'LOSS':null,pnlPips,x.skipReason||null,JSON.stringify(x)]);
  }
}

function summarize(rows) {
  const resolved = rows.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const wins = resolved.filter(r=>r.outcome==='WIN').length;
  const losses = resolved.filter(r=>r.outcome==='LOSS').length;
  const grossProfit = resolved.reduce((s,r)=>s+Math.max(0,Number(r.pnl_pips)||0),0);
  const grossLoss = Math.abs(resolved.reduce((s,r)=>s+Math.min(0,Number(r.pnl_pips)||0),0));
  const netPips = grossProfit-grossLoss;
  return { signals:rows.length, resolved:resolved.length, wins, losses, winrate:resolved.length?+(wins/resolved.length*100).toFixed(1):0, grossProfitPips:+grossProfit.toFixed(1), grossLossPips:+grossLoss.toFixed(1), netPips:+netPips.toFixed(1), profitFactor:grossLoss?+(grossProfit/grossLoss).toFixed(2):(grossProfit>0?null:0) };
}

export async function getPerformance() {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM trading_setups WHERE opened_time IS NOT NULL AND id LIKE '%:trade:%' ORDER BY opened_time DESC`);
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0,0,0,0);
  const weekStart = new Date(dayStart); const dow=(weekStart.getDay()+6)%7; weekStart.setDate(weekStart.getDate()-dow);
  const monthStart = new Date(now.getFullYear(),now.getMonth(),1);
  const pick = start => rows.filter(r=>Number(r.opened_time)>=start.getTime());
  return { daily:summarize(pick(dayStart)), weekly:summarize(pick(weekStart)), monthly:summarize(pick(monthStart)), overall:summarize(rows), database:true };
}

export const databaseEnabled = () => Boolean(pool);
