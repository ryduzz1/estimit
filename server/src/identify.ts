import { config } from './config.js';
import { identificationSchema, type Identification } from './domain.js';

const outputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'brand', 'model', 'variant', 'itemForm', 'quantity', 'attributes', 'condition', 'conditionNotes', 'identifiers', 'identificationConfidence', 'visualEstimateLow', 'visualEstimateHigh', 'missingDetails', 'requestedPhoto'],
  properties: {
    category: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    itemForm: { type: 'string', enum: ['single_item', 'bundle', 'accessory', 'replacement_part', 'packaging', 'unknown'] },
    quantity: { type: 'integer', minimum: 1, maximum: 100 },
    attributes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: { name: { type: 'string' }, value: { type: 'string' } },
      },
    },
    condition: { type: 'string', enum: ['poor', 'fair', 'good', 'excellent', 'unknown'] },
    conditionNotes: { type: 'array', items: { type: 'string' } },
    identifiers: { type: 'array', items: { type: 'string' } },
    identificationConfidence: { type: 'number', minimum: 0, maximum: 1 },
    visualEstimateLow: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
    visualEstimateHigh: { type: ['number', 'null'], minimum: 0, maximum: 1000000 },
    missingDetails: { type: 'array', items: { type: 'string' } },
    requestedPhoto: { type: ['string', 'null'] },
  },
} as const;

const previewIdentification: Identification = {
  category: 'smartphone',
  brand: 'Apple',
  model: 'iPhone 13 Pro',
  variant: '256GB · Sierra Blue',
  itemForm: 'single_item',
  quantity: 1,
  attributes: [
    { name: 'storage', value: '256GB' },
    { name: 'color', value: 'Sierra Blue' },
  ],
  condition: 'good',
  conditionNotes: ['Light visible wear'],
  identifiers: [],
  identificationConfidence: 0.89,
  visualEstimateLow: 350,
  visualEstimateHigh: 450,
  missingDetails: ['IMEI/clean status', 'battery health'],
  requestedPhoto: 'Photograph the model/IMEI screen and any visible damage for a more precise estimate.',
};

type ResponsePayload = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
};

export function extractResponseText(payload: ResponsePayload) {
  if (payload.output_text) return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) return content.text;
      if (content.type === 'refusal' && content.refusal) throw new Error(`OpenAI refused identification: ${content.refusal}`);
    }
  }
  throw new Error('OpenAI identification returned no structured output.');
}

export function hasSufficientIdentification(identity: Identification) {
  const unknown = (value: string) => ['unknown', 'unidentified', 'n/a'].includes(value.trim().toLowerCase());
  const ambiguous = (value: string) => /\b(unknown|unclear|likely|possibly|probably|or)\b/i.test(value);
  return identity.identificationConfidence >= 0.8
    && !unknown(identity.brand)
    && !unknown(identity.model)
    && !ambiguous(identity.model)
    && !ambiguous(identity.variant)
    && identity.itemForm !== 'unknown';
}

export function hasUsableSearchIdentity(identity: Identification) {
  const unusable = (value: string) => ['unknown', 'unidentified', 'n/a', 'none', 'object', 'item'].includes(value.trim().toLowerCase());
  const hasSpecificModel = !unusable(identity.model);
  const hasUsefulCategory = !unusable(identity.category);

  // Marketplace discovery can be useful with a descriptive item type even when a
  // label, exact variant, or brand is not visible. Keep the stricter 0.8 gate above
  // for any future price calculation backed by completed-sale evidence.
  return identity.identificationConfidence >= 0.45
    && identity.itemForm !== 'packaging'
    && (hasSpecificModel || hasUsefulCategory);
}

export function targetedPhotoRequest(identity: Identification) {
  const category = identity.category.toLowerCase();
  const missing = identity.missingDetails.join(' ').toLowerCase();
  if (/phone|tablet|computer|laptop|console|electronic/.test(category)) {
    return /model|serial|storage|identifier|label/.test(missing)
      ? 'Photograph the model or serial label so the exact version and storage can be read.'
      : 'Photograph the screen powered on and any visible damage.';
  }
  if (/card|trading/.test(category)) return 'Photograph the card straight on so the set symbol, card number, and condition corners are readable.';
  if (/shoe|sneaker|clothing|apparel/.test(category)) return 'Photograph the size and SKU tag inside the item.';
  if (/camera|lens/.test(category)) return 'Photograph the model markings around the lens or on the bottom label.';
  if (/tool/.test(category)) return 'Photograph the model-number label and everything included with the tool.';
  if (/game/.test(category)) return 'Photograph the front cover and the platform or edition marking.';
  if (identity.itemForm === 'bundle' || identity.quantity > 1) return 'Lay out every included item in one clear photo.';
  return identity.requestedPhoto ?? 'Photograph the complete item and any brand, model, barcode, or label.';
}

export async function identifyItem(image: Buffer, mimeType: string, hints?: string, safetyIdentifier?: string): Promise<Identification> {
  if (!config.OPENAI_API_KEY) return previewIdentification;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      store: false,
      max_output_tokens: 500,
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}),
      instructions: 'Identify the primary resale item shown. Report only visible or strongly supported facts; use unknown or missingDetails instead of guessing. Classify itemForm carefully: distinguish one complete item from a bundle, accessory, replacement part, or packaging/empty box. Set quantity to the number of materially included sale items. Capture pricing-relevant attributes as name/value pairs, such as storage, size, platform, edition, card number/set, model number, capacity, color, or connectivity. Put only visible condition observations in conditionNotes. requestedPhoto must ask for one specific view that would resolve the most price-relevant missing fact, or null when another photo would not materially improve identification. Also provide a conservative broad visualEstimateLow and visualEstimateHigh in current USD resale value based on general secondhand-market knowledge and visible condition. This is preliminary, not comparable-sale evidence. Use null for both when not recognizable enough. Low must not exceed high.',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `Identify this resale item.${hints ? ` On-device hints: ${hints}` : ''}` },
          { type: 'input_image', image_url: `data:${mimeType};base64,${image.toString('base64')}`, detail: 'high' },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'item_identification',
          strict: true,
          schema: outputJsonSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const message = await response.text();
    const openAIRequestId = response.headers.get('x-request-id') ?? 'unavailable';
    throw new Error(`OpenAI identification failed (${response.status}, request ${openAIRequestId}): ${message.slice(0, 300)}`);
  }

  const payload = await response.json() as ResponsePayload;
  return identificationSchema.parse(JSON.parse(extractResponseText(payload)));
}
