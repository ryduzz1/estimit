CREATE TABLE IF NOT EXISTS installations (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS installations_active_token_idx
  ON installations (token_sha256)
  WHERE revoked_at IS NULL;

ALTER TABLE valuations
  ADD COLUMN IF NOT EXISTS installation_id uuid REFERENCES installations(id);

CREATE INDEX IF NOT EXISTS valuations_installation_created_idx
  ON valuations (installation_id, created_at DESC);
