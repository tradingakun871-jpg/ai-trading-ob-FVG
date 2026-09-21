import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

const startMarker = 'const aiMarketTelegramState=';
const endMarker = 'function aiEntryFilterDecision';
const a = source.indexOf(startMarker);
const b = source.indexOf(endMarker, a);
if (a < 0 || b < 0) throw new Error('AI market Telegram notification block not found');

const replacement = `const AI_MARKET_ENTRY_UPDATE_PIPS=Math.max(1,Number(process.env.AI_MARKET_ENTRY_UPDATE_PIPS||10));
const aiMarketTelegramState={
  intraday:{bias:null,hasEntry:false,entryPrice:null},
  swing:{bias:null,hasEntry:false,entryPrice:null}
};
function aiMarketTelegramMessage(label,x,reason='ENTRY_BARU'){return [\`🤖 AI \${label} XAUUSD\`,\`Update: \${reason}\`,\`Bias: \${x.bias} | Kondisi: \${x.condition}\`,\`Entry: \${fmt(x.entryPrice)}\`,\`SL: \${fmt(x.stopLoss)}\`,\`TP1: \${fmt(x.takeProfit1)} (\${Number(x.tp1Probability||0)}%)\`,\`TP2: \${fmt(x.takeProfit2)} (\${Number(x.tp2Probability||0)}%)\`,\`TP3: \${fmt(x.takeProfit3)} (\${Number(x.tp3Probability||0)}%)\`,\`Estimasi Winrate: \${Number(x.estimatedWinrate||0)}% | Confidence: \${Number(x.confidence||0)}%\`,\`Zona: \${x.entryZone||'—'}\`,\`Invalidasi: \${x.invalidation||'—'}\`,\`PA: \${x.priceAction||'—'}\`,'Status: AI MARKET PLAN — advisory; eksekusi tetap menunggu fresh OB+FVG dan PRE-ENTRY AI.','Catatan: update Telegram hanya untuk entry baru atau perubahan arah market.'].join('\\n')}
function aiMarketDirectionMessage(label,fromBias,toBias,x){return [\`🔄 AI \${label} XAUUSD — ARAH MARKET BERUBAH\`,\`Arah: \${fromBias||'—'} → \${toBias}\`,\`Kondisi: \${x?.condition||'UNCERTAIN'} | Confidence: \${Number(x?.confidence||0)}%\`,toBias==='NEUTRAL'?'Status: WAIT — belum ada entry AI valid.':'Status: arah market berubah; tunggu/ikuti entry AI valid terbaru.','AI Market Analysis tetap advisory untuk PRE-ENTRY M1/M3.'].join('\\n')}
async function notifyAiMarketChanges(result){
  for(const [k,label] of [['intraday','INTRADAY'],['swing','SWING']]){
    const x=result?.[k]; if(!x)continue;
    const bias=String(x.bias||'NEUTRAL').toUpperCase();
    const entry=Number(x.entryPrice||0), sl=Number(x.stopLoss||0);
    const valid=bias!=='NEUTRAL'&&Number.isFinite(entry)&&entry>0&&Number.isFinite(sl)&&sl>0;
    const prev=aiMarketTelegramState[k]||{bias:null,hasEntry:false,entryPrice:null};
    const directionChanged=prev.bias!==null&&bias!==prev.bias;
    const pip=Math.max(0.00001,Number(engines.M1?.config?.pipSize||0.1));
    const entryDeltaPips=(valid&&prev.hasEntry&&Number(prev.entryPrice)>0)?Math.abs(entry-Number(prev.entryPrice))/pip:Infinity;
    const newEntry=valid&&(!prev.hasEntry||entryDeltaPips>=AI_MARKET_ENTRY_UPDATE_PIPS);
    if(valid&&(directionChanged||newEntry)){
      const reason=directionChanged?'PERUBAHAN_ARAH_MARKET':'ENTRY_BARU';
      await sendTelegram(aiMarketTelegramMessage(label,x,reason),{event:\`AI_\${label}_PLAN\`,tf:k==='intraday'?'M1/M3':'SWING'});
    }else if(directionChanged){
      await sendTelegram(aiMarketDirectionMessage(label,prev.bias,bias,x),{event:\`AI_\${label}_DIRECTION\`,tf:k==='intraday'?'M1/M3':'SWING'});
    }
    aiMarketTelegramState[k]={bias,hasEntry:valid,entryPrice:valid?entry:null};
  }
}
`;

source = source.slice(0, a) + replacement + source.slice(b);
fs.writeFileSync(serverPath, source);
console.log('AI Market Telegram filter active: new entry or direction change only; material same-direction entry threshold='+String(process.env.AI_MARKET_ENTRY_UPDATE_PIPS||10)+' pips');
await import('./start.js');
