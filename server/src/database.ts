import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { config } from './config.js';
import type { Identification, ValuationResult } from './domain.js';

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
