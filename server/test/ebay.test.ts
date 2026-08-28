import assert from 'node:assert/strict';
import test from 'node:test';
import { mapEbayItems } from '../src/ebay.js';

test('normalizes real eBay item summaries into active listing evidence', () => {
  const [listing] = mapEbayItems({
    itemSummaries: [{
      itemId: 'v1|123|0',
      title: 'Apple iPhone 13 Pro 256GB Unlocked',
      itemWebUrl: 'https://www.ebay.com/itm/123',
      condition: 'Used',
      price: { value: '399.99', currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: '8.25', currency: 'USD' } }],
      image: { imageUrl: 'https://i.ebayimg.com/example.jpg' },
    }],
  }, 'Apple iPhone 13 Pro 256GB', '2026-08-28T00:00:00.000Z');

  assert.equal(listing?.source, 'eBay');
  assert.equal(listing?.kind, 'active');
  assert.equal(listing?.price, 399.99);
  assert.equal(listing?.shipping, 8.25);
  assert.equal(listing?.url, 'https://www.ebay.com/itm/123');
  assert.ok((listing?.matchScore ?? 0) >= 90);
});

test('drops malformed, non-USD, and non-HTTPS eBay results', () => {
  const listings = mapEbayItems({
    itemSummaries: [
      { title: 'Missing URL', price: { value: '10', currency: 'USD' } },
      { title: 'Wrong currency', itemWebUrl: 'https://www.ebay.com/itm/1', price: { value: '10', currency: 'EUR' } },
      { title: 'Unsafe URL', itemWebUrl: 'http://example.com/item', price: { value: '10', currency: 'USD' } },
    ],
  }, 'item');
  assert.deepEqual(listings, []);
});
