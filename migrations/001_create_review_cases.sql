CREATE TABLE review_cases (
  id UUID PRIMARY KEY,
  order_id TEXT NOT NULL,
  evidence_version TEXT NOT NULL CHECK (evidence_version ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (order_id, evidence_version)
);
