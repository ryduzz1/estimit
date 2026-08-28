import { config } from './config.js';
import type { Identification, MarketEvidence } from './domain.js';

const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';
let cachedToken: { value: string; expiresAt: number } | null = null;

type EbaySearchPayload = {
  itemSummaries?: Array<{
    itemId?: unknown;
    title?: unknown;
    itemWebUrl?: unknown;
    itemAffiliateWebUrl?: unknown;
    condition?: unknown;
    price?: { value?: unknown; currency?: unknown };
    image?: { imageUrl?: unknown };
    shippingOptions?: Array<{ shippingCost?: { value?: unknown; currency?: unknown } }>;
  }>;
};

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function usd(value: unknown, currency: unknown) {
  const amount = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return text(currency) === 'USD' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function httpsUrl(value: unknown) {
  const candidate = text(value);
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function matchScore(query: string, title: string) {
  const tokens = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const titleTokens = new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (tokens.size === 0) return 60;
  let matched = 0;
  for (const token of tokens) if (titleTokens.has(token)) matched += 1;
  return Math.round(60 + 38 * matched / tokens.size);
}

const categoryAttributePriority: Array<[RegExp, string[]]> = [
  [/phone|tablet|computer|laptop|electronic/, ['storage', 'capacity', 'model number', 'carrier', 'connectivity']],
  [/camera|lens/, ['mount', 'focal length', 'model number']],
  [/card|trading/, ['set', 'card number', 'year', 'player', 'character', 'variant']],
  [/shoe|sneaker|clothing|apparel/, ['style code', 'sku', 'size', 'gender']],
  [/game|console/, ['platform', 'edition', 'region']],
  [/tool/, ['model number', 'voltage', 'battery platform']],
];

export function buildEbaySearchQuery(identity: Identification) {
  const known = (value: string) => value && !['unknown', 'unidentified', 'n/a', 'none'].includes(value.trim().toLowerCase());
  const category = identity.category.toLowerCase();
  const priorities = categoryAttributePriority.find(([pattern]) => pattern.test(category))?.[1] ?? [];
  const attributes = new Map(identity.attributes.map((attribute) => [attribute.name.trim().toLowerCase(), attribute.value.trim()]));
  const terms = [identity.brand, identity.model, identity.variant].filter(known);
  for (const name of priorities) {
    const value = attributes.get(name);
    if (value && known(value)) terms.push(value);
  }
  for (const identifier of identity.identifiers.slice(0, 2)) if (known(identifier)) terms.push(identifier);
  if (terms.length === 0) terms.push(identity.category);
  if (identity.itemForm === 'bundle' && identity.quantity > 1) terms.push(`lot of ${identity.quantity}`);

  const seen = new Set<string>();
  return terms
    .flatMap((term) => term.split(/\s*·\s*/))
    .map((term) => term.trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ')
    .slice(0, 180);
}

export function mapEbayItems(payload: EbaySearchPayload, query: string, observedAt = new Date().toISOString()): MarketEvidence[] {
  return (payload.itemSummaries ?? []).flatMap((item, index) => {
    const title = text(item.title);
    const url = httpsUrl(item.itemAffiliateWebUrl) ?? httpsUrl(item.itemWebUrl);
    const price = usd(item.price?.value, item.price?.currency);
    if (!title || !url || price === undefined) return [];
    const shipping = usd(item.shippingOptions?.[0]?.shippingCost?.value, item.shippingOptions?.[0]?.shippingCost?.currency);
    const condition = text(item.condition);

    return [{
      id: text(item.itemId) || `ebay-${index}`,
      source: 'eBay',
      title,
      detail: condition || 'Active eBay listing',
      price,
      ...(shipping !== undefined ? { shipping } : {}),
      kind: 'active' as const,
      url,
      matchScore: matchScore(query, title),
      observedAt,
      ...(httpsUrl(item.image?.imageUrl) ? { imageUrl: httpsUrl(item.image?.imageUrl) } : {}),
    }];
  });
}

async function applicationToken() {
  if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.EBAY_CLIENT_ID}:${config.EBAY_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: EBAY_SCOPE }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; error_description?: unknown } | null;
  if (!response.ok || typeof payload?.access_token !== 'string') {
    throw new Error(`eBay OAuth failed (${response.status}): ${text(payload?.error_description) || 'token unavailable'}`);
  }
  const lifetime = typeof payload.expires_in === 'number' ? payload.expires_in : Number(payload.expires_in);
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number.isFinite(lifetime) ? lifetime : 7_200) * 1_000,
  };
  return cachedToken.value;
}

export async function findEbayListings(identity: Identification): Promise<MarketEvidence[]> {
  const token = await applicationToken();
  if (!token) return [];
  const query = buildEbaySearchQuery(identity);
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '5');

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-ebay-c-marketplace-id': 'EBAY_US',
    },
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as EbaySearchPayload | { errors?: Array<{ message?: unknown }> } | null;
  if (!response.ok) {
    const message = payload && 'errors' in payload ? text(payload.errors?.[0]?.message) : '';
    throw new Error(`eBay Browse search failed (${response.status}): ${message || 'search unavailable'}`);
  }
  return mapEbayItems(payload as EbaySearchPayload, query).slice(0, 5);
}
