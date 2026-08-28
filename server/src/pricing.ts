import type { Identification, MarketEvidence, ValuationResult } from './domain.js';

export type ActiveMarketEstimate = {
  low: number;
  likely: number;
  high: number;
  currency: 'USD';
  confidence: number;
  basis: 'active_listings';
  sampleSize: number;
};

export type MarketQualityPolicy = {
  minimumSampleSize: number;
  minimumAverageMatch: number;
  maximumRangeSpread: number;
  maximumConfidence: number;
};

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) throw new Error('Cannot calculate a percentile without evidence.');
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

function roundToFive(value: number) {
  return Math.round(value / 5) * 5;
}

function marketRound(value: number) {
  const interval = value < 100 ? 1 : value < 1_000 ? 5 : 10;
  return Math.round(value / interval) * interval;
}

function weightedPercentile(entries: Array<{ value: number; weight: number }>, fraction: number) {
  const ordered = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  const target = totalWeight * fraction;
  let cumulative = 0;
  for (const entry of ordered) {
    cumulative += entry.weight;
    if (cumulative >= target) return entry.value;
  }
  return ordered.at(-1)!.value;
}

export function marketQualityPolicy(identity: Identification): MarketQualityPolicy {
  const category = identity.category.toLowerCase();
  const unknownBrand = ['unknown', 'unidentified', 'n/a', 'none'].includes(identity.brand.trim().toLowerCase());
  const nonStandardItem = identity.itemForm !== 'single_item';
  const conditionSensitive = /card|collectible|shoe|sneaker|clothing|apparel|vintage|furniture/.test(category);
  if (unknownBrand || nonStandardItem) {
    return { minimumSampleSize: 5, minimumAverageMatch: 0.78, maximumRangeSpread: 0.55, maximumConfidence: 65 };
  }
  if (conditionSensitive) {
    return { minimumSampleSize: 5, minimumAverageMatch: 0.8, maximumRangeSpread: 0.5, maximumConfidence: 70 };
  }
  return { minimumSampleSize: 3, minimumAverageMatch: 0.75, maximumRangeSpread: 0.65, maximumConfidence: 80 };
}

export function calculateActiveMarketEstimate(identity: Identification, evidence: MarketEvidence[]): ActiveMarketEstimate | null {
  const policy = marketQualityPolicy(identity);
  const eligible = evidence.filter((entry) => entry.kind === 'active' && entry.matchScore >= 70 && typeof entry.price === 'number');
  if (eligible.length < policy.minimumSampleSize) return null;

  const weightedPrices = eligible.map((entry) => ({
    value: entry.price! + (entry.shipping ?? 0),
    // Exact matches should move the center more than merely acceptable matches.
    weight: Math.pow(entry.matchScore / 100, 4),
  }));
  const rawLow = weightedPercentile(weightedPrices, 0.25);
  const rawLikely = weightedPercentile(weightedPrices, 0.5);
  const rawHigh = weightedPercentile(weightedPrices, 0.75);
  const low = marketRound(Math.min(rawLow, rawLikely));
  const likely = marketRound(rawLikely);
  const high = marketRound(Math.max(rawHigh, rawLikely));

  const averageMatch = eligible.reduce((sum, entry) => sum + entry.matchScore, 0) / eligible.length / 100;
  const spread = (high - low) / Math.max(1, likely);
  if (averageMatch < policy.minimumAverageMatch || spread > policy.maximumRangeSpread) return null;
  const sampleQuality = Math.min(1, eligible.length / 8);
  const stability = 1 - Math.min(1, spread);
  // Active asks are useful market context but less certain than completed sales.
  const confidence = Math.min(policy.maximumConfidence, Math.round(100 * (
    identity.identificationConfidence * 0.35
    + averageMatch * 0.3
    + sampleQuality * 0.2
    + stability * 0.15
  )));

  return { low, likely, high, currency: 'USD', confidence, basis: 'active_listings', sampleSize: eligible.length };
}

export function calculateValuation(id: string, identity: Identification, evidence: MarketEvidence[]): ValuationResult {
  const eligibleSold = evidence.filter((entry) => entry.kind === 'sold' && entry.matchScore >= 75 && typeof entry.price === 'number');
  const basis = eligibleSold;
  if (basis.length === 0) throw new Error('No sufficiently similar market evidence was found.');

  const prices = basis.map((entry) => entry.price! + (entry.shipping ?? 0)).sort((a, b) => a - b);
  const center = percentile(prices, 0.5);
  const low = roundToFive(prices.length >= 4 ? percentile(prices, 0.25) : center * 0.93);
  const high = roundToFive(prices.length >= 4 ? percentile(prices, 0.75) : center * 1.08);
  const spread = Math.max(0, high - low) / Math.max(1, center);
  const evidenceScore = Math.min(1, basis.length / 6);
  const sourceScore = 1;
  const confidence = Math.round(100 * Math.max(0.25, Math.min(0.96,
    identity.identificationConfidence * 0.45 + evidenceScore * 0.25 + sourceScore * 0.2 + (1 - Math.min(1, spread)) * 0.1,
  )));

  return {
    id,
    item: {
      name: `${identity.brand} ${identity.model}`.trim(),
      details: [identity.variant, `${identity.condition[0]!.toUpperCase()}${identity.condition.slice(1)} condition`].filter(Boolean).join(' · '),
    },
    identification: identity,
    estimate: { low, high, currency: 'USD', confidence },
    evidence,
    disclosure: 'Verified completed-sale evidence supports this estimate. Active listings are market context only.',
  };
}
