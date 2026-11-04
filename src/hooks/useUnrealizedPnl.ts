import { useMemo } from 'react';
import { useLivePrices } from '@/hooks/useLivePrices';
import type { Trade } from '@/lib/supabase';

/**
 * useUnrealizedPnl — calculates live unrealized PnL for open trades
 * using real-time Binance prices via the useLivePrices WebSocket hook.
 *
 * LONG:  (livePrice - entryPrice) * quantity * leverage
 * SHORT: (entryPrice - livePrice) * quantity * leverage
 *
 * No fake data — if no live price is available for a coin, PnL is 0.
 */
export function useUnrealizedPnl(trades: Trade[]) {
  const { coins } = useLivePrices();

  const priceMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of coins) {
      map.set(c.symbol.toUpperCase(), c.price);
    }
    return map;
  }, [coins]);

  const unrealizedPnlMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trades) {
      if (t.status !== 'open') {
        map.set(t.id, 0);
        continue;
      }
      const livePrice = priceMap.get(t.coin.toUpperCase());
      if (!livePrice || livePrice <= 0) {
        map.set(t.id, 0);
        continue;
      }
      const entry = Number(t.entry_price);
      const qty = Number(t.quantity);
      const lev = Number(t.leverage) || 1;
      const pnl =
        t.direction === 'long'
          ? (livePrice - entry) * qty * lev
          : (entry - livePrice) * qty * lev;
      map.set(t.id, pnl);
    }
    return map;
  }, [trades, priceMap]);

  const totalUnrealized = useMemo(() => {
    let sum = 0;
    for (const t of trades) {
      if (t.status === 'open') {
        sum += unrealizedPnlMap.get(t.id) ?? 0;
      }
    }
    return sum;
  }, [trades, unrealizedPnlMap]);

  return {
    unrealizedPnlMap,
    totalUnrealized,
    livePrices: priceMap,
  };
}
