export type EvidenceKind = 'sold' | 'active';

export type MarketEvidence = {
  id: string;
  source: string;
  title: string;
  detail: string;
  price?: number;
  shipping?: number;
  kind: EvidenceKind;
  url: string;
  matchScore: number;
  observedAt: string;
  imageUrl?: string;
};

export type Identification = {
  category: string;
  brand: string;
  model: string;
  variant: string;
  itemForm: 'single_item' | 'bundle' | 'accessory' | 'replacement_part' | 'packaging' | 'unknown';
  quantity: number;
  attributes: Array<{ name: string; value: string }>;
  condition: 'poor' | 'fair' | 'good' | 'excellent' | 'unknown';
  conditionNotes: string[];
  identifiers: string[];
  identificationConfidence: number;
  visualEstimateLow: number | null;
  visualEstimateHigh: number | null;
  missingDetails: string[];
  requestedPhoto: string | null;
};

export type NeedMoreDetail = {
  error: 'insufficient_identification';
  identification: Identification;
  requestedPhoto: string;
};

export type ValuationResult = {
  id: string;
  item: {
    name: string;
    details: string;
  };
  identification: Identification;
  estimate: {
    low: number;
    high: number;
    currency: 'USD';
    confidence: number;
  };
  evidence: MarketEvidence[];
  disclosure?: string;
};

export type ResearchResult = {
  status: 'research_only';
  id: string;
  item: { name: string; details: string };
  identification: Identification;
  estimate: {
    low: number;
    high: number;
    currency: 'USD';
    confidence: number;
    basis: 'visual';
  } | null;
  evidence: MarketEvidence[];
  disclosure: string;
};

export const previewValuation: ValuationResult = {
  id: 'preview-iphone-13-pro-256',
  item: {
    name: 'iPhone 13 Pro',
    details: '256GB · Sierra Blue · Good condition',
  },
  identification: {
    category: 'smartphone',
    brand: 'Apple',
    model: 'iPhone 13 Pro',
    variant: '256GB · Sierra Blue',
    itemForm: 'single_item',
    quantity: 1,
    attributes: [{ name: 'storage', value: '256GB' }, { name: 'color', value: 'Sierra Blue' }],
    condition: 'good',
    conditionNotes: ['Light visible wear'],
    identifiers: [],
    identificationConfidence: 0.89,
    visualEstimateLow: 395,
    visualEstimateHigh: 435,
    missingDetails: ['IMEI/clean status', 'battery health'],
    requestedPhoto: null,
  },
  estimate: {
    low: 395,
    high: 435,
    currency: 'USD',
    confidence: 89,
  },
  evidence: [
    {
      id: 'swappa-active-search',
      source: 'Swappa',
      title: 'iPhone 13 Pro · 256GB',
      detail: 'Possible match · unlocked · good',
      price: 412,
      kind: 'active',
      url: 'https://swappa.com/listings/apple-iphone-13-pro',
      matchScore: 96,
      observedAt: '2026-08-27T19:45:00Z',
      imageUrl: 'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=240&q=80',
    },
    {
      id: 'ebay-sold-search',
      source: 'eBay',
      title: 'Apple iPhone 13 Pro · 256GB',
      detail: 'Sold-market evidence · Sierra Blue',
      price: 399,
      kind: 'sold',
      url: 'https://www.ebay.com/sch/i.html?_nkw=iphone+13+pro+256gb+sierra+blue&LH_Sold=1&LH_Complete=1',
      matchScore: 93,
      observedAt: '2026-08-27T19:45:00Z',
      imageUrl: 'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=240&q=80',
    },
    {
      id: 'backmarket-active-search',
      source: 'Back Market',
      title: 'iPhone 13 Pro 256GB',
      detail: 'Possible match · refurbished',
      price: 429,
      kind: 'active',
      url: 'https://www.backmarket.com/en-us/search?q=iPhone%2013%20Pro%20256GB',
      matchScore: 88,
      observedAt: '2026-08-27T19:45:00Z',
      imageUrl: 'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=240&q=80',
    },
  ],
  disclosure: 'Preview evidence. Live prices and exact listing URLs will come from the valuation service.',
};

export function formatMoney(value: number, currency: ValuationResult['estimate']['currency'] = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatEstimate(result: ValuationResult) {
  return `${formatMoney(result.estimate.low, result.estimate.currency)}–${formatMoney(result.estimate.high, result.estimate.currency)}`;
}
