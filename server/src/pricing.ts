import type { Identification, MarketEvidence, ValuationResult } from './domain.js';

export type ActiveMarketEstimate = {
  low: number;
  likely: number;
  high: number;
  currency: 'USD';
  confidence: number;
  basis: 'active_listings' | 'visual_estimate';
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
  const eligible = evidence.filter((entry) => entry.kind === 'active' && entry.matchScore >= 62 && typeof entry.price === 'number');
  if (eligible.length === 0) return null;

  const weightedPrices = eligible.map((entry) => ({
    value: entry.price! + (entry.shipping ?? 0),
    // Exact matches should move the center more than merely acceptable matches.
    weight: Math.pow(entry.matchScore / 100, 4),
  }));
  let rawLow = weightedPercentile(weightedPrices, 0.25);
  const rawLikely = eligible.length === 2
    ? weightedPrices.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weightedPrices.reduce((sum, entry) => sum + entry.weight, 0)
    : weightedPercentile(weightedPrices, 0.5);
  let rawHigh = weightedPercentile(weightedPrices, 0.75);
  if (eligible.length === 1) {
    rawLow = rawLikely * 0.72;
    rawHigh = rawLikely * 1.32;
  }
  const low = marketRound(Math.min(rawLow, rawLikely));
  const likely = marketRound(rawLikely);
  const high = marketRound(Math.max(rawHigh, rawLikely));

  const averageMatch = eligible.reduce((sum, entry) => sum + entry.matchScore, 0) / eligible.length / 100;
  const spread = (high - low) / Math.max(1, likely);
  const sampleQuality = Math.min(1, eligible.length / 8);
  const stability = 1 - Math.min(1, spread);
  const matchCertainty = Math.max(0, Math.min(1, (averageMatch - 0.55) / 0.4));
  const variantUncertain = /\b(unknown|unclear|likely|possibly|probably)\b/i.test(identity.variant)
    || identity.missingDetails.some((detail) => /\b(model|year|generation|processor|storage|size|variant)\b/i.test(detail));
  const detailPenalty = variantUncertain ? 0.75 : 1;
  // Asking prices remain useful even when the market is mixed. Instead of hiding
  // the number, express that uncertainty through a visibly lower confidence.
  let confidence = Math.max(12, Math.min(policy.maximumConfidence, Math.round(100 * detailPenalty * (
    identity.identificationConfidence * 0.2
    + matchCertainty * 0.4
    + sampleQuality * 0.15
    + stability * 0.15
  ))));
  if (eligible.length < policy.minimumSampleSize) {
    confidence = Math.min(confidence, Math.round(20 + 30 * eligible.length / policy.minimumSampleSize));
  }
  if (spread > policy.maximumRangeSpread) {
    confidence = Math.max(10, Math.round(confidence * policy.maximumRangeSpread / spread));
  }

  return { low, likely, high, currency: 'USD', confidence, basis: 'active_listings', sampleSize: eligible.length };
}

export function calculateResearchEstimate(identity: Identification, evidence: MarketEvidence[]): ActiveMarketEstimate | null {
  const marketEstimate = calculateActiveMarketEstimate(identity, evidence);
  if (marketEstimate) return marketEstimate;
  if (identity.visualEstimateLow === null || identity.visualEstimateHigh === null) return null;

  const low = marketRound(Math.min(identity.visualEstimateLow, identity.visualEstimateHigh));
  const high = marketRound(Math.max(identity.visualEstimateLow, identity.visualEstimateHigh));
  const likely = marketRound((low + high) / 2);
  const spread = (high - low) / Math.max(1, likely);
  const confidence = Math.max(10, Math.min(38, Math.round(
    identity.identificationConfidence * 34 + (1 - Math.min(1, spread)) * 8,
  )));
  return { low, likely, high, currency: 'USD', confidence, basis: 'visual_estimate', sampleSize: 0 };
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
