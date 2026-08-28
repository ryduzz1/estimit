import type { Identification, MarketEvidence } from './domain.js';
import { buildEbaySearchQuery, ebayIsConfigured, findEbayListings } from './ebay.js';

export async function findEvidence(identity: Identification): Promise<MarketEvidence[]> {
  const label = buildEbaySearchQuery(identity);
  const query = encodeURIComponent(label);
  const observedAt = new Date().toISOString();

  try {
    const ebayListings = await findEbayListings(identity);
    if (ebayListings.length > 0) return ebayListings;
    // A successful provider query with no safe matches is an honest empty result.
    // Do not replace it with broad search links that look like vetted evidence.
    if (ebayIsConfigured()) return [];
  } catch (error) {
    // Marketplace availability must not make the entire scan fail. The source-search
    // links below remain useful while the provider recovers or credentials are fixed.
    console.warn('[Estimit evidence] eBay Browse unavailable', error instanceof Error ? error.message : 'unknown error');
  }

  // Search-link fallback. Do not attach synthetic prices or treat these as listing records.
  return [
    {
      id: 'search-ebay',
      source: 'eBay',
      title: label,
      detail: `Marketplace search · ${identity.condition}`,
      kind: 'active',
      url: `https://www.ebay.com/sch/i.html?_nkw=${query}`,
      matchScore: 93,
      observedAt,
    },
    {
      id: 'preview-swappa-active',
      source: 'Swappa',
      title: label,
      detail: 'Marketplace search',
      kind: 'active',
      url: `https://swappa.com/search?q=${query}`,
      matchScore: 90,
      observedAt,
    },
    {
      id: 'preview-backmarket-active',
      source: 'Back Market',
      title: label,
      detail: 'Refurbished marketplace search',
      kind: 'active',
      url: `https://www.backmarket.com/en-us/search?q=${query}`,
      matchScore: 86,
      observedAt,
    },
  ];
}
