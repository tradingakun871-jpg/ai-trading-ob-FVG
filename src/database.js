import pg from 'pg';

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const ACTIVE_TFS = ['M1','M3'];

export async function initDatabase() {
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS trading_setups (
    id TEXT PRIMARY KEY, timeframe TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
    setup_time BIGINT, opened_time BIGINT, closed_time BIGINT, entry DOUBLE PRECISION, structural_sl DOUBLE PRECISION,
    sl DOUBLE PRECISION, sl_pips DOUBLE PRECISION, tp1 DOUBLE PRECISION, tp2 DOUBLE PRECISION, tp3 DOUBLE PRECISION,
    tp4 DOUBLE PRECISION, tp1_hit BOOLEAN DEFAULT FALSE, tp2_hit BOOLEAN DEFAULT FALSE, tp3_hit BOOLEAN DEFAULT FALSE,
    tp4_hit BOOLEAN DEFAULT FALSE, outcome TEXT, pnl_pips DOUBLE PRECISION, skip_reason TEXT, payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_opened ON trading_setups(opened_time)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_tf ON trading_setups(timeframe)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_outcome ON trading_setups(outcome)');
  const deleted = await pool.query("DELETE FROM trading_setups WHERE timeframe = 'M5'");
  console.log(`M5 historical cleanup: deleted ${deleted.rowCount} rows`);
  return true;
}

const n = v => Number.isFinite(Number(v)) ? Number(v) : null;
const round1 = v => +Number(v || 0).toFixed(1);
const TF_MS = { M1:60_000, M3:180_000 };

function executionBucket(tf, openedTime) {
  const ms = n(openedTime); const size = TF_MS[tf] || 60_000;
  return ms == null ? 'na' : Math.floor(ms / size) * size;
}
function stableRowId(tf, x) {
  if (x._kind === 'trade') return `${tf}:trade:${executionBucket(tf,x.openedTime)}:${x.dir}:${n(x.entry) ?? 'na'}`;
  return `${tf}:setup:${n(x.bornTime ?? x.time) ?? 'na'}:${x.dir}:${n(x.plannedEntry) ?? 'na'}`;
}
function pnlFromHits(tpHits, riskPips, closedLoss) {
  if (riskPips == null) return null;
  let highest = 0;
  for (let i=0;i<4;i++) if (tpHits[i]) highest = i+1;
  if (highest) return riskPips * highest;
  if (closedLoss) return -riskPips;
  return null;
}

export async function syncEngineToDatabase(tf, engine) {
  if (!pool || !ACTIVE_TFS.includes(tf)) return false;
  const symbol = engine.config.symbol;
  const rows = [...engine.setups.map(s=>({...s,_kind:'setup'})), ...engine.trades.map(t=>({...t,_kind:'trade'}))];
  for (const x of rows) {
    const entry=n(x.entry ?? x.plannedEntry), sl=n(x.sl), pipSize=Number(engine.config.pipSize||0.1);
    const tpHits=Array.isArray(x.tpHits)?x.tpHits:[false,false,false,false];
    const won=Boolean(tpHits[0]);
    const closedLoss=x.status==='closed' && x.result==='SL' && !won;
    const riskPips=n(x.slPips) ?? (entry!=null&&sl!=null?Math.abs(entry-sl)/pipSize:null);
    const pnlPips=pnlFromHits(tpHits,riskPips,closedLoss);
    const id=stableRowId(tf,x);
    await pool.query(`INSERT INTO trading_setups
      (id,timeframe,symbol,direction,status,setup_time,opened_time,closed_time,entry,structural_sl,sl,sl_pips,tp1,tp2,tp3,tp4,tp1_hit,tp2_hit,tp3_hit,tp4_hit,outcome,pnl_pips,skip_reason,payload,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
      ON CONFLICT(id) DO UPDATE SET
      symbol=EXCLUDED.symbol,direction=EXCLUDED.direction,status=EXCLUDED.status,setup_time=EXCLUDED.setup_time,
      opened_time=LEAST(trading_setups.opened_time,EXCLUDED.opened_time),closed_time=EXCLUDED.closed_time,entry=EXCLUDED.entry,
      structural_sl=EXCLUDED.structural_sl,sl=EXCLUDED.sl,sl_pips=EXCLUDED.sl_pips,tp1=EXCLUDED.tp1,tp2=EXCLUDED.tp2,tp3=EXCLUDED.tp3,tp4=EXCLUDED.tp4,
      tp1_hit=(trading_setups.tp1_hit OR EXCLUDED.tp1_hit),tp2_hit=(trading_setups.tp2_hit OR EXCLUDED.tp2_hit),
      tp3_hit=(trading_setups.tp3_hit OR EXCLUDED.tp3_hit),tp4_hit=(trading_setups.tp4_hit OR EXCLUDED.tp4_hit),
      outcome=CASE WHEN trading_setups.outcome='WIN' OR EXCLUDED.outcome='WIN' THEN 'WIN' ELSE COALESCE(EXCLUDED.outcome,trading_setups.outcome) END,
      pnl_pips=CASE
        WHEN (trading_setups.tp4_hit OR EXCLUDED.tp4_hit) THEN 4*ABS(COALESCE(EXCLUDED.sl_pips,trading_setups.sl_pips,0))
        WHEN (trading_setups.tp3_hit OR EXCLUDED.tp3_hit) THEN 3*ABS(COALESCE(EXCLUDED.sl_pips,trading_setups.sl_pips,0))
        WHEN (trading_setups.tp2_hit OR EXCLUDED.tp2_hit) THEN 2*ABS(COALESCE(EXCLUDED.sl_pips,trading_setups.sl_pips,0))
        WHEN (trading_setups.tp1_hit OR EXCLUDED.tp1_hit) THEN ABS(COALESCE(EXCLUDED.sl_pips,trading_setups.sl_pips,0))
        ELSE COALESCE(EXCLUDED.pnl_pips,trading_setups.pnl_pips) END,
      skip_reason=EXCLUDED.skip_reason,payload=EXCLUDED.payload,updated_at=NOW()`,
      [id,tf,symbol,x.dir,x.status,n(x.bornTime??x.time),n(x.openedTime),n(x.closedTime),entry,n(x.structuralSl),sl,riskPips,n(x.tps?.[0]),n(x.tps?.[1]),n(x.tps?.[2]),n(x.tps?.[3]),!!tpHits[0],!!tpHits[1],!!tpHits[2],!!tpHits[3],won?'WIN':closedLoss?'LOSS':null,pnlPips,x.skipReason||null,JSON.stringify(x)]);
  }
  return true;
}

function summarize(rows) {
  const resolved=rows.filter(r=>r.outcome==='WIN'||r.outcome==='LOSS');
  const wins=resolved.filter(r=>r.outcome==='WIN').length, losses=resolved.filter(r=>r.outcome==='LOSS').length;
  const grossProfit=resolved.reduce((s,r)=>s+Math.max(0,Number(r.pnl_pips)||0),0);
  const grossLoss=Math.abs(resolved.reduce((s,r)=>s+Math.min(0,Number(r.pnl_pips)||0),0));
  return { signals:rows.length,resolved:resolved.length,wins,losses,winrate:resolved.length?+(wins/resolved.length*100).toFixed(1):0,
    grossProfitPips:round1(grossProfit),grossLossPips:round1(grossLoss),netPips:round1(grossProfit-grossLoss),
    profitFactor:grossLoss?+(grossProfit/grossLoss).toFixed(2):(grossProfit>0?null:0) };
}
function jakartaPeriodStarts(nowMs=Date.now()) {
  const shifted=new Date(nowMs+JAKARTA_OFFSET_MS), y=shifted.getUTCFullYear(),m=shifted.getUTCMonth(),d=shifted.getUTCDate();
  const dayStart=Date.UTC(y,m,d)-JAKARTA_OFFSET_MS, dow=(shifted.getUTCDay()+6)%7;
  return {dayStart,weekStart:Date.UTC(y,m,d-dow)-JAKARTA_OFFSET_MS,monthStart:Date.UTC(y,m,1)-JAKARTA_OFFSET_MS};
}
const DEDUPED_TRADES_SQL=`SELECT DISTINCT ON (timeframe,direction,entry,sl,FLOOR(opened_time::numeric / CASE timeframe WHEN 'M3' THEN 180000 ELSE 60000 END)) *
FROM trading_setups WHERE opened_time IS NOT NULL AND id LIKE '%:trade:%' AND timeframe IN ('M1','M3')
ORDER BY timeframe,direction,entry,sl,FLOOR(opened_time::numeric / CASE timeframe WHEN 'M3' THEN 180000 ELSE 60000 END),
((tp1_hit::int)+(tp2_hit::int)+(tp3_hit::int)+(tp4_hit::int)) DESC,(outcome IS NOT NULL) DESC,updated_at DESC`;

export async function getPerformance() {
  if (!pool) return null;
  const {rows}=await pool.query(`SELECT timeframe,opened_time,outcome,pnl_pips FROM (${DEDUPED_TRADES_SQL}) d ORDER BY opened_time DESC`);
  const {dayStart,weekStart,monthStart}=jakartaPeriodStarts(), pick=start=>rows.filter(r=>Number(r.opened_time)>=start);
  return {timezone:'Asia/Jakarta',daily:summarize(pick(dayStart)),weekly:summarize(pick(weekStart)),monthly:summarize(pick(monthStart)),overall:summarize(rows),
    timeframes:Object.fromEntries(ACTIVE_TFS.map(tf=>[tf,summarize(rows.filter(r=>r.timeframe===tf))])),database:true,deduplicated:true,activeTimeframes:ACTIVE_TFS};
}
function historyRow(r) {
  const p=r.payload&&typeof r.payload==='object'?r.payload:{};
  return {...p,id:r.id,timeframe:r.timeframe,symbol:r.symbol,dir:r.direction,status:r.status,openedTime:n(r.opened_time),closedTime:n(r.closed_time),entry:n(r.entry),structuralSl:n(r.structural_sl),sl:n(r.sl),slPips:n(r.sl_pips),tps:[n(r.tp1),n(r.tp2),n(r.tp3),n(r.tp4)],tpHits:[!!r.tp1_hit,!!r.tp2_hit,!!r.tp3_hit,!!r.tp4_hit],outcome:r.outcome||(r.status==='closed'&&r.payload?.result==='SL'?'LOSS':'OPEN'),pnlPips:n(r.pnl_pips)};
}
export async function getHistoricalEntries({timeframe=null,limit=500}={}) {
  if (!pool) return null;
  const safeLimit=Math.max(1,Math.min(2000,Number(limit)||500)), params=[];
  let where='TRUE';
  if (timeframe) {
    const tf=String(timeframe).toUpperCase();
    if (!ACTIVE_TFS.includes(tf)) throw new Error('timeframe must be M1 or M3');
    params.push(tf); where=`timeframe = $${params.length}`;
  }
  params.push(safeLimit);
  const {rows}=await pool.query(`SELECT * FROM (${DEDUPED_TRADES_SQL}) d WHERE ${where} ORDER BY opened_time DESC LIMIT $${params.length}`,params);
  return rows.map(historyRow);
}
export const databaseEnabled=()=>Boolean(pool);
