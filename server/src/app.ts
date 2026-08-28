import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyRequest } from 'fastify';
import { config } from './config.js';
import { authenticateInstallation, createInstallation, databaseIsReady, getValuation, saveValuation } from './database.js';
import { identificationSchema, type Identification, type ResearchResult, type ValuationResult } from './domain.js';
import { findEvidence } from './evidence.js';
import { hasUsableSearchIdentity, identifyItem, targetedPhotoRequest } from './identify.js';
import { calculateValuation } from './pricing.js';

const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const installationIds = new WeakMap<FastifyRequest, string>();

function tokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function bearerToken(header: string | undefined) {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function validToken(header: string | undefined) {
  if (!config.ESTIMIT_API_TOKEN) return config.NODE_ENV !== 'production';
  const supplied = bearerToken(header);
  const expectedBuffer = Buffer.from(config.ESTIMIT_API_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function imageMatchesMime(image: Buffer, mimeType: string) {
  if (mimeType === 'image/jpeg') return image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if (mimeType === 'image/png') return image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return image.subarray(0, 4).toString('ascii') === 'RIFF' && image.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return image.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
}

function itemFromIdentity(identity: Identification) {
  const known = (value: string) => !['unknown', 'unidentified', 'n/a', 'none'].includes(value.trim().toLowerCase());
  const name = [identity.brand, identity.model].filter(known).join(' ').trim() || identity.category;
  const form = identity.itemForm === 'single_item' || identity.itemForm === 'unknown'
    ? ''
    : identity.itemForm.replace('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const details = [
    identity.variant,
    form,
    identity.quantity > 1 ? `${identity.quantity} items` : '',
    identity.condition !== 'unknown' ? `${identity.condition[0]!.toUpperCase()}${identity.condition.slice(1)} condition` : '',
  ].filter((value) => value && known(value)).join(' · ');
  return { name, details };
}

async function evaluateIdentity(id: string, identity: Identification): Promise<ResearchResult | ValuationResult> {
  const evidence = await findEvidence(identity);
  const soldEvidence = evidence.filter((entry) => entry.kind === 'sold' && typeof entry.price === 'number');
  if (soldEvidence.length > 0) return calculateValuation(id, identity, evidence);
  const hasVisualEstimate = identity.visualEstimateLow !== null && identity.visualEstimateHigh !== null;
  return {
    status: 'research_only',
    id,
    item: itemFromIdentity(identity),
    identification: identity,
    estimate: hasVisualEstimate ? {
      low: Math.round(Math.min(identity.visualEstimateLow!, identity.visualEstimateHigh!)),
      high: Math.round(Math.max(identity.visualEstimateLow!, identity.visualEstimateHigh!)),
      currency: 'USD',
      confidence: Math.min(55, Math.round(identity.identificationConfidence * 60)),
      basis: 'visual',
    } : null,
    evidence,
    disclosure: 'Preliminary visual range. Marketplace links are provided for comparison; verified sold-price data is not connected yet.',
  };
}

export function buildApp() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    bodyLimit: 13 * 1024 * 1024,
    // Docker's localhost-published port reaches the container through its private bridge.
    // Trust only loopback and that RFC1918 bridge range, never arbitrary forwarding peers.
    trustProxy: config.TRUST_PROXY ? '127.0.0.1,::1,172.16.0.0/12' : false,
    requestIdHeader: 'x-request-id',
  });
  app.register(rateLimit, { global: true, max: 60, timeWindow: '1 minute' });
  app.register(multipart, { limits: { files: 1, fileSize: 12 * 1024 * 1024, fields: 4 } });

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true, service: 'estimit-api' }));
  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const ready = await databaseIsReady();
    return reply.code(ready ? 200 : 503).send({ ok: ready, service: 'estimit-api', database: ready ? 'ready' : 'unavailable' });
  });

  app.post<{ Body: { platform?: unknown; appVersion?: unknown } }>('/v1/installations', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (!config.ALLOW_INSTALLATION_REGISTRATION) return reply.code(404).send({ error: 'not_found' });
    const platform = typeof request.body?.platform === 'string' ? request.body.platform.slice(0, 32) : 'unknown';
    const appVersion = typeof request.body?.appVersion === 'string' ? request.body.appVersion.slice(0, 32) : 'unknown';
    const id = randomUUID();
    const token = `est_install_${randomBytes(32).toString('base64url')}`;
    await createInstallation(id, tokenDigest(token), { platform, appVersion });
    request.log.info({ installationId: id }, 'Registered app installation');
    return reply.code(201).send({ installationId: id, token });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' || request.url === '/health/ready' || request.url === '/v1/installations') return;
    const tailscaleLogin = request.headers['tailscale-user-login'];
    if (config.TRUST_TAILSCALE_IDENTITY && typeof tailscaleLogin === 'string' && tailscaleLogin.length > 0) return;
    if (config.ESTIMIT_API_TOKEN && validToken(request.headers.authorization)) return;
    const token = bearerToken(request.headers.authorization);
    if (token.startsWith('est_install_')) {
      const installationId = await authenticateInstallation(tokenDigest(token));
      if (installationId) {
        installationIds.set(request, installationId);
        return;
      }
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  app.post('/v1/valuations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const fields: Record<string, string> = {};
    let image: Buffer | undefined;
    let mimeType = '';

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'image') {
          await part.toBuffer();
          continue;
        }
        mimeType = part.mimetype;
        image = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!image || !allowedImageTypes.has(mimeType) || !imageMatchesMime(image, mimeType)) {
      return reply.code(400).send({ error: 'Provide one JPEG, PNG, WebP, HEIC, or HEIF image in the image field.' });
    }

    const id = randomUUID();
    const imageSha256 = createHash('sha256').update(image).digest('hex');
    const installationId = installationIds.get(request);
    const identity = await identifyItem(image, mimeType, fields.hints, installationId ?? String(request.id));
    const usableForSearch = hasUsableSearchIdentity(identity);
    request.log.info({
      category: identity.category,
      brand: identity.brand,
      model: identity.model,
      identificationConfidence: identity.identificationConfidence,
      usableForSearch,
    }, 'Item identification completed');
    if (!usableForSearch) {
      return reply.code(422).send({
        error: 'insufficient_identification',
        identification: identity,
        requestedPhoto: targetedPhotoRequest(identity),
      });
    }
    const result = await evaluateIdentity(id, identity);
    if (!('status' in result)) await saveValuation(imageSha256, identity, result, installationId);
    return reply.code('status' in result ? 200 : 201).send(result);
  });

  app.post<{ Body: { identification?: unknown } }>('/v1/valuations/refine', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = identificationSchema.safeParse(request.body?.identification);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_identification' });
    const identity: Identification = {
      ...parsed.data,
      identificationConfidence: 1,
      visualEstimateLow: null,
      visualEstimateHigh: null,
      requestedPhoto: null,
    };
    if (!hasUsableSearchIdentity(identity)) return reply.code(400).send({ error: 'identity_not_searchable' });
    const result = await evaluateIdentity(randomUUID(), identity);
    return reply.code(200).send(result);
  });

  app.get<{ Params: { id: string } }>('/v1/valuations/:id', async (request, reply) => {
    const result = await getValuation(request.params.id, installationIds.get(request));
    if (!result) return reply.code(404).send({ error: 'valuation_not_found' });
    return result;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'Request failed');
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' && statusCode < 500 ? statusCode : 500;
    const message = error instanceof Error ? error.message : 'Request failed';
    reply.code(status).send({ error: status === 500 ? 'valuation_failed' : message });
  });

  return app;
}
