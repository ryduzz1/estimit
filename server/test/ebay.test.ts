import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEbaySearchQueries, buildEbaySearchQuery, mapEbayItems } from '../src/ebay.js';
import type { Identification } from '../src/domain.js';

const identity: Identification = {
  category: 'smartphone', brand: 'Apple', model: 'iPhone 13 Pro', variant: 'Sierra Blue',
  itemForm: 'single_item', quantity: 1,
  attributes: [{ name: 'storage', value: '256GB' }, { name: 'color', value: 'Sierra Blue' }],
  condition: 'good', conditionNotes: [], identifiers: [], identificationConfidence: 0.93,
  visualEstimateLow: 350, visualEstimateHigh: 450, missingDetails: [], requestedPhoto: null,
};

test('builds category-aware searches with pricing-relevant attributes', () => {
  assert.equal(buildEbaySearchQuery(identity), 'Apple iPhone 13 Pro Sierra Blue 256GB');
  assert.deepEqual(buildEbaySearchQueries(identity), [
    'Apple iPhone 13 Pro Sierra Blue 256GB',
    'Apple iPhone 13 Pro',
  ]);
  assert.match(buildEbaySearchQuery({ ...identity, itemForm: 'bundle', quantity: 3 }), /lot of 3$/);
});

test('does not issue a duplicate broad query when the exact query is already broad', () => {
  assert.deepEqual(buildEbaySearchQueries({ ...identity, variant: '', attributes: [] }), ['Apple iPhone 13 Pro']);
});

test('normalizes real eBay item summaries into active listing evidence', () => {
  const [listing] = mapEbayItems({
    itemSummaries: [{
      itemId: 'v1|123|0',
      title: 'Apple iPhone 13 Pro 256GB Unlocked',
      itemWebUrl: 'https://www.ebay.com/itm/123',
      condition: 'Used',
      price: { value: '399.99', currency: 'USD' },
      shippingOptions: [{ shippingCost: { value: '8.25', currency: 'USD' } }],
      buyingOptions: ['FIXED_PRICE', 'BEST_OFFER'],
      image: { imageUrl: 'https://i.ebayimg.com/example.jpg' },
    }],
  }, identity, '2026-08-28T00:00:00.000Z');

  assert.equal(listing?.source, 'eBay');
  assert.equal(listing?.kind, 'active');
  assert.equal(listing?.price, 399.99);
  assert.equal(listing?.shipping, 8.25);
  assert.equal(listing?.url, 'https://www.ebay.com/itm/123');
  assert.ok((listing?.matchScore ?? 0) >= 70);
  assert.match(listing?.detail ?? '', /Best offer available/);
});

test('drops malformed, non-USD, and non-HTTPS eBay results', () => {
  const listings = mapEbayItems({
    itemSummaries: [
      { title: 'Missing URL', price: { value: '10', currency: 'USD' } },
      { title: 'Wrong currency', itemWebUrl: 'https://www.ebay.com/itm/1', price: { value: '10', currency: 'EUR' } },
      { title: 'Unsafe URL', itemWebUrl: 'http://example.com/item', price: { value: '10', currency: 'USD' } },
    ],
  }, identity);
  assert.deepEqual(listings, []);
});

test('rejects parts, accessories, bundles, auctions, and conflicting variants for a single item', () => {
  const valid = (id: string, title: string, price = '400', buyingOptions: string[] = ['FIXED_PRICE']) => ({
    itemId: id,
    title,
    itemWebUrl: `https://www.ebay.com/itm/${id}`,
    condition: 'Used',
    price: { value: price, currency: 'USD' },
    buyingOptions,
  });
  const listings = mapEbayItems({ itemSummaries: [
    valid('good', 'Apple iPhone 13 Pro 256GB Unlocked'),
    valid('parts', 'Apple iPhone 13 Pro 256GB For Parts Not Working', '90'),
    valid('case', 'Case for Apple iPhone 13 Pro 256GB', '12'),
    valid('bundle', 'Bundle Lot of 3 Apple iPhone 13 Pro 256GB', '900'),
    valid('storage', 'Apple iPhone 13 Pro 128GB Unlocked', '320'),
    valid('multi-storage', 'Apple iPhone 13 Pro 128GB or 256GB Pick One', '300'),
    valid('model', 'Apple iPhone 13 Pro Max 256GB', '500'),
    valid('generation', 'Apple iPhone 14 Pro 256GB', '470'),
    valid('auction', 'Apple iPhone 13 Pro 256GB', '50', ['AUCTION']),
  ] }, identity);
  assert.deepEqual(listings.map((listing) => listing.id), ['good']);
});

test('deduplicates equivalent listings and removes extreme price outliers', () => {
  const listing = (id: string, title: string, price: string) => ({
    itemId: id,
    title,
    itemWebUrl: `https://www.ebay.com/itm/${id}`,
    condition: 'Used',
    price: { value: price, currency: 'USD' },
    buyingOptions: ['FIXED_PRICE'],
  });
  const listings = mapEbayItems({ itemSummaries: [
    listing('a', 'Apple iPhone 13 Pro 256GB Unlocked', '390'),
    listing('duplicate', 'Apple iPhone 13 Pro 256GB Unlocked', '390'),
    listing('b', 'Apple iPhone 13 Pro 256GB Smartphone', '410'),
    listing('c', 'Apple iPhone 13 Pro 256GB Used', '430'),
    listing('d', 'Apple iPhone 13 Pro 256GB Sierra Blue', '450'),
    listing('outlier', 'Apple iPhone 13 Pro 256GB Rare', '4000'),
  ] }, identity);
  assert.equal(listings.length, 4);
  assert.equal(listings.some((item) => item.id === 'duplicate'), false);
  assert.equal(listings.some((item) => item.id === 'outlier'), false);
});

test('keeps descriptive generic items without confusing product materials for replacement parts', () => {
  const generic: Identification = {
    ...identity,
    category: 'computer peripheral',
    brand: 'unknown',
    model: 'wired gaming mouse',
    variant: 'honeycomb shell',
    attributes: [{ name: 'connectivity', value: 'wired' }],
  };
  const listings = mapEbayItems({ itemSummaries: [{
    itemId: 'mouse',
    title: 'Wired Honeycomb Shell RGB Gaming Mouse',
    itemWebUrl: 'https://www.ebay.com/itm/mouse',
    condition: 'Used',
    price: { value: '19.99', currency: 'USD' },
    buyingOptions: ['FIXED_PRICE'],
  }] }, generic);
  assert.equal(listings.length, 1);
});

test('rejects component-only laptop and single-earbud listings', () => {
  const item = (id: string, title: string) => ({
    itemId: id, title, itemWebUrl: `https://www.ebay.com/itm/${id}`, condition: 'Used',
    price: { value: '129.99', currency: 'USD' }, buyingOptions: ['FIXED_PRICE'],
  });
  const laptopParts = mapEbayItems({ itemSummaries: [
    item('screen', 'Apple MacBook Pro A1708 13.3in LED LCD Screen Assembly'),
  ] }, { ...identity, category: 'laptop', model: 'MacBook Pro', variant: '', attributes: [] });
  const earbudParts = mapEbayItems({ itemSummaries: [
    item('earbud-a', 'Apple AirPods Pro 2 A3048 Left - OEM'),
    item('earbud-b', 'Apple AirPods Pro 2nd Generation USB-C Left AirPod Only A3048'),
    item('earbud-c', 'Earbuds For Apple AirPods Pro 2nd Generation USB-C Type Left Side Only A3048'),
  ] }, { ...identity, category: 'wireless earbuds', model: 'AirPods Pro', variant: '', attributes: [] });
  assert.deepEqual(laptopParts, []);
  assert.deepEqual(earbudParts, []);
});

test('distinguishes laptop RAM from the requested storage capacity', () => {
  const laptop: Identification = {
    ...identity,
    category: 'laptop',
    model: 'MacBook Pro',
    variant: 'Space Gray',
    attributes: [{ name: 'storage', value: '512GB' }, { name: 'model number', value: 'A2338' }],
  };
  const listings = mapEbayItems({ itemSummaries: [{
    itemId: 'macbook',
    title: '2020 Apple M1 MacBook Pro 13.3-inch 16GB RAM 512GB SSD Space Gray A2338',
    itemWebUrl: 'https://www.ebay.com/itm/macbook',
    condition: 'Used',
    price: { value: '525', currency: 'USD' },
    buyingOptions: ['FIXED_PRICE'],
  }] }, laptop);
  assert.equal(listings.length, 1);
});

test('requires a visible model-number attribute and checks provider condition text', () => {
  const laptop: Identification = {
    ...identity,
    category: 'laptop',
    model: 'MacBook Pro',
    variant: '',
    attributes: [{ name: 'model number', value: 'A2338' }],
  };
  const item = (id: string, title: string, condition: string) => ({
    itemId: id, title, condition, itemWebUrl: `https://www.ebay.com/itm/${id}`,
    price: { value: '500', currency: 'USD' }, buyingOptions: ['FIXED_PRICE'],
  });
  const listings = mapEbayItems({ itemSummaries: [
    item('exact', 'Apple MacBook Pro 2020 A2338 M1 16GB 512GB', 'Used'),
    item('wrong-model', 'Apple MacBook Pro 2021 A2442 M1 Pro 16GB 512GB', 'Used'),
    item('parts-condition', 'Apple MacBook Pro 2020 A2338 M1 16GB 512GB', 'For parts or not working'),
  ] }, laptop);
  assert.deepEqual(listings.map((listing) => listing.id), ['exact']);
});
