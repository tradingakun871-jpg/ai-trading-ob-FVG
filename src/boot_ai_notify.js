import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const serverPath=path.join(__dirname,'server.js');
let source=fs.readFileSync(serverPath,'utf8');

const startMarker='const aiMarketTelegramState=';
const endMarker='function aiEntryFilterDecision';
const a=source.indexOf(startMarker);
const b=source.indexOf(endMarker,a);
if(a<0||b<0)throw new Error('AI market Telegram notification block not found');

const replacement=`const aiMarketTelegramState={intraday:{initialized:false,bias:null,hasEntry:false},swing:{initialized:false,bias:null,hasEntry:false}};
function aiMarketTelegramMessage(label,x,reason='ENTRY_BARU'){return [\`🤖 AI \${label} XAUUSD\`,\`Update: \${reason}\`,\`Bias: \${x.bias} | Kondisi: \${x.condition}\`,\`Entry: \${fmt(x.entryPrice)}\`,\`SL: \${fmt(x.stopLoss)}\`,\`TP1: \${fmt(x.takeProfit1)} (\${Number(x.tp1Probability||0)}%)\`,\`TP2: \${fmt(x.takeProfit2)} (\${Number(x.tp2Probability||0)}%)\`,\`TP3: \${fmt(x.takeProfit3)} (\${Number(x.tp3Probability||0)}%)\`,\`Estimasi Winrate: \${Number(x.estimatedWinrate||0)}% | Confidence: \${Number(x.confidence||0)}%\`,\`Zona: \${x.entryZone||'—'}\`,\`Invalidasi: \${x.invalidation||'—'}\`,\`PA: \${x.priceAction||'—'}\`,'Status: AI MARKET PLAN — advisory; eksekusi tetap menunggu fresh OB+FVG dan PRE-ENTRY AI.','Catatan: Telegram hanya update saat ENTRY AI baru atau arah market berubah.'].join('\\n')}
function aiMarketDirectionMessage(label,fromBias,toBias,x){return [\`🔄 AI \${label} XAUUSD — ARAH MARKET BERUBAH\`,\`Arah: \${fromBias||'—'} → \${toBias}\`,\`Kondisi: \${x?.condition||'UNCERTAIN'} | Confidence: \${Number(x?.confidence||0)}%\`,toBias==='NEUTRAL'?'Status: WAIT — belum ada entry AI valid.':'Status: arah market berubah; gunakan level AI terbaru hanya sebagai advisory.','AI Market Analysis tetap advisory untuk PRE-ENTRY M1/M3.'].join('\\n')}
async function notifyAiMarketChanges(result){for(const [k,label] of [['intraday','INTRADAY'],['swing','SWING']]){const x=result?.[k];if(!x)continue;const bias=String(x.bias||'NEUTRAL').toUpperCase(),entry=Number(x.entryPrice||0),sl=Number(x.stopLoss||0),valid=bias!=='NEUTRAL'&&Number.isFinite(entry)&&entry>0&&Number.isFinite(sl)&&sl>0,prev=aiMarketTelegramState[k]||{initialized:false,bias:null,hasEntry:false};if(!prev.initialized){aiMarketTelegramState[k]={initialized:true,bias,hasEntry:valid};console.log(\`AI Telegram baseline seeded tf=\${k} bias=\${bias} valid=\${valid}\`);continue}const directionChanged=bias!==prev.bias,newEntry=valid&&!prev.hasEntry;if(directionChanged&&valid){await sendTelegram(aiMarketTelegramMessage(label,x,'PERUBAHAN_ARAH_MARKET'),{event:\`AI_\${label}_DIRECTION\`,tf:k==='intraday'?'M1/M3':'SWING'})}else if(directionChanged){await sendTelegram(aiMarketDirectionMessage(label,prev.bias,bias,x),{event:\`AI_\${label}_DIRECTION\`,tf:k==='intraday'?'M1/M3':'SWING'})}else if(newEntry){await sendTelegram(aiMarketTelegramMessage(label,x,'ENTRY_BARU'),{event:\`AI_\${label}_PLAN\`,tf:k==='intraday'?'M1/M3':'SWING'})}aiMarketTelegramState[k]={initialized:true,bias,hasEntry:valid}}}
`;
source=source.slice(0,a)+replacement+source.slice(b);
fs.writeFileSync(serverPath,source,'utf8');

console.log('AI Market Telegram filter active: same-direction level/SL/TP/confidence changes are silent; notify only new AI entry or market-direction change');
await import('./boot.js');
