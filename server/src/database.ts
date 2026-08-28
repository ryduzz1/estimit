import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { config } from './config.js';
import type { Identification, ResearchResult, ValuationResult } from './domain.js';

const sql = config.DATABASE_URL ? postgres(config.DATABASE_URL, { max: 5 }) : null;

export async function initializeDatabase() {
  if (!sql) return;
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationsUrl)).filter((file) => file.endsWith('.sql')).sort();
  for (const migration of migrations) await sql.unsafe(await readFile(new URL(migration, migrationsUrl), 'utf8'));
}

export async function createInstallation(id: string, tokenSha256: string, metadata: Record<string, string>) {
  if (!sql) throw new Error('Installation registration requires a database.');
  await sql`INSERT INTO installations (id, token_sha256, metadata) VALUES (${id}, ${tokenSha256}, ${sql.json(metadata)})`;
}

export async function authenticateInstallation(tokenSha256: string): Promise<string | null> {
  if (!sql) return null;
  const rows = await sql<{ id: string }[]>`
    UPDATE installations SET last_seen_at = now()
    WHERE token_sha256 = ${tokenSha256} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

export async function databaseIsReady() {
  if (!sql) return false;
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function saveValuation(imageSha256: string, identity: Identification, result: ValuationResult, installationId?: string) {
  if (!sql) return;
  await sql`
    INSERT INTO valuations (id, image_sha256, identification, estimate, evidence, installation_id)
    VALUES (${result.id}, ${imageSha256}, ${sql.json(identity)}, ${sql.json(result.estimate)}, ${sql.json(result.evidence)}, ${installationId ?? null})
  `;
}

export async function recordScanEvaluation(result: ValuationResult | ResearchResult, installationId?: string, isRefinement = false) {
  if (!sql) return;
  const pricedEvidence = result.evidence.filter((entry) => typeof entry.price === 'number');
  const meanMatchScore = result.evidence.length > 0
    ? result.evidence.reduce((sum, entry) => sum + entry.matchScore, 0) / result.evidence.length
    : null;
  const estimate = result.estimate;
  const center = 'status' in result
    ? result.estimate?.likely ?? null
    : (result.estimate.low + result.estimate.high) / 2;
  const rangeSpreadRatio = estimate && center ? (estimate.high - estimate.low) / Math.max(1, center) : null;
  await sql`
    INSERT INTO scan_evaluations (
      id, installation_id, category, item_form, identification_confidence,
      evidence_count, mean_match_score, range_spread_ratio, estimate_confidence, has_estimate, is_refinement
    ) VALUES (
      ${result.id}, ${installationId ?? null}, ${result.identification.category.slice(0, 120)},
      ${result.identification.itemForm}, ${result.identification.identificationConfidence},
      ${pricedEvidence.length}, ${meanMatchScore}, ${rangeSpreadRatio}, ${estimate?.confidence ?? null}, ${estimate !== null}, ${isRefinement}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function recordScanFeedback(
  scanId: string,
  installationId: string,
  feedback: {
    identityVerdict?: 'confirmed' | 'corrected' | 'wrong';
    priceVerdict?: 'low' | 'fair' | 'high';
    relativeErrorRatio?: number;
    rangeHit?: boolean;
  },
) {
  if (!sql) return false;
  const rows = await sql<{ id: number }[]>`
    INSERT INTO scan_feedback (scan_id, installation_id, identity_verdict, price_verdict, relative_error_ratio, range_hit)
    SELECT id, ${installationId}, ${feedback.identityVerdict ?? null}, ${feedback.priceVerdict ?? null},
      ${'relativeErrorRatio' in feedback ? feedback.relativeErrorRatio ?? null : null},
      ${'rangeHit' in feedback ? feedback.rangeHit ?? null : null}
    FROM scan_evaluations
    WHERE id = ${scanId} AND installation_id = ${installationId}
    ON CONFLICT (scan_id, installation_id) DO UPDATE SET
      identity_verdict = COALESCE(EXCLUDED.identity_verdict, scan_feedback.identity_verdict),
      price_verdict = COALESCE(EXCLUDED.price_verdict, scan_feedback.price_verdict),
      relative_error_ratio = COALESCE(EXCLUDED.relative_error_ratio, scan_feedback.relative_error_ratio),
      range_hit = COALESCE(EXCLUDED.range_hit, scan_feedback.range_hit),
      updated_at = now()
    RETURNING scan_feedback.id
  `;
  return rows.length > 0;
}

export async function getEvaluationSummary() {
  if (!sql) throw new Error('Evaluation reporting requires a database.');
  const [overall] = await sql<{
    totalScans: number;
    scansWithEstimate: number;
    averageIdentityConfidence: number | null;
    averageEvidenceCount: number | null;
    averageEstimateConfidence: number | null;
    identityConfirmed: number;
    identityCorrected: number;
    identityWrong: number;
    priceLow: number;
    priceFair: number;
    priceHigh: number;
    numericPriceChecks: number;
    meanAbsolutePercentageError: number | null;
    rangeCoverage: number | null;
  }[]>`
    SELECT
      count(e.id) FILTER (WHERE NOT e.is_refinement)::int AS "totalScans",
      count(e.id) FILTER (WHERE e.has_estimate AND NOT e.is_refinement)::int AS "scansWithEstimate",
      avg(e.identification_confidence) FILTER (WHERE NOT e.is_refinement)::float8 AS "averageIdentityConfidence",
      avg(e.evidence_count) FILTER (WHERE NOT e.is_refinement)::float8 AS "averageEvidenceCount",
      avg(e.estimate_confidence) FILTER (WHERE e.has_estimate AND NOT e.is_refinement)::float8 AS "averageEstimateConfidence",
      count(f.id) FILTER (WHERE f.identity_verdict = 'confirmed' AND NOT e.is_refinement)::int AS "identityConfirmed",
      count(f.id) FILTER (WHERE f.identity_verdict = 'corrected' AND NOT e.is_refinement)::int AS "identityCorrected",
      count(f.id) FILTER (WHERE f.identity_verdict = 'wrong' AND NOT e.is_refinement)::int AS "identityWrong",
      count(f.id) FILTER (WHERE f.price_verdict = 'low')::int AS "priceLow",
      count(f.id) FILTER (WHERE f.price_verdict = 'fair')::int AS "priceFair",
      count(f.id) FILTER (WHERE f.price_verdict = 'high')::int AS "priceHigh",
      count(f.id) FILTER (WHERE f.relative_error_ratio IS NOT NULL)::int AS "numericPriceChecks",
      (avg(abs(f.relative_error_ratio)) FILTER (WHERE f.relative_error_ratio IS NOT NULL) * 100)::float8 AS "meanAbsolutePercentageError",
      (avg(CASE WHEN f.range_hit THEN 1.0 ELSE 0.0 END) FILTER (WHERE f.range_hit IS NOT NULL) * 100)::float8 AS "rangeCoverage"
    FROM scan_evaluations e
    LEFT JOIN scan_feedback f ON f.scan_id = e.id
  `;
  const categories = await sql<{
    category: string;
    scans: number;
    estimable: number;
    identityConfirmed: number;
    identityCorrected: number;
    priceFair: number;
  }[]>`
    SELECT
      e.category,
      count(e.id) FILTER (WHERE NOT e.is_refinement)::int AS scans,
      count(e.id) FILTER (WHERE e.has_estimate AND NOT e.is_refinement)::int AS estimable,
      count(f.id) FILTER (WHERE f.identity_verdict = 'confirmed' AND NOT e.is_refinement)::int AS "identityConfirmed",
      count(f.id) FILTER (WHERE f.identity_verdict = 'corrected' AND NOT e.is_refinement)::int AS "identityCorrected",
      count(f.id) FILTER (WHERE f.price_verdict = 'fair')::int AS "priceFair"
    FROM scan_evaluations e
    LEFT JOIN scan_feedback f ON f.scan_id = e.id
    GROUP BY e.category
    ORDER BY scans DESC, e.category
    LIMIT 50
  `;
  return { generatedAt: new Date().toISOString(), overall, categories };
}

export async function getValuation(id: string, installationId?: string): Promise<ValuationResult | null> {
  if (!sql) return null;
  const rows = await sql<{
    id: string;
    identification: Identification;
    estimate: ValuationResult['estimate'];
    evidence: ValuationResult['evidence'];
  }[]>`SELECT id, identification, estimate, evidence FROM valuations
    WHERE id = ${id} AND (${installationId ?? null}::uuid IS NULL OR installation_id = ${installationId ?? null})`;
  const row = rows[0];
  if (!row) return null;
  return calculateStoredResult(row.id, row.identification, row.estimate, row.evidence);
}

function calculateStoredResult(id: string, identity: Identification, estimate: ValuationResult['estimate'], evidence: ValuationResult['evidence']): ValuationResult {
  return {
    id,
    item: {
      name: `${identity.brand} ${identity.model}`.trim(),
      details: [identity.variant, `${identity.condition[0]!.toUpperCase()}${identity.condition.slice(1)} condition`].filter(Boolean).join(' · '),
    },
    identification: identity,
    estimate,
    evidence,
    disclosure: 'Sold evidence supports the estimate; active listings are market context only.',
  };
}

export async function closeDatabase() {
  await sql?.end();
}
