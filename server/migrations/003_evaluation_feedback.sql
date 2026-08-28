CREATE TABLE IF NOT EXISTS scan_evaluations (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  installation_id uuid REFERENCES installations(id),
  category text NOT NULL,
  item_form text NOT NULL,
  identification_confidence double precision NOT NULL CHECK (identification_confidence BETWEEN 0 AND 1),
  evidence_count integer NOT NULL CHECK (evidence_count >= 0),
  mean_match_score double precision,
  range_spread_ratio double precision,
  estimate_confidence integer CHECK (estimate_confidence BETWEEN 0 AND 100),
  has_estimate boolean NOT NULL,
  is_refinement boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS scan_evaluations_created_idx ON scan_evaluations (created_at DESC);
CREATE INDEX IF NOT EXISTS scan_evaluations_category_idx ON scan_evaluations (category, created_at DESC);

CREATE TABLE IF NOT EXISTS scan_feedback (
  id bigserial PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scan_evaluations(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES installations(id),
  identity_verdict text CHECK (identity_verdict IN ('confirmed', 'corrected', 'wrong')),
  price_verdict text CHECK (price_verdict IN ('low', 'fair', 'high')),
  relative_error_ratio double precision CHECK (relative_error_ratio BETWEEN -10 AND 10),
  range_hit boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, installation_id),
  CHECK (identity_verdict IS NOT NULL OR price_verdict IS NOT NULL OR relative_error_ratio IS NOT NULL),
  CHECK ((relative_error_ratio IS NULL) = (range_hit IS NULL))
);

CREATE INDEX IF NOT EXISTS scan_feedback_created_idx ON scan_feedback (created_at DESC);
