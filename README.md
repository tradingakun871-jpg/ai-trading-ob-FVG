# AI Trading OB + FVG

Web trading engine baru untuk XAUUSD yang menerapkan logika hasil pengujian indikator V9.5.

## Strategi utama

- Method 1: Fresh Order Block + Fresh FVG.
- Entry utama: FVG (`first_touch`, `top`, `mid`, atau `bottom`).
- Order Block dipakai sebagai konteks setup dan sumber structural stop.
- SL: swing high / swing low Order Block.
- Maksimum Swing SL: **50 pips**. Jika lebih jauh, setup **SKIP** — bukan dipotong menjadi fixed SL.
- TP1/TP2/TP3/TP4: **1R / 2R / 3R / 4R**.
- Fresh OB/FVG dihapus dari status fresh setelah mitigasi / first touch.
- Dashboard menampilkan fresh OB, fresh FVG, pending setup, live trade, historical entry, skipped setup, dan winrate TP1-TP4.

## Menjalankan lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## API utama

- `GET /api/health`
- `GET /api/status`
- `GET /api/config`
- `POST /api/config`
- `POST /api/candle`
- `POST /api/candles`
- `POST /api/mt5/webhook`
- `GET /api/signals`

Contoh candle:

```json
{
  "symbol": "XAUUSD",
  "timeframe": "M3",
  "candle": {
    "time": 1789545600000,
    "open": 4300.1,
    "high": 4303.5,
    "low": 4298.2,
    "close": 4302.9,
    "volume": 1200
  }
}
```

## Railway

Repository sudah dilengkapi `Dockerfile` dan `railway.json`. Hubungkan repository ini ke Railway lalu deploy. Railway akan menggunakan `/api/health` sebagai health check.

## Tahap berikutnya

1. MT5 Bridge mengirim candle close ke `/api/mt5/webhook`.
2. Tambah persistence PostgreSQL agar historical tidak hilang saat restart.
3. Telegram signal untuk setup PENDING / ENTRY / TP / SL.
4. Auto-trade bridge MT5 terpisah dengan kontrol risk dan enable/disable.
5. Data live Twelve Data sebagai fallback / monitoring dashboard.
