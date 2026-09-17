-- D1 schema for the ADS-B relay (see README, "Relay").
-- Apply with: npx wrangler d1 execute flysdown-relay --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS wanted (
  region       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  radius_nm    REAL NOT NULL,
  requested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS wanted_requested_at ON wanted (requested_at);

CREATE TABLE IF NOT EXISTS snapshots (
  region     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  radius_nm  REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  source     TEXT,
  count      INTEGER,
  payload    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_updated_at ON snapshots (updated_at);
