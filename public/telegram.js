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
    $('tgDetail').textContent = ready
      ? 'Bot token dan Chat ID terdeteksi. ENTRY / TP / SL siap dikirim.'
      : 'TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum terpasang di Railway.';
    $('pendingStatus').textContent = tg.notifyPending ? 'ON' : 'OFF';
    $('telegramBadge').innerHTML = `<span>${ready ? 'READY' : 'SETUP'}</span>`;
    setHealth(true);
  } catch (e) {
    setHealth(false);
    $('tgStatus').textContent = 'ERROR';
    $('tgDetail').textContent = e.message;
  }
}

$('testTelegram').addEventListener('click', async () => {
  const token = $('bridgeToken').value.trim();
  const message = $('testMessage').value.trim();
  const result = $('testResult');
  if (!token) {
    result.textContent = 'Bridge Token wajib diisi untuk test.';
    return;
  }
  const button = $('testTelegram');
  button.disabled = true;
  button.textContent = 'Mengirim...';
  try {
    await api('/api/telegram/test', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'X-Bridge-Token':token
      },
      body:JSON.stringify({ message: message || '✅ AI Trading OB+FVG Telegram test berhasil.' })
    });
    result.textContent = 'Test berhasil dikirim ke Telegram.';
  } catch (e) {
    result.textContent = `Test gagal: ${e.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Kirim Test';
  }
});

loadStatus();
setInterval(loadStatus, 5000);
