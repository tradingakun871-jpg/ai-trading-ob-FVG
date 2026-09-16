const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const r = await fetch(path, options);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error:text }; }
  if (!r.ok) throw new Error(data.error || text || `HTTP ${r.status}`);
  return data;
}

function setHealth(ok) {
  $('health').textContent = ok ? 'ONLINE' : 'OFFLINE';
  $('health').className = ok ? 'pill ok' : 'pill';
}

async function loadStatus() {
  try {
    const integrations = await api('/api/integrations');
    const tg = integrations.telegram || {};
    const ready = Boolean(tg.configured);
    $('tgStatus').textContent = ready ? 'READY' : 'NOT CONFIGURED';
    $('tgStatus').className = ready ? 'status-ok' : 'status-warn';
    $('tgDetail').textContent = ready ? 'Private Chat ID dan bot sudah tersimpan. ENTRY / TP / SL siap dikirim.' : 'Telegram belum dikonfigurasi di Railway.';
    $('pendingStatus').textContent = tg.notifyPending ? 'ON' : 'OFF';
    $('telegramBadge').innerHTML = `<span>${ready ? 'PRIVATE READY' : 'SETUP'}</span>`;
    setHealth(true);
  } catch (e) {
    setHealth(false);
    $('tgStatus').textContent = 'ERROR';
    $('tgDetail').textContent = e.message;
  }
}

$('testTelegram').addEventListener('click', async () => {
  const message = $('testMessage').value.trim();
  const result = $('testResult');
  const button = $('testTelegram');
  button.disabled = true;
  button.textContent = 'Mengirim...';
  result.textContent = 'Mengirim test ke private Telegram...';
  try {
    const response = await fetch('/api/telegram/test-ui', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ message:message || '✅ AI Trading OB+FVG Telegram privat test berhasil.' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    result.textContent = 'Test berhasil dikirim ke private Telegram.';
  } catch (e) {
    result.textContent = `Test gagal: ${e.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Kirim Test';
  }
});

loadStatus();
setInterval(loadStatus, 5000);
