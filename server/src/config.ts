import { z } from 'zod';

const optionalNonempty = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: optionalNonempty,
  ESTIMIT_API_TOKEN: optionalNonempty,
  ALLOW_INSTALLATION_REGISTRATION: booleanFromEnvironment.default(false),
  TRUST_TAILSCALE_IDENTITY: booleanFromEnvironment.default(false),
  TRUST_PROXY: booleanFromEnvironment.default(false),
  OPENAI_API_KEY: optionalNonempty,
  OPENAI_MODEL: z.string().default('gpt-5.4-mini'),
  EBAY_CLIENT_ID: optionalNonempty,
  EBAY_CLIENT_SECRET: optionalNonempty,
});

export const config = schema.superRefine((value, context) => {
  if (value.NODE_ENV !== 'production') return;
  if (!value.DATABASE_URL) context.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL is required in production.' });
  if (!value.OPENAI_API_KEY) context.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required in production.' });
  if ((value.EBAY_CLIENT_ID && !value.EBAY_CLIENT_SECRET) || (!value.EBAY_CLIENT_ID && value.EBAY_CLIENT_SECRET)) {
    context.addIssue({ code: 'custom', path: ['EBAY_CLIENT_ID'], message: 'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured together.' });
  }
  if (!value.ESTIMIT_API_TOKEN && !value.ALLOW_INSTALLATION_REGISTRATION && !value.TRUST_TAILSCALE_IDENTITY) {
    context.addIssue({ code: 'custom', path: ['ESTIMIT_API_TOKEN'], message: 'Configure at least one production authentication method.' });
  }
}).parse(process.env);
