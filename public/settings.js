const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const r = await fetch(path, options);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function setHealth(ok) {
  $('health').textContent = ok ? 'ONLINE' : 'OFFLINE';
  $('health').className = ok ? 'pill ok' : 'pill';
}

function notice(text, ok = true) {
  const el = $('saveNotice');
  el.textContent = text;
  el.className = 'save-notice show ' + (ok ? 'ok' : 'bad');
  clearTimeout(window.__noticeTimer);
  window.__noticeTimer = setTimeout(() => { el.className = 'save-notice'; }, 2600);
}

async function loadConfig() {
  try {
    const payload = await api('/api/config');
    const c = payload.shared || payload;
    $('cfgSymbol').value = c.symbol || 'XAUUSD';
    $('cfgPip').value = c.pipSize ?? 0.1;
    $('cfgMaxSl').value = c.maxSwingSlPips ?? 50;
    $('cfgSlBuffer').value = c.slBufferPips ?? 5;
    $('cfgEntry').value = c.fvgEntryMode || 'first_touch';
    $('cfgDisp').value = c.displacementAtr ?? 1.5;
    $('cfgAtr').value = c.atrPeriod ?? 14;
    $('cfgObFvgBars').value = c.maxObFvgBars ?? 6;
    $('cfgFreshAge').value = c.maxFreshAgeBars ?? 300;
    $('cfgExpiry').value = c.setupExpiryBars ?? 100;
    setHealth(true);
  } catch (e) {
    setHealth(false);
    console.error(e);
  }
}

$('saveConfig').addEventListener('click', async () => {
  const button = $('saveConfig');
  button.disabled = true;
  button.textContent = 'Menyimpan...';
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: $('cfgSymbol').value.trim() || 'XAUUSD',
        pipSize: Number($('cfgPip').value),
        maxSwingSlPips: Number($('cfgMaxSl').value),
        slBufferPips: Number($('cfgSlBuffer').value),
        fvgEntryMode: $('cfgEntry').value,
        displacementAtr: Number($('cfgDisp').value),
        atrPeriod: Number($('cfgAtr').value),
        maxObFvgBars: Number($('cfgObFvgBars').value),
        maxFreshAgeBars: Number($('cfgFreshAge').value),
        setupExpiryBars: Number($('cfgExpiry').value)
      })
    });
    notice('Strategy settings berhasil disimpan.', true);
    await loadConfig();
  } catch (e) {
    notice('Gagal menyimpan strategy settings.', false);
    console.error(e);
  } finally {
    button.disabled = false;
    button.textContent = 'Simpan Perubahan';
  }
});

loadConfig();
