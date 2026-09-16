const $ = (id) => document.getElementById(id);
const fmt = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '—';
const tfs = ['M1','M3','M5'];
let lastData = null;
let historyFilter = 'ALL';

async function api(path, options) {
  const r = await fetch(path, options);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const timeText = (v) => v ? new Date(v).toLocaleString() : '—';

function wrHtml(stats) {
  return stats.winrates.map(x => `<div class="wr"><span>TP${x.target}</span><strong>${x.winrate.toFixed(1)}%</strong><small>${x.wins}W / ${x.losses}L</small></div>`).join('');
}

function historyResult(x) {
  if (x.outcome === 'WIN' || x.tpHits?.[0]) return `WIN${x.tpHits?.[3] ? ' • TP4' : x.tpHits?.[2] ? ' • TP3' : x.tpHits?.[1] ? ' • TP2' : ' • TP1'}`;
  if (x.outcome === 'LOSS' || (x.status === 'closed' && x.result === 'SL')) return 'LOSS • SL';
  return 'LIVE';
}

function renderHistory() {
  if (!lastData) return;
  const rows = historyFilter === 'ALL' ? lastData.history : lastData.timeframes[historyFilter].history.map(x => ({...x,timeframe:historyFilter}));
  $('history').innerHTML = rows.length ? rows.map(x => `<tr>
    <td><b>${x.timeframe}</b></td><td>${timeText(x.openedTime)}</td><td class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</td>
    <td>${fmt(x.entry)}</td><td>${fmt(x.sl)}</td><td>${Number(x.slPips).toFixed(1)}</td>${x.tps.map(t=>`<td>${fmt(t)}</td>`).join('')}<td>${historyResult(x)}</td>
  </tr>`).join('') : '<tr><td colspan="11" class="empty">Belum ada historical entry.</td></tr>';
}

function render(data) {
  lastData = data;
  $('health').textContent = 'ONLINE'; $('health').className = 'pill ok';
  $('symbol').textContent = data.symbol;
  $('price').textContent = data.livePrice == null ? (data.timeframes.M1.price == null ? '—' : fmt(data.timeframes.M1.price)) : fmt(data.livePrice);
  $('allTrades').textContent = data.combined.confirmedEntries ?? data.combined.totalTrades ?? 0;
  $('allLive').textContent = data.combined.liveTrades;
  $('allPending').textContent = data.combined.pending;
  $('allSkipped').textContent = data.combined.skipped;

  const integrations = data.integrations || {};
  const mt5 = integrations.mt5 || {};
  $('mt5Status').textContent = mt5.connected ? 'CONNECTED' : 'OFFLINE';
  $('mt5Status').className = mt5.connected ? 'status-ok' : 'status-bad';
  $('mt5Detail').textContent = mt5.connected
    ? `${mt5.symbol || data.symbol} • Bid ${fmt(mt5.bid)} / Ask ${fmt(mt5.ask)} • ${timeText(mt5.lastSeen)}`
    : (mt5.lastSeen ? `Last seen ${timeText(mt5.lastSeen)}` : 'Menunggu heartbeat dari MT5');

  const overall = data.combined.overall || { wins:0, losses:0, resolved:0, winrate:0 };
  $('overallWinrate').textContent = `${Number(overall.winrate || 0).toFixed(1)}%`;
  $('overallRecord').textContent = `${overall.wins || 0}W / ${overall.losses || 0}L`;
  $('overallWins').textContent = overall.wins || 0;
  $('overallLosses').textContent = overall.losses || 0;
  $('overallResolved').textContent = overall.resolved || 0;

  const s = data.lastSignal;
  $('signalBox').className = 'signal ' + (s ? (s.dir === 'buy' ? 'buy' : 'sell') : 'neutral');
  $('signal').textContent = s ? `${s.timeframe} ${s.dir.toUpperCase()} @ ${fmt(s.entry)}` : 'WAITING';
  $('signalTime').textContent = s ? timeText(s.time) : 'Belum ada entry valid';

  $('tfGrid').innerHTML = tfs.map(tf => {
    const d = data.timeframes[tf];
    const sig = d.lastSignal;
    return `<article class="tf-card">
      <div class="tf-title"><b>${tf}</b><span>${d.price == null ? '—' : fmt(d.price)}</span></div>
      <div class="tf-metrics"><div><small>Fresh OB</small><strong>${d.freshOB.length}</strong></div><div><small>Fresh FVG</small><strong>${d.freshFVG.length}</strong></div><div><small>Pending</small><strong>${d.pending.length}</strong></div><div><small>Entry</small><strong>${d.stats.confirmedEntries ?? d.stats.total ?? 0}</strong></div></div>
      <div class="tf-signal ${sig ? (sig.dir==='buy'?'buy':'sell') : ''}">${sig ? `${sig.dir.toUpperCase()} ${fmt(sig.entry)}` : 'WAITING'}</div>
    </article>`;
  }).join('');

  $('winrateByTf').innerHTML = tfs.map(tf => {
    const st = data.timeframes[tf].stats;
    const p = st.primary || { winrate:0, wins:0, losses:0 };
    const entries = st.confirmedEntries ?? st.total ?? 0;
    return `<article class="tf-wr-block"><div class="tf-wr-head"><h3>${tf}</h3><span>Overall ${Number(p.winrate).toFixed(1)}% • ${p.wins}W/${p.losses}L • ${entries} entry • ${st.skipped} skipped</span></div><div class="wr-grid">${wrHtml(st)}</div></article>`;
  }).join('');

  const pending = tfs.flatMap(tf => data.timeframes[tf].pending.map(x => ({...x,timeframe:tf})));
  $('setups').innerHTML = pending.length ? pending.map(x => `<div class="row"><b>${x.timeframe}</b><b class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</b><small>ENTRY ${fmt(x.plannedEntry)}</small><small>FVG ${fmt(x.fvgBottom)}–${fmt(x.fvgTop)}</small></div>`).join('') : '<div class="empty">Belum ada setup aktif.</div>';

  const live = tfs.flatMap(tf => data.timeframes[tf].liveTrades.map(x => ({...x,timeframe:tf})));
  $('positions').innerHTML = live.length ? live.map(x => `<div class="row"><b>${x.timeframe}</b><b class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</b><small>ENTRY ${fmt(x.entry)} / SL ${fmt(x.sl)}</small><small>${x.tpHits.map((h,i)=>`TP${i+1}:${h?'✓':'·'}`).join(' ')}</small></div>`).join('') : '<div class="empty">Belum ada posisi.</div>';

  renderHistory();
}

async function load() {
  try { render(await api('/api/status')); }
  catch(e) { $('health').textContent='OFFLINE'; $('health').className='pill'; console.error(e); }
}

$('historyTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tf]'); if (!b) return;
  historyFilter = b.dataset.tf; [...$('historyTabs').querySelectorAll('button')].forEach(x=>x.classList.toggle('active',x===b)); renderHistory();
});

load();
setInterval(load, 3000);
