import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(__dirname,'..');

function writeIfChanged(file,next){
  const current=fs.readFileSync(file,'utf8');
  if(current!==next)fs.writeFileSync(file,next);
}

// 1) Tag trades/setups created by candle ingestion. The source tag is now handled
// directly by server/strategy code; keep boot compatible with newer ingest signatures.
// 2) Expose source on /api/history. New rows use payload.source. Old rows are inferred from
// DB insertion time vs trade opened time (>5 minutes means the row was reconstructed later).
{
  const file=path.join(__dirname,'database.js');
  let s=fs.readFileSync(file,'utf8');
  if(!s.includes('inferredSource=')){
    const old="  const p=r.payload&&typeof r.payload==='object'?r.payload:{};\n  return {...p,id:r.id,timeframe:r.timeframe";
    const neu="  const p=r.payload&&typeof r.payload==='object'?r.payload:{};\n  const opened=n(r.opened_time),created=r.created_at?new Date(r.created_at).getTime():null,inferredSource=(opened!=null&&Number.isFinite(created)&&Math.abs(created-opened)>300000)?'BACKFILL':'LIVE',source=String(p.source||inferredSource).toUpperCase();\n  return {...p,source,id:r.id,timeframe:r.timeframe";
    if(!s.includes(old))throw new Error('Historical source patch: historyRow marker not found');
    s=s.replace(old,neu);
    writeIfChanged(file,s);
  }
}

// 3) Dashboard: show source explicitly so replay rows cannot be mistaken for live signals.
{
  const file=path.join(root,'public','app.js');
  let s=fs.readFileSync(file,'utf8');
  if(!s.includes("String(x.source||'LIVE')")){
    const old="${(x.tps||[]).map(t=>`<td>${fmt(t)}</td>`).join('')}<td>${historyResult(x)}</td></tr>`).join(''):'<tr><td colspan=\"11\" class=\"empty\">Belum ada historical entry.</td></tr>'";
    const neu="${(x.tps||[]).map(t=>`<td>${fmt(t)}</td>`).join('')}<td><span class=\"${String(x.source||'LIVE')==='LIVE'?'status-ok':'muted'}\">${String(x.source||'LIVE')}</span></td><td>${historyResult(x)}</td></tr>`).join(''):'<tr><td colspan=\"12\" class=\"empty\">Belum ada historical entry.</td></tr>'";
    if(!s.includes(old))throw new Error('Historical source patch: app.js history marker not found');
    s=s.replace(old,neu);
    writeIfChanged(file,s);
  }
}

{
  const file=path.join(root,'public','index.html');
  let s=fs.readFileSync(file,'utf8');
  if(!s.includes('<th>Source</th>')){
    s=s.replace('Historical dibaca dari database.</p>','Historical dibaca dari database. LIVE = signal realtime; BACKFILL = replay/reconstruction dan tidak dieksekusi EA/Telegram.</p>');
    const old='<th>TP3</th><th>TP4</th><th>Hasil</th>';
    const neu='<th>TP3</th><th>TP4</th><th>Source</th><th>Hasil</th>';
    if(!s.includes(old))throw new Error('Historical source patch: index history header marker not found');
    s=s.replace(old,neu).replace('/app.js?v=20260919-1518','/app.js?v=20260922-source');
    writeIfChanged(file,s);
  }
}

console.log('Historical source provenance patch prepared: LIVE/BACKFILL');
await import('./boot_ai_notify.js');
