import { z } from 'zod';

export const identificationSchema = z.object({
  category: z.string().min(1),
  brand: z.string().min(1),
  model: z.string().min(1),
  variant: z.string(),
  itemForm: z.enum(['single_item', 'bundle', 'accessory', 'replacement_part', 'packaging', 'unknown']),
  quantity: z.number().int().min(1).max(100),
  attributes: z.array(z.object({
    name: z.string().min(1).max(64),
    value: z.string().min(1).max(128),
  })).max(20),
  condition: z.enum(['poor', 'fair', 'good', 'excellent', 'unknown']),
  conditionNotes: z.array(z.string().min(1).max(160)).max(12),
  identifiers: z.array(z.string()),
  identificationConfidence: z.number().min(0).max(1),
  visualEstimateLow: z.number().nonnegative().max(1_000_000).nullable(),
  visualEstimateHigh: z.number().nonnegative().max(1_000_000).nullable(),
  missingDetails: z.array(z.string()),
  requestedPhoto: z.string().nullable(),
});

export type Identification = z.infer<typeof identificationSchema>;

export const evidenceSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  detail: z.string(),
  price: z.number().nonnegative().optional(),
  shipping: z.number().nonnegative().optional(),
  kind: z.enum(['sold', 'active']),
  url: z.url(),
  matchScore: z.number().min(0).max(100),
  observedAt: z.iso.datetime(),
  imageUrl: z.url().optional(),
});

export type MarketEvidence = z.infer<typeof evidenceSchema>;

export type ValuationResult = {
  id: string;
  item: { name: string; details: string };
  identification: Identification;
  estimate: { low: number; high: number; currency: 'USD'; confidence: number };
  evidence: MarketEvidence[];
  disclosure: string;
};

export type ResearchResult = {
  status: 'research_only';
  id: string;
  item: { name: string; details: string };
  identification: Identification;
  estimate: {
    low: number;
    likely: number;
    high: number;
    currency: 'USD';
    confidence: number;
    basis: 'active_listings';
    sampleSize: number;
  } | null;
  evidence: MarketEvidence[];
  disclosure: string;
};
