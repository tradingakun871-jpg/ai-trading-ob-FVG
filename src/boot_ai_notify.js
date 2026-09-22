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

const replacement=`const aiMarketBestState={initialized:false,hasBest:false,bestBias:null,intradayBias:null,swingBias:null};
function aiMarketCandidate(sourceLabel,x){if(!x)return null;const bias=String(x.bias||'NEUTRAL').toUpperCase(),entry=Number(x.entryPrice||0),sl=Number(x.stopLoss||0),tp1=Number(x.takeProfit1||0),valid=bias!=='NEUTRAL'&&Number.isFinite(entry)&&entry>0&&Number.isFinite(sl)&&sl>0&&Number.isFinite(tp1)&&tp1>0;if(!valid)return null;const risk=Math.abs(entry-sl),reward1=Math.abs(tp1-entry),rr1=risk>0?reward1/risk:0;if(!Number.isFinite(rr1)||rr1<1)return null;const confidence=Number(x.confidence||0),wr=Number(x.estimatedWinrate||0),p1=Number(x.tp1Probability||0),p2=Number(x.tp2Probability||0),p3=Number(x.tp3Probability||0),score=Math.round((confidence*.40+wr*.25+p1*.20+p2*.10+p3*.05)*10)/10;return{source:sourceLabel,bias,entry,sl,score,x}}
function pickBestAiEntry(result){const list=[aiMarketCandidate('INTRADAY',result?.intraday),aiMarketCandidate('SWING',result?.swing)].filter(Boolean);if(!list.length)return null;list.sort((a,b)=>b.score-a.score||(a.source==='INTRADAY'?-1:1));return list[0]}
function aiBestEntryMessage(best,result,reason='ENTRY_BARU'){const x=best.x,a=result?.intraday||{},s=result?.swing||{};return ['🏆 BEST ENTRY OPENAI — XAUUSD',\`Update: \${reason}\`,\`Sumber analisa: \${best.source}\`,\`Arah: \${best.bias} | Kondisi: \${x.condition}\`,\`Entry: \${fmt(x.entryPrice)}\`,\`SL: \${fmt(x.stopLoss)}\`,\`TP1: \${fmt(x.takeProfit1)} (\${Number(x.tp1Probability||0)}%)\`,\`TP2: \${fmt(x.takeProfit2)} (\${Number(x.tp2Probability||0)}%)\`,\`TP3: \${fmt(x.takeProfit3)} (\${Number(x.tp3Probability||0)}%)\`,\`Estimasi Winrate AI: \${Number(x.estimatedWinrate||0)}%\`,\`Confidence: \${Number(x.confidence||0)}% | Best Score: \${best.score}\`,\`Konteks: Intraday \${a.bias||'NEUTRAL'} • Swing \${s.bias||'NEUTRAL'}\`,\`Zona: \${x.entryZone||'—'}\`,\`Invalidasi: \${x.invalidation||'—'}\`,\`PA: \${x.priceAction||'—'}\`,'Status: AI MARKET PLAN — advisory; eksekusi M1/M3 tetap menunggu fresh OB+FVG dan PRE-ENTRY AI.','Catatan: bukan jaminan hasil; Telegram tidak di-update untuk perubahan level/SL/TP/confidence rutin.'].join('\\n')}
function aiMarketDirectionOnlyMessage(fromIntra,toIntra,fromSwing,toSwing){return ['🔄 AI MARKET XAUUSD — ARAH MARKET BERUBAH',\`Intraday: \${fromIntra||'—'} → \${toIntra}\`,\`Swing: \${fromSwing||'—'} → \${toSwing}\`,'Best Entry OpenAI: belum ada entry valid saat ini.','Status: WAIT — AI Market Analysis tetap advisory untuk PRE-ENTRY M1/M3.'].join('\\n')}
async function notifyAiMarketChanges(result){const intradayBias=String(result?.intraday?.bias||'NEUTRAL').toUpperCase(),swingBias=String(result?.swing?.bias||'NEUTRAL').toUpperCase(),best=pickBestAiEntry(result),hasBest=Boolean(best),prev=aiMarketBestState,x=best?.x||{},risk=best?Math.abs(Number(best.entry)-Number(best.sl)):0,reward=best?Math.abs(Number(x.takeProfit1||0)-Number(best.entry)):0,rr=risk>0?reward/risk:0,p1=Number(x.tp1Probability||0),confidence=Number(x.confidence||0),wr=Number(x.estimatedWinrate||0),validated=hasBest&&rr>=1&&p1>=65&&confidence>=65&&wr>=55,signature=validated?[best.source,best.bias,Number(best.entry).toFixed(2),Number(best.sl).toFixed(2),Number(x.takeProfit1||0).toFixed(2)].join('|'):null,previousSignature=prev.validatedSignature||null;if(validated&&signature!==previousSignature){await sendTelegram(aiBestEntryMessage(best,result,'AI_MARKET_VALIDATED'),{event:'AI_MARKET_VALIDATED',tf:best.source==='INTRADAY'?'M1/M3':'SWING'});console.log(\`AI Market VALIDATED sent source=\${best.source} bias=\${best.bias} rr=\${rr.toFixed(2)} p1=\${p1} confidence=\${confidence} winrate=\${wr}\`)}else console.log(\`AI Market Telegram check validated=\${validated} best=\${hasBest?best.source+':'+best.bias:'NONE'} rr=\${Number.isFinite(rr)?rr.toFixed(2):'0'} p1=\${p1} confidence=\${confidence}\`);Object.assign(aiMarketBestState,{initialized:true,hasBest,bestBias:best?.bias||null,intradayBias,swingBias,validatedSignature:signature})}
`;
source=source.slice(0,a)+replacement+source.slice(b);
fs.writeFileSync(serverPath,source,'utf8');

console.log('Telegram AI Market VALIDATED ONLY active: validated entries only; routine direction/price/confidence changes stay silent');
await import('./boot.js');
