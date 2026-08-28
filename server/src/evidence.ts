import type { Identification, MarketEvidence } from './domain.js';
import { findEbayListings } from './ebay.js';

export async function findEvidence(identity: Identification): Promise<MarketEvidence[]> {
  const known = (value: string) => !['unknown', 'unidentified', 'n/a', 'none'].includes(value.trim().toLowerCase());
  const searchTerms = [identity.brand, identity.model, identity.variant].filter((value) => value && known(value));
  if (searchTerms.length === 0) searchTerms.push(identity.category);
  const label = searchTerms.join(' ').trim();
  const query = encodeURIComponent(label);
  const observedAt = new Date().toISOString();

  try {
    const ebayListings = await findEbayListings(identity);
    if (ebayListings.length > 0) return ebayListings;
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
