import type { Identification, MarketEvidence, ValuationResult } from './domain.js';

function percentile(sorted: number[], fraction: number) {
  if (sorted.length === 0) throw new Error('Cannot calculate a percentile without evidence.');
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

function roundToFive(value: number) {
  return Math.round(value / 5) * 5;
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
