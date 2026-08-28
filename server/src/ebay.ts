import { config } from './config.js';
import type { Identification, MarketEvidence } from './domain.js';

const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope';
let cachedToken: { value: string; expiresAt: number } | null = null;

export function ebayIsConfigured() {
  return Boolean(config.EBAY_CLIENT_ID && config.EBAY_CLIENT_SECRET);
}

type EbaySearchPayload = {
  itemSummaries?: Array<{
    itemId?: unknown;
    title?: unknown;
    itemWebUrl?: unknown;
    itemAffiliateWebUrl?: unknown;
    condition?: unknown;
    buyingOptions?: unknown;
    categoryPath?: unknown;
    shortDescription?: unknown;
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

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenSet(value: string) {
  return new Set(normalized(value).split(/\s+/).filter((token) => token.length > 0));
}

function overlap(expected: Set<string>, actual: Set<string>) {
  if (expected.size === 0) return 1;
  let matches = 0;
  for (const token of expected) if (actual.has(token)) matches += 1;
  return matches / expected.size;
}

function known(value: string) {
  return value.length > 0 && !['unknown', 'unidentified', 'n/a', 'none'].includes(value.trim().toLowerCase());
}

function capacityValues(value: string) {
  return new Set(Array.from(value.toLowerCase().matchAll(/\b(\d+)\s*(gb|tb)\b/g), (match) => `${match[1]}${match[2]}`));
}

const modelModifiers = new Set(['air', 'elite', 'lite', 'max', 'mini', 'plus', 'pro', 'se', 'slim', 'ultra', 'xl']);
const unwantedSingleItem = /\b(lot of|bundle|wholesale|empty box|box only|manual only|case only|charger only|shell only)\b/i;
const brokenItem = /\b(for parts|parts only|not working|untested|broken|repair|as is|dead)\b/i;
const accessoryItem = /\b(case|cover|charger|cable|adapter|screen protector|mount|stand|replacement)\b/i;

function formMismatch(title: string, identity: Identification) {
  if (identity.itemForm === 'single_item') return unwantedSingleItem.test(title) || brokenItem.test(title) || accessoryItem.test(title);
  if (identity.itemForm === 'accessory') return brokenItem.test(title);
  if (identity.itemForm === 'replacement_part') return false;
  if (identity.itemForm === 'bundle') return brokenItem.test(title);
  return false;
}

function identityMismatch(title: string, identity: Identification) {
  const titleTokens = tokenSet(title);
  const brandTokens = known(identity.brand) ? tokenSet(identity.brand) : new Set<string>();
  const modelTokens = known(identity.model) ? tokenSet(identity.model) : new Set<string>();
  if (brandTokens.size > 0 && overlap(brandTokens, titleTokens) < 1) return true;
  if (modelTokens.size > 0 && overlap(modelTokens, titleTokens) < (brandTokens.size > 0 ? 0.6 : 0.4)) return true;

  const expectedModelNumbers = new Set(identity.model.match(/\b\d+\b/g) ?? []);
  const offeredModelNumbers = new Set(title.match(/\b\d+\b/g) ?? []);
  if (expectedModelNumbers.size > 0 && offeredModelNumbers.size > 0 && overlap(expectedModelNumbers, offeredModelNumbers) === 0) return true;

  const expectedCapacities = capacityValues([identity.variant, ...identity.attributes.map((attribute) => attribute.value)].join(' '));
  const offeredCapacities = capacityValues(title);
  if (expectedCapacities.size > 0 && offeredCapacities.size > 0 && overlap(expectedCapacities, offeredCapacities) === 0) return true;
  if (expectedCapacities.size > 0 && offeredCapacities.size > expectedCapacities.size) return true;

  const expectedModifiers = new Set([...modelTokens].filter((token) => modelModifiers.has(token)));
  const offeredModifiers = new Set([...titleTokens].filter((token) => modelModifiers.has(token)));
  if (expectedModifiers.size > 0 && overlap(expectedModifiers, offeredModifiers) < 1) return true;
  for (const modifier of offeredModifiers) if (!expectedModifiers.has(modifier)) return true;
  return false;
}

function listingMatchScore(title: string, condition: string, identity: Identification) {
  const titleTokens = tokenSet(title);
  const brand = known(identity.brand) ? overlap(tokenSet(identity.brand), titleTokens) : 1;
  const model = known(identity.model) ? overlap(tokenSet(identity.model), titleTokens) : 0.5;
  const variant = known(identity.variant) ? overlap(tokenSet(identity.variant), titleTokens) : 0.7;
  const prioritizedValues = identity.attributes.slice(0, 6).map((attribute) => attribute.value).filter(known).join(' ');
  const attributes = prioritizedValues ? overlap(tokenSet(prioritizedValues), titleTokens) : 0.7;
  const conditionText = normalized(`${title} ${condition}`);
  const conditionFit = identity.condition === 'unknown'
    ? 0.7
    : identity.condition === 'poor'
      ? (brokenItem.test(`${title} ${condition}`) ? 1 : 0.35)
      : /fair|acceptable|heavy wear|cracked|damaged|read description/.test(conditionText)
        ? (identity.condition === 'fair' ? 0.95 : 0.35)
        : /excellent|mint|like new/.test(conditionText)
          ? (identity.condition === 'excellent' ? 1 : 0.72)
          : /very good|good condition/.test(conditionText)
            ? (identity.condition === 'good' ? 1 : 0.72)
            : /new/.test(conditionText)
              ? (identity.condition === 'excellent' ? 0.85 : 0.45)
              : /used|pre owned|refurbished|open box/.test(conditionText) ? 0.78 : 0.6;
  return Math.round(Math.min(99, 100 * (brand * 0.18 + model * 0.42 + variant * 0.17 + attributes * 0.13 + conditionFit * 0.1)));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
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

export function mapEbayItems(payload: EbaySearchPayload, identity: Identification, observedAt = new Date().toISOString()): MarketEvidence[] {
  const candidates = (payload.itemSummaries ?? []).flatMap((item, index) => {
    const title = text(item.title);
    const url = httpsUrl(item.itemAffiliateWebUrl) ?? httpsUrl(item.itemWebUrl);
    const price = usd(item.price?.value, item.price?.currency);
    if (!title || !url || price === undefined) return [];
    const shippingCosts = (item.shippingOptions ?? [])
      .map((option) => usd(option.shippingCost?.value, option.shippingCost?.currency))
      .filter((value): value is number => value !== undefined);
    const shipping = shippingCosts.length > 0 ? Math.min(...shippingCosts) : undefined;
    const condition = text(item.condition);
    const buyingOptions = Array.isArray(item.buyingOptions) ? item.buyingOptions.map(text) : [];
    if (buyingOptions.length > 0 && !buyingOptions.includes('FIXED_PRICE')) return [];
    if (formMismatch(title, identity) || identityMismatch(title, identity)) return [];
    const score = listingMatchScore(title, condition, identity);
    if (score < 62) return [];

    return [{
      id: text(item.itemId) || `ebay-${index}`,
      source: 'eBay',
      title,
      detail: [condition || 'Condition not listed', buyingOptions.includes('BEST_OFFER') ? 'Best offer available' : 'Fixed price'].join(' · '),
      price,
      ...(shipping !== undefined ? { shipping } : {}),
      kind: 'active' as const,
      url,
      matchScore: score,
      observedAt,
      ...(httpsUrl(item.image?.imageUrl) ? { imageUrl: httpsUrl(item.image?.imageUrl) } : {}),
    }];
  });

  const unique = new Map<string, MarketEvidence>();
  for (const candidate of candidates) {
    const total = candidate.price! + (candidate.shipping ?? 0);
    const key = `${normalized(candidate.title)}|${total.toFixed(2)}`;
    const existing = unique.get(key);
    if (!existing || candidate.matchScore > existing.matchScore) unique.set(key, candidate);
  }
  const deduplicated = [...unique.values()];
  if (deduplicated.length < 4) return deduplicated.sort((a, b) => b.matchScore - a.matchScore);
  const center = median(deduplicated.map((listing) => listing.price! + (listing.shipping ?? 0)));
  return deduplicated
    .filter((listing) => {
      const total = listing.price! + (listing.shipping ?? 0);
      return total >= center * 0.3 && total <= center * 3.5;
    })
    .sort((a, b) => b.matchScore - a.matchScore || (a.price! + (a.shipping ?? 0)) - (b.price! + (b.shipping ?? 0)));
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
  url.searchParams.set('limit', '30');
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');

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
  return mapEbayItems(payload as EbaySearchPayload, identity).slice(0, 8);
}
