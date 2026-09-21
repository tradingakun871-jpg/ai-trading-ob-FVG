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
async function notifyAiMarketChanges(result){const intradayBias=String(result?.intraday?.bias||'NEUTRAL').toUpperCase(),swingBias=String(result?.swing?.bias||'NEUTRAL').toUpperCase(),best=pickBestAiEntry(result),hasBest=Boolean(best),prev=aiMarketBestState;if(!prev.initialized){Object.assign(aiMarketBestState,{initialized:true,hasBest,bestBias:best?.bias||null,intradayBias,swingBias});console.log(\`AI Telegram baseline seeded best=\${hasBest?best.source+':'+best.bias:'NONE'} intraday=\${intradayBias} swing=\${swingBias}\`);return}const directionChanged=intradayBias!==prev.intradayBias||swingBias!==prev.swingBias,newEntry=hasBest&&!prev.hasBest;if(directionChanged&&hasBest){await sendTelegram(aiBestEntryMessage(best,result,'PERUBAHAN_ARAH_MARKET'),{event:'AI_BEST_ENTRY_DIRECTION',tf:best.source==='INTRADAY'?'M1/M3':'SWING'})}else if(directionChanged){await sendTelegram(aiMarketDirectionOnlyMessage(prev.intradayBias,intradayBias,prev.swingBias,swingBias),{event:'AI_MARKET_DIRECTION',tf:'M1/M3'})}else if(newEntry){await sendTelegram(aiBestEntryMessage(best,result,'ENTRY_BARU'),{event:'AI_BEST_ENTRY',tf:best.source==='INTRADAY'?'M1/M3':'SWING'})}Object.assign(aiMarketBestState,{initialized:true,hasBest,bestBias:best?.bias||null,intradayBias,swingBias})}
`;
source=source.slice(0,a)+replacement+source.slice(b);
fs.writeFileSync(serverPath,source,'utf8');

console.log('Telegram VALIDATED SIGNAL ONLY active: AI Market plans/direction stay silent; only strategy/execution lifecycle notifications remain');
await import('./boot.js');
