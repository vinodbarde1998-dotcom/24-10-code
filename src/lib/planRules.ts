export type PlanType = 'starter' | 'pro' | 'enterprise';

export interface PlanRule {
  label: string;
  creditsPerDay: number;
  botLimit: number | null;
  maxLeverage: number;
  features: string[];
  aiAutoTune: boolean;
  unlockedStrategiesCount: number;
  allowedStrategyIds: string[];
}

export const PLAN_RULES: Record<PlanType, PlanRule> = {
  starter: {
    label: 'Starter',
    creditsPerDay: 2,
    botLimit: 2,
    maxLeverage: 10,
    features: ['2 AI Bots', '10x Max', 'Spot', 'Email Support', 'Basic Signals', '2 AI Strategies'],
    aiAutoTune: false,
    unlockedStrategiesCount: 2,
    allowedStrategyIds: ['sideways_sniper', 'smart_dca'],
  },
  pro: {
    label: 'Pro',
    creditsPerDay: 4,
    botLimit: 5,
    maxLeverage: 30,
    features: ['5 AI Bots', '30x Max', 'Spot & Futures', 'Priority Support', 'Advanced Signals', 'Copy Trading', 'Custom Strategies', '4 AI Strategies'],
    aiAutoTune: true,
    unlockedStrategiesCount: 4,
    allowedStrategyIds: ['sideways_sniper', 'smart_dca', 'infinity_grid', 'bull_scalper'],
  },
  enterprise: {
    label: 'Enterprise',
    creditsPerDay: 6,
    botLimit: null,
    maxLeverage: 100,
    features: ['Unlimited Bots', '100x Max', 'Unlimited Markets', 'Dedicated Manager', 'API Access', 'Custom Risk Rules', 'Priority Features', 'All 10 AI Strategies'],
    aiAutoTune: true,
    unlockedStrategiesCount: 10,
    allowedStrategyIds: [
      'sideways_sniper', 'smart_dca', 'infinity_grid', 'bull_scalper',
      'smart_martingale', 'whale_copier', 'smc_institutional',
      'funding_arbitrage', 'volatility_breakout', 'quantum_hft',
    ],
  },
};

export function normalizePlan(value: string | null | undefined): PlanType {
  const plan = value?.toLowerCase();
  return plan === 'pro' || plan === 'enterprise' ? plan : 'starter';
}

export function isStrategyUnlocked(planName: PlanType, strategyId: string, strategies?: import('@/lib/strategyCatalog').StrategyEntry[]): boolean {
  const list = strategies ?? [];
  const strategy = list.find(s => s.id === strategyId);
  if (!strategy) {
    return PLAN_RULES[planName].allowedStrategyIds.includes(strategyId);
  }
  const TIER_RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 };
  const PLAN_RANK: Record<PlanType, number> = { starter: 0, pro: 1, enterprise: 2 };
  return PLAN_RANK[planName] >= TIER_RANK[strategy.tier];
}

export function getPlanStrategySummary(planName: PlanType): string {
  const unlocked = PLAN_RULES[planName].unlockedStrategiesCount;
  const locked = 10 - unlocked;
  return `${unlocked} Unlocked | ${locked} Locked`;
}
