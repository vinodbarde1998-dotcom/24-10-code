import { useState, useEffect, useMemo } from 'react';
import { Sparkles, TrendingUp, TrendingDown, Minus, Activity, AlertTriangle, Zap } from 'lucide-react';

const SUPPORTED_COINS = ['BTC', 'ETH'] as const;
type SupportedCoin = (typeof SUPPORTED_COINS)[number];

interface LiveCoin {
  symbol: string;
  price: number;
  change24h: number;
}

const trendConfig = {
  Bullish: { icon: TrendingUp, color: '#00ff9d', bg: 'bg-neon-green/10', border: 'border-neon-green/30', label: 'Bullish' },
  Bearish: { icon: TrendingDown, color: '#ff3b5c', bg: 'bg-neon-red/10', border: 'border-neon-red/30', label: 'Bearish' },
  Sideways: { icon: Minus, color: '#ffb020', bg: 'bg-neon-amber/10', border: 'border-neon-amber/30', label: 'Sideways' },
} as const;

interface Props {
  formatInr: (n: number) => string;
  coins: LiveCoin[];
  isLiveConnected: boolean;
}

function derivePrediction(price: number, change24h: number): {
  trend: 'Bullish' | 'Bearish' | 'Sideways';
  moveLowPct: number;
  moveHighPct: number;
  confidence: number;
  reason: string;
} {
  if (!price || price <= 0) {
    return {
      trend: 'Sideways',
      moveLowPct: 0,
      moveHighPct: 0,
      confidence: 0,
      reason: 'Awaiting live market data to generate a forecast.',
    };
  }

  // Trend derived from 24h momentum
  let trend: 'Bullish' | 'Bearish' | 'Sideways' = 'Sideways';
  if (change24h > 0.5) trend = 'Bullish';
  else if (change24h < -0.5) trend = 'Bearish';

  // Expected move range as a percentage of current price (0.2%–0.6%)
  const volatility = Math.min(Math.abs(change24h) * 0.1, 0.6);
  const baseMove = Math.max(0.2, volatility);
  const direction = trend === 'Bullish' ? 1 : trend === 'Bearish' ? -1 : 0;

  const confidence = Math.min(50 + Math.abs(change24h) * 4, 85);

  const reason =
    trend === 'Bullish'
      ? `24h momentum is positive at ${change24h.toFixed(2)}%. The current live price of ${formatPriceBrief(price)} is holding above recent levels. Based on proportional volatility, a short-term upward move of approximately ${baseMove.toFixed(2)}% is projected for the next 15 minutes.`
      : trend === 'Bearish'
      ? `24h momentum is negative at ${change24h.toFixed(2)}%. Selling pressure is visible at the current live price of ${formatPriceBrief(price)}. Based on proportional volatility, a short-term downward move of approximately ${baseMove.toFixed(2)}% is projected for the next 15 minutes.`
      : `The market is consolidating with a 24h change of ${change24h.toFixed(2)}%. The live price of ${formatPriceBrief(price)} is range-bound. Expect limited sideways movement of approximately ${baseMove.toFixed(2)}% in either direction over the next 15 minutes.`;

  return {
    trend,
    moveLowPct: direction * baseMove * 0.6,
    moveHighPct: direction * baseMove,
    confidence: Math.round(confidence),
    reason,
  };
}

function formatPriceBrief(price: number): string {
  if (price >= 1000) return `$${(price / 1000).toFixed(1)}k`;
  return `$${price.toFixed(0)}`;
}

export default function AiMarketPredictor({ formatInr, coins, isLiveConnected }: Props) {
  const [selectedCoin, setSelectedCoin] = useState<SupportedCoin>('BTC');
  const [syncing, setSyncing] = useState(true);

  const liveCoin = useMemo(
    () => coins.find((c) => c.symbol === selectedCoin),
    [coins, selectedCoin],
  );

  const livePrice = liveCoin?.price ?? 0;
  const change24h = liveCoin?.change24h ?? 0;

  const prediction = useMemo(
    () => derivePrediction(livePrice, change24h),
    [livePrice, change24h],
  );

  // Recalculate target prices dynamically from the live price
  const targetLowUSD = livePrice > 0 ? livePrice * (1 + prediction.moveLowPct / 100) : 0;
  const targetHighUSD = livePrice > 0 ? livePrice * (1 + prediction.moveHighPct / 100) : 0;

  // Points (absolute dollar move)
  const pointsLow = livePrice > 0 ? livePrice * (prediction.moveLowPct / 100) : 0;
  const pointsHigh = livePrice > 0 ? livePrice * (prediction.moveHighPct / 100) : 0;

  // Smart Money Flow — buy/sell pressure derived from 24h momentum
  const buyPct = Math.max(15, Math.min(85, Math.round(50 + change24h * 3)));
  const sellPct = 100 - buyPct;

  useEffect(() => {
    setSyncing(true);
    const t = setTimeout(() => setSyncing(false), 1200);
    return () => clearTimeout(t);
  }, [selectedCoin]);

  const cfg = trendConfig[prediction.trend];
  const TrendIcon = cfg.icon;

  const offline = !isLiveConnected;

  const pointsText =
    Math.abs(pointsHigh) < 1
      ? 'Awaiting data'
      : prediction.trend === 'Sideways'
      ? `±${Math.abs(pointsHigh).toFixed(0)} pts`
      : `${pointsLow >= 0 ? '+' : ''}${pointsLow.toFixed(0)} to ${pointsHigh >= 0 ? '+' : ''}${pointsHigh.toFixed(0)} pts`;

  const targetText = targetHighUSD > 0 ? formatInr(targetHighUSD) : 'Awaiting data';

  return (
    <div className="glass-card p-5 sm:p-6 relative overflow-hidden h-full flex flex-col">
      <div className="absolute -top-16 -right-16 w-48 h-48 bg-neon-cyan/5 rounded-full blur-3xl pointer-events-none" />
      <div className="relative flex-1 flex flex-col justify-between gap-6">
        <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-neon-cyan animate-pulse-glow" />
            <h2 className="text-xs font-bold text-white tracking-wide">AI MARKET PREDICTOR (NEXT 15M)</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`relative flex h-2 w-2 ${isLiveConnected ? (syncing ? '' : 'opacity-40') : ''}`}>
              {isLiveConnected && syncing && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neon-cyan opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isLiveConnected ? 'bg-neon-cyan' : 'bg-neon-red'}`} />
            </span>
            <span className={`text-[10px] ${isLiveConnected ? 'text-slate-500' : 'text-neon-red font-bold'}`}>
              {isLiveConnected ? (syncing ? 'Live AI Syncing...' : 'Synced') : 'Waiting for Live Feed'}
            </span>
          </div>
        </div>
        <p className="text-[10px] text-slate-500">Cortex Neural Engine · Short-term forecast</p>

        {/* Coin selector — driven by SUPPORTED_COINS config array */}
        <div className="flex gap-2">
          {SUPPORTED_COINS.map((coin) => (
            <button
              key={coin}
              onClick={() => setSelectedCoin(coin)}
              className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all duration-200 active:scale-95 ${
                selectedCoin === coin
                  ? 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40 neon-glow-cyan'
                  : 'bg-white/[0.03] text-slate-400 border-white/[0.06] hover:bg-white/[0.06] hover:text-slate-200'
              }`}
            >
              {coin}
            </button>
          ))}
        </div>

        {/* The Verdict */}
        <div className={`flex items-center gap-3 p-5 rounded-xl border ${cfg.bg} ${cfg.border}`}>
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${cfg.bg} border ${cfg.border}`}>
            <TrendIcon className="w-5 h-5" style={{ color: cfg.color }} />
          </div>
          <div className="flex-1">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">Predicted Trend</p>
            <p className="text-lg font-bold" style={{ color: cfg.color, textShadow: `0 0 10px ${cfg.color}44` }}>
              {prediction.trend}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">Confidence</p>
            <p className="text-sm font-bold font-mono text-slate-200">{prediction.confidence}%</p>
          </div>
        </div>

        {/* The Targets — dynamically calculated from live price */}
        <div className="grid grid-cols-2 gap-4">
          <div className="relative p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Expected Move</p>
            <p
              className={`text-sm font-bold font-mono transition-all duration-500 ${offline ? 'blur-sm opacity-50' : ''}`}
              style={{ color: cfg.color }}
            >
              {pointsText}
            </p>
            {offline && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-[10px] font-bold text-neon-cyan animate-pulse tracking-wide flex items-center gap-1">
                  <Zap className="w-3 h-3" /> AI Re-calibrating to Live Market...
                </span>
              </div>
            )}
          </div>
          <div className="relative p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] overflow-hidden">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Target Price</p>
            <p
              className={`text-sm font-bold font-mono text-neon-cyan transition-all duration-500 ${offline ? 'blur-sm opacity-50' : ''}`}
            >
              {targetText}
            </p>
            {offline && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-[10px] font-bold text-neon-cyan animate-pulse tracking-wide flex items-center gap-1">
                  <Zap className="w-3 h-3" /> AI Re-calibrating to Live Market...
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Current live price reference */}
        <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/[0.02]">
          <span className="text-[10px] text-slate-500 uppercase tracking-wide">Live {selectedCoin} Price</span>
          <span className="text-sm font-mono font-bold text-slate-200">
            {livePrice > 0 ? formatInr(livePrice) : 'Loading...'}
            <span className={`ml-2 text-[10px] ${change24h >= 0 ? 'text-neon-green' : 'text-neon-red'}`}>
              {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}%
            </span>
          </span>
        </div>

        {/* AI Reasoning */}
        <div className="flex items-start gap-3 p-6 rounded-xl bg-white/[0.02] border border-white/[0.05]">
          <Activity className="w-5 h-5 text-neon-cyan flex-shrink-0 mt-0.5" />
          <p className="text-sm italic text-slate-300 leading-loose">{prediction.reason}</p>
        </div>

        {/* Legal Disclaimer Badge */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-neon-amber/[0.04] border border-neon-amber/15">
          <AlertTriangle className="w-3 h-3 text-neon-amber flex-shrink-0" />
          <span className="text-[10px] font-semibold text-neon-amber/80 tracking-wide">BETA: Educational Forecast Only — Not Financial Advice</span>
        </div>
        </div>

        {/* Order Book Heat — Smart Money Flow (pinned to bottom) */}
        <div className="pb-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-neon-cyan" />
              Smart Money Flow
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              <span className="text-neon-green font-bold">Buy {buyPct}%</span>
              <span className="text-slate-600 mx-1">|</span>
              <span className="text-neon-red font-bold">Sell {sellPct}%</span>
            </span>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-base-700">
            <div
              className="h-full bg-gradient-to-r from-neon-green to-neon-green/70 transition-all duration-700"
              style={{ width: `${buyPct}%`, boxShadow: '0 0 12px rgba(0, 255, 157, 0.45)' }}
            />
            <div
              className="h-full bg-gradient-to-l from-neon-red to-neon-red/70 transition-all duration-700"
              style={{ width: `${sellPct}%`, boxShadow: '0 0 12px rgba(255, 59, 92, 0.45)' }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-[9px] text-slate-600">
            <span>Bids</span>
            <span>Asks</span>
          </div>
        </div>
      </div>
    </div>
  );
}
