CREATE TABLE IF NOT EXISTS bills (
  id            BIGSERIAL PRIMARY KEY,
  file_name     TEXT,
  file_hash     TEXT,
  status        TEXT NOT NULL DEFAULT 'extracted', -- extracted | drafted | failed
  extracted     JSONB,
  submitted     JSONB,
  odoo_move_id  INTEGER,
  odoo_url      TEXT,
  ai_model      TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bills_created_idx ON bills (created_at DESC);
CREATE INDEX IF NOT EXISTS bills_hash_idx ON bills (file_hash);

-- Remembers which account you used for a vendor so the next bill is pre-filled.
CREATE TABLE IF NOT EXISTS vendor_accounts (
  partner_id   INTEGER NOT NULL,
  account_id   INTEGER NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 1,
  last_used    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, account_id)
);
