# AI Trading OB + FVG

Web trading engine XAUUSD untuk scalping **M1 / M3 / M5** berdasarkan Fresh Order Block + Fresh FVG.

## Strategi utama

- Entry utama: FVG (`first_touch`, `top`, `mid`, atau `bottom`).
- Order Block dipakai sebagai konteks setup dan sumber structural stop.
- SL: swing high / swing low Order Block.
- Maksimum Swing SL: **50 pips**. Jika lebih jauh, setup **SKIP** — bukan dipotong menjadi fixed SL.
- TP1/TP2/TP3/TP4: **1R / 2R / 3R / 4R**.
- Setup belum menyentuh Entry tidak masuk total trade, historical, WIN, atau LOSS.
- TP1 tersentuh setelah Entry = **WIN** untuk winrate utama.
- SL sebelum TP1 setelah Entry = **LOSS**.
- M1, M3, dan M5 memiliki winrate dan historical masing-masing.

## Live website

`https://ai-trading-ob-fvg-mtf-production.up.railway.app`

## MT5 Bridge

File EA:

`mt5/AI_Trading_OB_FVG_Bridge.mq5`

Bridge cukup mengirim candle **M1**. Server otomatis membentuk candle M3 dan M5, sehingga ketiga engine berjalan dari sumber yang sama.

### Instalasi MT5

1. MT5 → **File → Open Data Folder**.
2. Buka `MQL5/Experts`.
3. Copy `AI_Trading_OB_FVG_Bridge.mq5` ke folder tersebut.
4. Buka MetaEditor, compile file EA.
5. MT5 → **Tools → Options → Expert Advisors**.
6. Centang **Allow WebRequest for listed URL**.
7. Tambahkan:
   `https://ai-trading-ob-fvg-mtf-production.up.railway.app`
8. Pasang EA pada chart apa pun.
9. Isi `BridgeSymbol` sesuai nama XAUUSD di broker (`XAUUSD`, `XAUUSDm`, dll).
10. Isi `BridgeToken` dengan token private yang ada di Railway service.

Pada startup bridge akan mengirim backfill M1 tanpa Telegram historical spam. Setelah itu bridge mengirim:

- live Bid/Ask setiap beberapa detik ke `/api/mt5/tick`
- candle M1 yang baru selesai ke `/api/mt5/webhook`
- historical M1 awal ke `/api/mt5/backfill`

## Telegram

Server mendukung notifikasi Telegram untuk:

- Entry BUY/SELL yang benar-benar tersentuh
- TP1 / TP2 / TP3 / TP4
- SL
- Pending setup opsional (`TELEGRAM_NOTIFY_PENDING=true`)

Environment variables Railway:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_NOTIFY_PENDING=false`

Test endpoint:

`POST /api/telegram/test`

Endpoint MT5/Telegram test dilindungi header `X-Bridge-Token`.

## API utama

- `GET /api/health`
- `GET /api/status`
- `GET /api/integrations`
- `GET /api/config`
- `POST /api/config`
- `POST /api/candle`
- `POST /api/candles`
- `POST /api/mt5/backfill`
- `POST /api/mt5/tick`
- `POST /api/mt5/webhook`
- `POST /api/telegram/test`
- `GET /api/signals`

## Menjalankan lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## Catatan persistence

Historical dan candle engine saat ini masih berada di memory service. Backfill MT5 mengisi ulang data pada saat EA dijalankan. PostgreSQL persistence dapat ditambahkan pada tahap berikutnya agar data tetap ada setelah restart/deploy Railway.
