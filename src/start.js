const runTelegramTest = String(process.env.TELEGRAM_TEST_ON_BOOT || 'false').toLowerCase() === 'true';

async function telegramBootTest() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!runTelegramTest) return;
  if (!token || !chatId) {
    console.log('TELEGRAM_BOOT_TEST', JSON.stringify({ ok:false, reason:'missing_config' }));
    return;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({
        chat_id:chatId,
        text:'✅ TEST AI Trading OB+FVG\nTelegram test langsung dari Railway berhasil dijalankan.'
      })
    });
    const body = await r.json().catch(() => ({}));
    console.log('TELEGRAM_BOOT_TEST', JSON.stringify({
      http:r.status,
      ok:Boolean(body.ok),
      error_code:body.error_code ?? null,
      description:body.description ?? null,
      message_id:body.result?.message_id ?? null,
      chat_type:body.result?.chat?.type ?? null
    }));
  } catch (e) {
    console.log('TELEGRAM_BOOT_TEST', JSON.stringify({ ok:false, reason:e.message }));
  }
}

await telegramBootTest();
await import('./server.js');
