#property strict
#property version   "2.30"
#property description "AI Trading OB+FVG MTF Bridge V2.3 - FIRST_TOUCH_LIMIT + DXY SHADOW"
#include <Trade/Trade.mqh>
// Full production bridge is distributed from the dashboard/conversation artifact.
// This repository marker documents the live DXY contract:
// POST /api/mt5/dxy-candle with X-Bridge-Token and M1 candle(s).
// DXY is SHADOW only and never blocks M1/M3 OB+FVG FIRST_TOUCH entries.
