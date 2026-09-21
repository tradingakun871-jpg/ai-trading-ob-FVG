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
  await pool.query('ALTER TABLE trading_setups ADD COLUMN IF NOT EXISTS quality_grade TEXT');
  await pool.query('ALTER TABLE trading_setups ADD COLUMN IF NOT EXISTS quality_score INTEGER');
  await pool.query('ALTER TABLE trading_setups ADD COLUMN IF NOT EXISTS market_regime TEXT');
  await pool.query('ALTER TABLE trading_setups ADD COLUMN IF NOT EXISTS regime_aligned BOOLEAN');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trading_setups_quality ON trading_setups(quality_grade,quality_score)');
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_market_plans (id BIGSERIAL PRIMARY KEY, horizon TEXT NOT NULL, generated_at BIGINT NOT NULL, bias TEXT NOT NULL, entry DOUBLE PRECISION, sl DOUBLE PRECISION, tp1 DOUBLE PRECISION, tp2 DOUBLE PRECISION, tp3 DOUBLE PRECISION, estimated_winrate INTEGER, tp1_probability INTEGER, tp2_probability INTEGER, tp3_probability INTEGER, status TEXT NOT NULL DEFAULT 'ACTIVE', tp1_hit BOOLEAN DEFAULT FALSE, tp2_hit BOOLEAN DEFAULT FALSE, tp3_hit BOOLEAN DEFAULT FALSE, outcome TEXT, closed_at BIGINT, payload JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_market_plans_horizon_time ON ai_market_plans(horizon,generated_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS mt5_execution_queue (
    id TEXT PRIMARY KEY, setup_id TEXT NOT NULL, timeframe TEXT NOT NULL, action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED', command JSONB NOT NULL, ticket TEXT, detail TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, acked_at BIGINT
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_mt5_execution_status ON mt5_execution_queue(status,created_at)');
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
      (id,timeframe,symbol,direction,status,setup_time,opened_time,closed_time,entry,structural_sl,sl,sl_pips,tp1,tp2,tp3,tp4,tp1_hit,tp2_hit,tp3_hit,tp4_hit,outcome,pnl_pips,skip_reason,payload,quality_grade,quality_score,market_regime,regime_aligned,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
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
      skip_reason=EXCLUDED.skip_reason,payload=EXCLUDED.payload,quality_grade=EXCLUDED.quality_grade,quality_score=EXCLUDED.quality_score,market_regime=EXCLUDED.market_regime,regime_aligned=EXCLUDED.regime_aligned,updated_at=NOW()`,
      [id,tf,symbol,x.dir,x.status,n(x.bornTime??x.time),n(x.openedTime),n(x.closedTime),entry,n(x.structuralSl),sl,riskPips,n(x.tps?.[0]),n(x.tps?.[1]),n(x.tps?.[2]),n(x.tps?.[3]),!!tpHits[0],!!tpHits[1],!!tpHits[2],!!tpHits[3],won?'WIN':closedLoss?'LOSS':null,pnlPips,x.skipReason||null,JSON.stringify(x),x.quality?.grade||null,n(x.quality?.score),x.quality?.regime||null,x.quality?.regimeAligned??null]);
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
export async function getWeeklyDecisionAnalysis(nowMs=Date.now()) {
  if (!pool) return null;
  const {weekStart}=jakartaPeriodStarts(nowMs);
  const {rows}=await pool.query(`SELECT * FROM (${DEDUPED_TRADES_SQL}) d WHERE opened_time >= $1 AND opened_time <= $2 ORDER BY opened_time ASC`,[weekStart,Number(nowMs)]);
  const resolved=rows.filter(r=>r.outcome==='WIN'||r.outcome==='LOSS');
  const group=(keyFn)=>Object.fromEntries([...new Set(rows.map(keyFn))].filter(v=>v!=null).map(k=>[k,summarize(rows.filter(r=>keyFn(r)===k))]));
  const dayKey=r=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Number(r.opened_time)));
  const hourKey=r=>String(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Jakarta',hour:'2-digit',hourCycle:'h23'}).format(new Date(Number(r.opened_time)))).padStart(2,'0')+':00';
  const byHour=group(hourKey), rankedHours=Object.entries(byHour).filter(([,x])=>x.resolved>0).sort((a,b)=>b[1].netPips-a[1].netPips);
  const tpHits={tp1:rows.filter(r=>r.tp1_hit).length,tp2:rows.filter(r=>r.tp2_hit).length,tp3:rows.filter(r=>r.tp3_hit).length,tp4:rows.filter(r=>r.tp4_hit).length,sl:rows.filter(r=>r.outcome==='LOSS').length};
  const total=summarize(rows), avgWin=total.wins?total.grossProfitPips/total.wins:0, avgLoss=total.losses?total.grossLossPips/total.losses:0;
  return {timezone:'Asia/Jakarta',period:{start:weekStart,end:Number(nowMs)},summary:{...total,expectancyPips:total.resolved?round1(total.netPips/total.resolved):0,avgWinPips:round1(avgWin),avgLossPips:round1(avgLoss)},
    timeframes:Object.fromEntries(ACTIVE_TFS.map(tf=>[tf,summarize(rows.filter(r=>r.timeframe===tf))])),
    directions:{BUY:summarize(rows.filter(r=>String(r.direction).toLowerCase()==='buy')),SELL:summarize(rows.filter(r=>String(r.direction).toLowerCase()==='sell'))},
    tpHits,days:group(dayKey),hours:byHour,bestHour:rankedHours[0]?{hour:rankedHours[0][0],...rankedHours[0][1]}:null,worstHour:rankedHours.length?{hour:rankedHours[rankedHours.length-1][0],...rankedHours[rankedHours.length-1][1]}:null,
    decision:{status:total.resolved<10?'INSUFFICIENT_SAMPLE':total.netPips>0?'POSITIVE_WEEK':total.netPips<0?'NEGATIVE_WEEK':'FLAT_WEEK',sampleSize:total.resolved,note:'Decision status is descriptive only; use timeframe, direction, hour and TP/SL breakdown to review strategy rules.'},
    database:true,deduplicated:true};
}

export async function getQualityGatePerformance(nowMs=Date.now()) {
  if (!pool) return null;
  const {weekStart}=jakartaPeriodStarts(nowMs);
  const {rows}=await pool.query(`SELECT * FROM (${DEDUPED_TRADES_SQL}) d WHERE opened_time >= $1 AND opened_time <= $2 AND quality_grade IS NOT NULL ORDER BY opened_time ASC`,[weekStart,Number(nowMs)]);
  const byGrade=Object.fromEntries(['A','B','C'].map(g=>[g,summarize(rows.filter(r=>r.quality_grade===g))]));
  const byRegime=Object.fromEntries(['bullish','bearish','neutral','unknown'].map(g=>[g,summarize(rows.filter(r=>(r.market_regime||'unknown')===g))]));
  const aligned={aligned:summarize(rows.filter(r=>r.regime_aligned===true)),counter:summarize(rows.filter(r=>r.regime_aligned===false))};
  const gradeDirection=Object.fromEntries(['A','B','C'].map(g=>[g,{BUY:summarize(rows.filter(r=>r.quality_grade===g&&String(r.direction).toLowerCase()==='buy')),SELL:summarize(rows.filter(r=>r.quality_grade===g&&String(r.direction).toLowerCase()==='sell'))}]));
  return {timezone:'Asia/Jakarta',period:{start:weekStart,end:Number(nowMs)},mode:'SHADOW',sample:summarize(rows),grades:byGrade,regimes:byRegime,regimeAlignment:aligned,gradeDirection,database:true,note:'Shadow analytics only. Quality grades do not block live execution.'};
}

export async function saveAiMarketPlans(result){if(!pool||!result)return false;for(const horizon of ['intraday','swing']){const x=result[horizon];if(!x||!Number(x.entryPrice)||!['BUY','SELL'].includes(x.bias))continue;const recent=await pool.query("SELECT id FROM ai_market_plans WHERE horizon=$1 AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",[horizon]);if(recent.rowCount)continue;await pool.query("INSERT INTO ai_market_plans(horizon,generated_at,bias,entry,sl,tp1,tp2,tp3,estimated_winrate,tp1_probability,tp2_probability,tp3_probability,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[horizon,Number(result.generatedAt||Date.now()),x.bias,Number(x.entryPrice),Number(x.stopLoss),Number(x.takeProfit1),Number(x.takeProfit2),Number(x.takeProfit3),Number(x.estimatedWinrate||0),Number(x.tp1Probability||0),Number(x.tp2Probability||0),Number(x.tp3Probability||0),JSON.stringify(x)])}return true}
export async function updateAiMarketPlans(price,time=Date.now()){if(!pool||!Number.isFinite(Number(price)))return false;const p=Number(price),{rows}=await pool.query("SELECT * FROM ai_market_plans WHERE status='ACTIVE'");for(const x of rows){const buy=x.bias==='BUY',sl=buy?p<=x.sl:p>=x.sl,t1=buy?p>=x.tp1:p<=x.tp1,t2=buy?p>=x.tp2:p<=x.tp2,t3=buy?p>=x.tp3:p<=x.tp3;let status='ACTIVE',outcome=null;if(sl&&!x.tp1_hit&&!t1){status='CLOSED';outcome='LOSS'}else if(t3){status='CLOSED';outcome='TP3'}await pool.query("UPDATE ai_market_plans SET tp1_hit=tp1_hit OR $2,tp2_hit=tp2_hit OR $3,tp3_hit=tp3_hit OR $4,status=$5,outcome=COALESCE($6,outcome),closed_at=CASE WHEN $5='CLOSED' THEN $7 ELSE closed_at END WHERE id=$1",[x.id,t1,t2,t3,status,outcome,status==='CLOSED'?Number(time):null])}return true}
export async function getAiMarketPerformance(){if(!pool)return null;const {rows}=await pool.query("SELECT * FROM ai_market_plans ORDER BY generated_at DESC LIMIT 1000");const sum=h=>{const a=rows.filter(x=>x.horizon===h),resolved=a.filter(x=>x.outcome);const hits=k=>a.filter(x=>x[k]).length;return{signals:a.length,active:a.filter(x=>x.status==='ACTIVE').length,resolved:resolved.length,wins:resolved.filter(x=>x.tp1_hit).length,losses:resolved.filter(x=>x.outcome==='LOSS').length,actualWinrate:resolved.length?+(resolved.filter(x=>x.tp1_hit).length/resolved.length*100).toFixed(1):0,tp1Actual:a.length?+(hits('tp1_hit')/a.length*100).toFixed(1):0,tp2Actual:a.length?+(hits('tp2_hit')/a.length*100).toFixed(1):0,tp3Actual:a.length?+(hits('tp3_hit')/a.length*100).toFixed(1):0,avgEstimatedWinrate:a.length?+(a.reduce((s,x)=>s+Number(x.estimated_winrate||0),0)/a.length).toFixed(1):0,avgTp1Probability:a.length?+(a.reduce((s,x)=>s+Number(x.tp1_probability||0),0)/a.length).toFixed(1):0,avgTp2Probability:a.length?+(a.reduce((s,x)=>s+Number(x.tp2_probability||0),0)/a.length).toFixed(1):0,avgTp3Probability:a.length?+(a.reduce((s,x)=>s+Number(x.tp3_probability||0),0)/a.length).toFixed(1):0}};return{intraday:sum('intraday'),swing:sum('swing'),database:true,note:'Actual results are measured from saved AI plans and live MT5 price updates.'}}
export async function saveMt5ExecutionCommand(cmd,status='QUEUED'){if(!pool||!cmd?.id)return false;const now=Date.now();await pool.query(`INSERT INTO mt5_execution_queue(id,setup_id,timeframe,action,status,command,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,command=EXCLUDED.command,updated_at=EXCLUDED.updated_at`,[String(cmd.id),String(cmd.setupId||''),String(cmd.timeframe||''),String(cmd.action||''),String(status),JSON.stringify(cmd),Number(cmd.createdAt||now)]);return true}
export async function updateMt5ExecutionCommand(id,status,{ticket=null,detail=null}={}){if(!pool||!id)return false;await pool.query('UPDATE mt5_execution_queue SET status=$2,ticket=COALESCE($3,ticket),detail=COALESCE($4,detail),updated_at=$5,acked_at=$5 WHERE id=$1',[String(id),String(status),ticket==null?null:String(ticket),detail==null?null:String(detail),Date.now()]);return true}
export async function getRecoverableMt5Commands(){if(!pool)return[];const {rows}=await pool.query("SELECT command,status,ticket,detail FROM mt5_execution_queue WHERE status IN ('QUEUED','CANCEL_QUEUED') ORDER BY created_at ASC LIMIT 500");return rows.map(r=>({...r.command,_persistedStatus:r.status,_ticket:r.ticket,_detail:r.detail}))}
export async function getMt5ExecutionAudit(limit=200){if(!pool)return[];const n=Math.max(1,Math.min(1000,Number(limit)||200));const {rows}=await pool.query('SELECT id,setup_id,timeframe,action,status,ticket,detail,created_at,updated_at,acked_at,command FROM mt5_execution_queue ORDER BY created_at DESC LIMIT $1',[n]);return rows}
export const databaseEnabled=()=>Boolean(pool);

export async function getSessionReport(startMs,endMs) {
  if (!pool) return null;
  const start=Number(startMs), end=Number(endMs);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) throw new Error('invalid session range');
  const {rows}=await pool.query(`SELECT * FROM (${DEDUPED_TRADES_SQL}) d WHERE opened_time >= $1 AND opened_time < $2 ORDER BY opened_time ASC`,[start,end]);
  return {start,end,timezone:'Asia/Jakarta',summary:summarize(rows),timeframes:Object.fromEntries(ACTIVE_TFS.map(tf=>[tf,summarize(rows.filter(r=>r.timeframe===tf))])),trades:rows.map(historyRow)};
}
