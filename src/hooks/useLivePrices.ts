import { useState, useEffect, useRef } from 'react';

export interface LiveCoin {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  volume24h: number;
  quoteVolume24h: number;
  high24h: number;
  low24h: number;
  sparkline: number[];
}

const SYMBOLS: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  XRP: 'Ripple',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  DOT: 'Polkadot',
  LINK: 'Chainlink',
  MATIC: 'Polygon',
};

const PAIRS = Object.keys(SYMBOLS).map((s) => `${s}USDT`);

const FALLBACK_PRICES: Record<string, number> = {
  BTC: 67000, ETH: 3400, SOL: 165, BNB: 600, XRP: 0.6,
  ADA: 0.45, AVAX: 38, DOT: 7, LINK: 14.5, MATIC: 0.72,
};

interface BinanceRestTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
}

interface BinanceWsTicker {
  s: string;
  c: string;
  P: string;
  v: string;
  q: string;
  h: string;
  l: string;
}

function parseTicker(raw: BinanceRestTicker): LiveCoin | null {
  const symbol = raw.symbol;
  if (!symbol || !symbol.endsWith('USDT')) return null;
  const base = symbol.slice(0, -4);
  if (!SYMBOLS[base]) return null;
  return {
    symbol: base,
    name: SYMBOLS[base],
    price: parseFloat(raw.lastPrice) || FALLBACK_PRICES[base] || 0,
    change24h: parseFloat(raw.priceChangePercent) || 0,
    volume24h: parseFloat(raw.volume) || 0,
    quoteVolume24h: parseFloat(raw.quoteVolume) || 0,
    high24h: parseFloat(raw.highPrice) || 0,
    low24h: parseFloat(raw.lowPrice) || 0,
    sparkline: [],
  };
}

export function useLivePrices(): { coins: LiveCoin[]; loading: boolean; isLiveConnected: boolean } {
  const [coins, setCoins] = useState<LiveCoin[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const sparklineRef = useRef<Record<string, number[]>>({});

  useEffect(() => {
    let mounted = true;
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const retryTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchRest = async () => {
      try {
        const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(PAIRS))}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance API ${res.status}`);
        const raw: BinanceRestTicker[] = await res.json();
        if (!mounted || !Array.isArray(raw)) return;

        const parsed = raw
          .map(parseTicker)
          .filter((c): c is LiveCoin => c !== null)
          .map((c) => {
            const hist = sparklineRef.current[c.symbol] ?? [];
            hist.push(c.price);
            if (hist.length > 40) hist.shift();
            sparklineRef.current[c.symbol] = hist;
            return { ...c, sparkline: [...hist] };
          });

        if (parsed.length > 0) {
          setCoins(parsed);
          setLoading(false);
        }
      } catch {
        // Fallback: use static prices so UI isn't broken, but mark as offline
        setIsLiveConnected(false);
        if (coins.length === 0) {
          const fallback = Object.entries(SYMBOLS).map(([sym, name]) => ({
            symbol: sym,
            name,
            price: FALLBACK_PRICES[sym] ?? 0,
            change24h: 0,
            volume24h: 0,
            quoteVolume24h: 0,
            high24h: 0,
            low24h: 0,
            sparkline: sparklineRef.current[sym] ?? [],
          }));
          setCoins(fallback);
          setLoading(false);
        }
      }
    };

    const connectWs = () => {
      try {
        ws = new WebSocket('wss://stream.binance.com:9443/ws/!ticker@arr');

        ws.onmessage = (event) => {
          if (!mounted) return;
          try {
            const data: BinanceWsTicker[] = JSON.parse(event.data);
            if (!Array.isArray(data)) return;

            const updated = new Map<string, LiveCoin>();

            for (const t of data) {
              const symbol = t.s as string;
              if (!symbol || !symbol.endsWith('USDT')) continue;
              const base = symbol.slice(0, -4);
              if (!SYMBOLS[base]) continue;

              const price = parseFloat(t.c) || 0;
              const hist = sparklineRef.current[base] ?? [];
              hist.push(price);
              if (hist.length > 40) hist.shift();
              sparklineRef.current[base] = hist;

              updated.set(base, {
                symbol: base,
                name: SYMBOLS[base],
                price,
                change24h: parseFloat(t.P) || 0,
                volume24h: parseFloat(t.v) || 0,
                quoteVolume24h: parseFloat(t.q) || 0,
                high24h: parseFloat(t.h) || 0,
                low24h: parseFloat(t.l) || 0,
                sparkline: [...hist],
              });
            }

            if (updated.size > 0) {
              setCoins((prev) => {
                const map = new Map(prev.map((c) => [c.symbol, c]));
                for (const [sym, coin] of updated) {
                  map.set(sym, coin);
                }
                return Array.from(map.values()).sort(
                  (a, b) => PAIRS.indexOf(a.symbol + 'USDT') - PAIRS.indexOf(b.symbol + 'USDT')
                );
              });
              setIsLiveConnected(true);
              setLoading(false);
            }
          } catch {
            // ignore parse errors
          }
        };

        ws.onerror = () => {
          setIsLiveConnected(false);
          ws?.close();
        };

        ws.onclose = () => {
          if (!mounted) return;
          setIsLiveConnected(false);
          // Fallback to REST polling if WS drops
          fetchRest();
          pollTimer = setInterval(fetchRest, 5000);
        };
      } catch {
        // WS failed, use REST polling
        setIsLiveConnected(false);
        fetchRest();
        pollTimer = setInterval(fetchRest, 5000);
      }
    };

    // Initial REST fetch for immediate data, then connect WS
    fetchRest();
    connectWs();

    return () => {
      mounted = false;
      if (ws) ws.close();
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { coins, loading, isLiveConnected };
}
