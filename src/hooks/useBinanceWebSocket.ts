import { useState, useEffect, useRef, useCallback } from 'react';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  quoteVolume24h: number;
}

const WS_BASE = 'wss://stream.binance.com:9443/ws';

/**
 * Fetches historical candlestick data from Binance's free REST API (no API key needed).
 * Endpoint: api.binance.com/api/v3/klines
 */
export async function fetchKlines(symbol: string, interval: string = '15m', limit: number = 200): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines API ${res.status}`);
  const raw: unknown[][] = await res.json();
  return raw.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

/**
 * Connects to Binance's public WebSocket for real-time candlestick updates.
 * Stream: <symbol>@kline_<interval>
 * Zero cost, no API key, no rate limits.
 */
export function useBinanceKlineStream(symbol: string | null, interval: string = '15m') {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const candleMapRef = useRef<Map<number, Candle>>(new Map());

  useEffect(() => {
    if (!symbol) return;
    let mounted = true;
    setLoading(true);
    candleMapRef.current.clear();

    // 1. Fetch historical candles for immediate display
    fetchKlines(symbol, interval, 200)
      .then((history) => {
        if (!mounted) return;
        const map = new Map<number, Candle>();
        for (const c of history) map.set(c.time, c);
        candleMapRef.current = map;
        setCandles(history);
        setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });

    // 2. Connect WebSocket for live updates
    const streamSymbol = symbol.toLowerCase();
    const wsUrl = `${WS_BASE}/${streamSymbol}@kline_${interval}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (!mounted) return;
      try {
        const msg = JSON.parse(event.data);
        const k = msg.k;
        if (!k) return;

        const candle: Candle = {
          time: Math.floor(k.t / 1000),
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
        };

        candleMapRef.current.set(candle.time, candle);
        setCandles(Array.from(candleMapRef.current.values()).sort((a, b) => a.time - b.time));
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      ws?.close();
    };

    return () => {
      mounted = false;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [symbol, interval]);

  return { candles, loading };
}

/**
 * Subscribes to real-time ticker updates for a set of symbols via Binance WebSocket.
 * Zero cost, no API key. Uses the combined stream endpoint for multiple symbols.
 */
export function useBinanceTickerStream(symbols: string[]) {
  const [tickers, setTickers] = useState<Map<string, TickerData>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);

  const subscribe = useCallback((syms: string[]) => {
    if (syms.length === 0) return;
    const streams = syms.map((s) => `${s.toLowerCase()}@ticker`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const d = msg.data;
        if (!d || !d.s) return;
        const symbol = d.s as string;
        setTickers((prev) => {
          const next = new Map(prev);
          next.set(symbol, {
            symbol,
            price: parseFloat(d.c) || 0,
            change24h: parseFloat(d.P) || 0,
            high24h: parseFloat(d.h) || 0,
            low24h: parseFloat(d.l) || 0,
            volume24h: parseFloat(d.v) || 0,
            quoteVolume24h: parseFloat(d.q) || 0,
          });
          return next;
        });
      } catch {
        // ignore
      }
    };

    ws.onerror = () => ws?.close();
  }, []);

  useEffect(() => {
    if (symbols.length === 0) return;
    let mounted = true;

    // Initial REST fetch for immediate data
    (async () => {
      try {
        const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`);
        if (!res.ok) return;
        const raw: Record<string, string>[] = await res.json();
        if (!mounted || !Array.isArray(raw)) return;
        const map = new Map<string, TickerData>();
        for (const t of raw) {
          map.set(t.symbol, {
            symbol: t.symbol,
            price: parseFloat(t.lastPrice) || 0,
            change24h: parseFloat(t.priceChangePercent) || 0,
            high24h: parseFloat(t.highPrice) || 0,
            low24h: parseFloat(t.lowPrice) || 0,
            volume24h: parseFloat(t.volume) || 0,
            quoteVolume24h: parseFloat(t.quoteVolume) || 0,
          });
        }
        if (mounted) setTickers(map);
      } catch {
        // fallback — websocket will populate
      }
    })();

    subscribe(symbols);

    return () => {
      mounted = false;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [symbols.join(','), subscribe]);

  return tickers;
}
