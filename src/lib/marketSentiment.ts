import type { LiveCoin } from '@/hooks/useLivePrices';

export interface MarketSentiment {
  fearGreedIndex: number;
  fearGreedLabel: string;
  fearGreedColor: string;
  bullishPercent: number;
  volatility: 'Low' | 'Moderate' | 'High' | 'Extreme';
  advancing: number;
  declining: number;
  topGainer: LiveCoin | null;
  topLoser: LiveCoin | null;
  avgChange: number;
  summary: string;
  recommendation: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function computeMarketSentiment(coins: LiveCoin[]): MarketSentiment {
  if (coins.length === 0) {
    return {
      fearGreedIndex: 50,
      fearGreedLabel: 'Neutral',
      fearGreedColor: '#00e5ff',
      bullishPercent: 50,
      volatility: 'Moderate',
      advancing: 0,
      declining: 0,
      topGainer: null,
      topLoser: null,
      avgChange: 0,
      summary: 'Awaiting market data...',
      recommendation: 'Standby',
    };
  }

  const advancing = coins.filter((c) => c.change24h > 0).length;
  const declining = coins.filter((c) => c.change24h < 0).length;
  const avgChange = coins.reduce((sum, c) => sum + c.change24h, 0) / coins.length;
  const maxChange = Math.max(...coins.map((c) => Math.abs(c.change24h)));
  const gains = coins.map((c) => c.change24h).sort((a, b) => b - a);
  const topGainer = [...coins].sort((a, b) => b.change24h - a.change24h)[0] ?? null;
  const topLoser = [...coins].sort((a, b) => a.change24h - b.change24h)[0] ?? null;

  // Fear & Greed: blend breadth (advancing vs declining) and magnitude (avg change)
  const breadthScore = clamp(((advancing - declining) / coins.length) * 50 + 50, 0, 100);
  const momentumScore = clamp(50 + avgChange * 6, 0, 100);
  const fearGreedIndex = Math.round(breadthScore * 0.45 + momentumScore * 0.55);

  let fearGreedLabel: string;
  let fearGreedColor: string;
  if (fearGreedIndex < 25) {
    fearGreedLabel = 'Extreme Fear';
    fearGreedColor = '#ff3b5c';
  } else if (fearGreedIndex < 45) {
    fearGreedLabel = 'Fear';
    fearGreedColor = '#ffb020';
  } else if (fearGreedIndex < 55) {
    fearGreedLabel = 'Neutral';
    fearGreedColor = '#00e5ff';
  } else if (fearGreedIndex < 75) {
    fearGreedLabel = 'Greed';
    fearGreedColor = '#00ff9d';
  } else {
    fearGreedLabel = 'Extreme Greed';
    fearGreedColor = '#00ff9d';
  }

  // Volatility from max absolute change
  let volatility: MarketSentiment['volatility'];
  if (maxChange < 3) volatility = 'Low';
  else if (maxChange < 7) volatility = 'Moderate';
  else if (maxChange < 12) volatility = 'High';
  else volatility = 'Extreme';

  // Bullish percent: proportion of coins up weighted by avg change
  const bullishPercent = clamp(Math.round((advancing / coins.length) * 70 + avgChange * 3), 0, 100);

  // Dynamic AI summary text
  const direction = avgChange >= 0 ? 'bullish' : 'bearish';
  const momentum = avgChange >= 0 ? 'accumulating' : 'distributing';
  const topGainerText = topGainer ? `${topGainer.symbol} (+${topGainer.change24h.toFixed(1)}%)` : 'N/A';
  const topLoserText = topLoser ? `${topLoser.symbol} (${topLoser.change24h.toFixed(1)}%)` : 'N/A';

  const summary = `Market is ${direction} with ${advancing}/${coins.length} coins advancing. Top gainer: ${topGainerText}. Top laggard: ${topLoserText}. Volatility is ${volatility.toLowerCase()}. Smart Money appears to be ${momentum} key assets.`;

  let recommendation: string;
  if (fearGreedIndex < 25) {
    recommendation = 'DCA accumulation zone — fear creates buying opportunities for spot positions';
  } else if (fearGreedIndex < 45) {
    recommendation = 'Selective DCA entries — watch for reversal confirmations before scaling in';
  } else if (fearGreedIndex < 55) {
    recommendation = 'Balanced approach — maintain existing positions, wait for clearer direction';
  } else if (fearGreedIndex < 75) {
    recommendation = 'DCA accumulation favorable — caution on high-leverage futures due to volatility';
  } else {
    recommendation = 'Take partial profits — extreme greed increases reversal risk, trim leverage';
  }

  return {
    fearGreedIndex,
    fearGreedLabel,
    fearGreedColor,
    bullishPercent,
    volatility,
    advancing,
    declining,
    topGainer,
    topLoser,
    avgChange,
    summary,
    recommendation,
  };
}
