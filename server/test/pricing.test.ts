import assert from 'node:assert/strict';
import test from 'node:test';
import type { Identification, MarketEvidence } from '../src/domain.js';
import { calculateActiveMarketEstimate, calculateValuation, marketQualityPolicy } from '../src/pricing.js';

const identity: Identification = {
  category: 'smartphone', brand: 'Apple', model: 'iPhone 13 Pro', variant: '256GB', condition: 'good',
  itemForm: 'single_item', quantity: 1, attributes: [{ name: 'storage', value: '256GB' }], conditionNotes: [],
  identifiers: [], identificationConfidence: 0.9, visualEstimateLow: 350, visualEstimateHigh: 450, missingDetails: [], requestedPhoto: null,
};

test('sold evidence controls the estimate while active listings remain visible', () => {
  const observedAt = new Date().toISOString();
  const evidence: MarketEvidence[] = [
    { id: 'sold', source: 'Test', title: 'Sold', detail: '', price: 400, shipping: 10, kind: 'sold', url: 'https://example.com/sold', matchScore: 95, observedAt },
    { id: 'active', source: 'Test', title: 'Active', detail: '', price: 900, shipping: 0, kind: 'active', url: 'https://example.com/active', matchScore: 95, observedAt },
  ];
  const result = calculateValuation('00000000-0000-0000-0000-000000000001', identity, evidence);
  assert.deepEqual({ low: result.estimate.low, high: result.estimate.high }, { low: 380, high: 445 });
  assert.equal(result.evidence.length, 2);
});

test('refuses to calculate a valuation from asking prices alone', () => {
  const evidence: MarketEvidence[] = [
    { id: 'active', source: 'Test', title: 'Active', detail: '', price: 900, kind: 'active', url: 'https://example.com/active', matchScore: 95, observedAt: new Date().toISOString() },
  ];
  assert.throws(() => calculateValuation('00000000-0000-0000-0000-000000000002', identity, evidence), /No sufficiently similar market evidence/);
});

test('calculates a deterministic asking-price center and range from close active listings', () => {
  const observedAt = new Date().toISOString();
  const evidence: MarketEvidence[] = [
    { id: 'a', source: 'eBay', title: 'A', detail: '', price: 90, shipping: 10, kind: 'active', url: 'https://example.com/a', matchScore: 96, observedAt },
    { id: 'b', source: 'eBay', title: 'B', detail: '', price: 120, kind: 'active', url: 'https://example.com/b', matchScore: 94, observedAt },
    { id: 'c', source: 'eBay', title: 'C', detail: '', price: 140, kind: 'active', url: 'https://example.com/c', matchScore: 92, observedAt },
    { id: 'd', source: 'eBay', title: 'D', detail: '', price: 500, kind: 'active', url: 'https://example.com/d', matchScore: 72, observedAt },
  ];
  const estimate = calculateActiveMarketEstimate(identity, evidence);
  assert.deepEqual({ low: estimate?.low, likely: estimate?.likely, high: estimate?.high }, { low: 100, likely: 120, high: 140 });
  assert.equal(estimate?.sampleSize, 4);
  assert.equal(estimate?.basis, 'active_listings');
  assert.ok((estimate?.confidence ?? 100) <= 80);
});

test('withholds an asking-price estimate when fewer than three close listings exist', () => {
  const observedAt = new Date().toISOString();
  const evidence: MarketEvidence[] = [
    { id: 'a', source: 'eBay', title: 'A', detail: '', price: 100, kind: 'active', url: 'https://example.com/a', matchScore: 95, observedAt },
    { id: 'b', source: 'eBay', title: 'B', detail: '', price: 120, kind: 'active', url: 'https://example.com/b', matchScore: 94, observedAt },
  ];
  assert.equal(calculateActiveMarketEstimate(identity, evidence), null);
});

test('requires more evidence and caps confidence for generic or non-standard items', () => {
  const generic = { ...identity, brand: 'unknown', model: 'wired gaming mouse' };
  assert.deepEqual(marketQualityPolicy(generic), {
    minimumSampleSize: 5,
    minimumAverageMatch: 0.78,
    maximumRangeSpread: 0.55,
    maximumConfidence: 65,
  });
  const observedAt = new Date().toISOString();
  const evidence: MarketEvidence[] = [100, 105, 110, 115].map((price, index) => ({
    id: String(index), source: 'eBay', title: 'Mouse', detail: '', price, kind: 'active' as const,
    url: `https://example.com/${index}`, matchScore: 95, observedAt,
  }));
  assert.equal(calculateActiveMarketEstimate(generic, evidence), null);
});

test('declines unstable markets with an excessively wide central range', () => {
  const observedAt = new Date().toISOString();
  const evidence: MarketEvidence[] = [10, 20, 100, 200, 220].map((price, index) => ({
    id: String(index), source: 'eBay', title: 'Item', detail: '', price, kind: 'active' as const,
    url: `https://example.com/wide-${index}`, matchScore: 95, observedAt,
  }));
  assert.equal(calculateActiveMarketEstimate(identity, evidence), null);
});
