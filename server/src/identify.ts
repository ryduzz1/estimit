import { config } from './config.js';
import { identificationSchema, type Identification } from './domain.js';

const outputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'brand', 'model', 'variant', 'condition', 'identifiers', 'identificationConfidence', 'visualEstimateLow', 'visualEstimateHigh', 'missingDetails', 'requestedPhoto'],
  properties: {
    category: { type: 'string' },
    brand: { type: 'string' },
    model: { type: 'string' },
    variant: { type: 'string' },
    condition: { type: 'string', enum: ['poor', 'fair', 'good', 'excellent', 'unknown'] },
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
  condition: 'good',
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
    && !ambiguous(identity.variant);
}

export function hasUsableSearchIdentity(identity: Identification) {
  const unusable = (value: string) => ['unknown', 'unidentified', 'n/a', 'none', 'object', 'item'].includes(value.trim().toLowerCase());
  const hasSpecificModel = !unusable(identity.model);
  const hasUsefulCategory = !unusable(identity.category);

  // Marketplace discovery can be useful with a descriptive item type even when a
  // label, exact variant, or brand is not visible. Keep the stricter 0.8 gate above
  // for any future price calculation backed by completed-sale evidence.
  return identity.identificationConfidence >= 0.45 && (hasSpecificModel || hasUsefulCategory);
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
      instructions: 'Identify the single resale item shown. Report only visible or strongly supported identity facts. Use unknown or missingDetails instead of guessing identity. Also provide a conservative, broad visualEstimateLow and visualEstimateHigh in current USD resale value based on general secondhand-market knowledge and the visible condition. This is a preliminary visual estimate, not verified comparable-sale evidence. Use null for both estimate fields when the item is not recognizable enough to estimate. The low value must not exceed the high value.',
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
