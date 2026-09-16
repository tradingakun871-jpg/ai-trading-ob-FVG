const $ = (id) => document.getElementById(id);
const fmt = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '—';

async function api(path, options) {
  const r = await fetch(path, options);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function render(data) {
  $('health').textContent = 'ONLINE';
  $('health').className = 'pill ok';
  $('symbol').textContent = data.config.symbol;
  $('tf').textContent = data.config.timeframe;
  $('price').textContent = data.price == null ? '—' : fmt(data.price);
  $('freshOb').textContent = data.freshOB.length;
  $('freshFvg').textContent = data.freshFVG.length;
  $('pending').textContent = data.pending.length;
  $('live').textContent = data.liveTrades.length;
  $('trades').textContent = data.stats.total;
  $('skipped').textContent = data.stats.skipped;

  const s = data.lastSignal;
  $('signalBox').className = 'signal ' + (s ? (s.dir === 'buy' ? 'buy' : 'sell') : 'neutral');
  $('signal').textContent = s ? `${s.dir.toUpperCase()} @ ${fmt(s.entry)}` : 'WAITING';
  $('signalTime').textContent = s ? new Date(s.time).toLocaleString() : 'Belum ada entry valid';

  $('wrGrid').innerHTML = data.stats.winrates.map(x => `
    <div class="wr"><span>TP${x.target}</span><strong>${x.winrate.toFixed(1)}%</strong><small>${x.wins}W / ${x.resolved - x.wins}L</small></div>
  `).join('');

  $('setups').innerHTML = data.pending.length ? data.pending.map(x => `
    <div class="row"><b class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</b><small>FVG ${fmt(x.fvgBottom)} - ${fmt(x.fvgTop)}</small><small>SL ${fmt(x.structuralSl)}</small><small>PENDING</small></div>
  `).join('') : '<div class="empty">Belum ada setup aktif.</div>';

  $('positions').innerHTML = data.liveTrades.length ? data.liveTrades.map(x => `
    <div class="row"><b class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</b><small>ENTRY ${fmt(x.entry)}</small><small>SL ${fmt(x.sl)}</small><small>${x.tpHits.map((h,i)=>`TP${i+1}:${h?'✓':'·'}`).join(' ')}</small></div>
  `).join('') : '<div class="empty">Belum ada posisi.</div>';

  $('history').innerHTML = data.history.map(x => `
    <tr><td class="${x.dir==='buy'?'buytxt':'selltxt'}">${x.dir.toUpperCase()}</td><td>${fmt(x.entry)}</td><td>${fmt(x.sl)}</td><td>${Number(x.slPips).toFixed(1)}</td>${x.tps.map(t=>`<td>${fmt(t)}</td>`).join('')}<td>${x.result || x.status.toUpperCase()}</td></tr>
  `).join('');
}

async function load() {
  try { render(await api('/api/status')); }
  catch (e) { $('health').textContent = 'OFFLINE'; $('health').className = 'pill'; console.error(e); }
}

async function loadConfig() {
  const c = await api('/api/config');
  $('cfgSymbol').value = c.symbol;
  $('cfgTf').value = c.timeframe;
  $('cfgPip').value = c.pipSize;
  $('cfgMaxSl').value = c.maxSwingSlPips;
  $('cfgEntry').value = c.fvgEntryMode;
  $('cfgDisp').value = c.displacementAtr;
}

$('saveConfig').addEventListener('click', async () => {
  await api('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
    symbol:$('cfgSymbol').value.trim() || 'XAUUSD',
    timeframe:$('cfgTf').value.trim() || 'M3',
    pipSize:Number($('cfgPip').value),
    maxSwingSlPips:Number($('cfgMaxSl').value),
    fvgEntryMode:$('cfgEntry').value,
    displacementAtr:Number($('cfgDisp').value),
  })});
  await load();
});

loadConfig();
load();
setInterval(load, 3000);
