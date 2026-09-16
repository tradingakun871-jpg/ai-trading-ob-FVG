const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function main() {
  if (!token || !chatId) {
    console.log('TG_DIAG', JSON.stringify({ ok:false, reason:'missing_config' }));
    return;
  }

  const base = `https://api.telegram.org/bot${token}`;

  const getMeRes = await fetch(`${base}/getMe`);
  const getMe = await getMeRes.json().catch(() => ({}));
  console.log('TG_GETME', JSON.stringify({
    http:getMeRes.status,
    ok:Boolean(getMe.ok),
    error_code:getMe.error_code ?? null,
    description:getMe.description ?? null
  }));

  const sendRes = await fetch(`${base}/sendMessage`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({
      chat_id:chatId,
      text:'✅ TEST AI Trading OB+FVG\nTelegram diagnostic test dari Railway.'
    })
  });
  const send = await sendRes.json().catch(() => ({}));
  console.log('TG_SEND', JSON.stringify({
    http:sendRes.status,
    ok:Boolean(send.ok),
    error_code:send.error_code ?? null,
    description:send.description ?? null,
    message_id:send.result?.message_id ?? null,
    chat_type:send.result?.chat?.type ?? null
  }));
}

main().catch((e) => {
  console.log('TG_DIAG', JSON.stringify({ ok:false, reason:e.message }));
});
