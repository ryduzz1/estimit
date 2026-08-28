import assert from 'node:assert/strict';
import test from 'node:test';
import type { Identification, MarketEvidence } from '../src/domain.js';
import { calculateValuation } from '../src/pricing.js';

const identity: Identification = {
  category: 'smartphone', brand: 'Apple', model: 'iPhone 13 Pro', variant: '256GB', condition: 'good',
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
