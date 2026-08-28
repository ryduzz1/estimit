import assert from 'node:assert/strict';
import test from 'node:test';
import { extractResponseText, hasSufficientIdentification, hasUsableSearchIdentity, targetedPhotoRequest } from '../src/identify.js';
import type { Identification } from '../src/domain.js';

test('extracts structured text from a raw Responses API payload', () => {
  const text = extractResponseText({
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: '{"model":"example"}' }],
    }],
  });
  assert.equal(text, '{"model":"example"}');
});

test('supports the SDK output_text convenience property', () => {
  assert.equal(extractResponseText({ output_text: '{"model":"example"}' }), '{"model":"example"}');
});

const identified: Identification = {
  category: 'smartphone', brand: 'Apple', model: 'iPhone 13 Pro', variant: '256GB', condition: 'good',
  itemForm: 'single_item', quantity: 1, attributes: [{ name: 'storage', value: '256GB' }], conditionNotes: [],
  identifiers: [], identificationConfidence: 0.9, visualEstimateLow: 350, visualEstimateHigh: 450, missingDetails: [], requestedPhoto: null,
};

test('requires a known brand, known model, and adequate confidence before pricing', () => {
  assert.equal(hasSufficientIdentification(identified), true);
  assert.equal(hasSufficientIdentification({ ...identified, brand: 'unknown' }), false);
  assert.equal(hasSufficientIdentification({ ...identified, model: 'unknown' }), false);
  assert.equal(hasSufficientIdentification({ ...identified, identificationConfidence: 0.79 }), false);
  assert.equal(hasSufficientIdentification({ ...identified, variant: 'likely iPhone 13 Pro or 14 Pro' }), false);
});

test('does not treat packaging as a searchable resale item', () => {
  assert.equal(hasUsableSearchIdentity({ ...identified, itemForm: 'packaging' }), false);
});

test('asks for a category-specific photo when identification is incomplete', () => {
  assert.match(targetedPhotoRequest({ ...identified, missingDetails: ['storage and model label'] }), /model or serial label/i);
  assert.match(targetedPhotoRequest({ ...identified, category: 'trading card' }), /card number/i);
});

test('allows recognizable items into marketplace discovery without pretending they are price-ready', () => {
  assert.equal(hasUsableSearchIdentity({
    ...identified,
    brand: 'unknown',
    model: 'mechanical keyboard',
    variant: '',
    identificationConfidence: 0.62,
  }), true);
  assert.equal(hasUsableSearchIdentity({
    ...identified,
    brand: 'unknown',
    model: 'unknown',
    category: 'keyboard',
    identificationConfidence: 0.55,
  }), true);
  assert.equal(hasUsableSearchIdentity({
    ...identified,
    brand: 'unknown',
    model: 'unknown',
    category: 'object',
    identificationConfidence: 0.3,
  }), false);
});
