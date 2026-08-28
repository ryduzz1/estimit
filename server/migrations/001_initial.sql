CREATE TABLE IF NOT EXISTS valuations (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  image_sha256 text NOT NULL,
  identification jsonb NOT NULL,
  estimate jsonb NOT NULL,
  evidence jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS valuations_created_at_idx ON valuations (created_at DESC);
