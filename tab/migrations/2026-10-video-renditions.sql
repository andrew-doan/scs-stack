-- Video renditions: the smaller copies of a proof video that the
-- encoder on an organiser's laptop makes, and the state of the runner
-- that makes them. For databases created before any of it existed. The
-- CREATEs are safe to re-run; the ALTERs fail once the columns are
-- there (same caveat as the other migrations — schema.sql already has
-- them on a fresh database, so run this only on an older one).
-- npm run db:migrate applies every file in this folder.
CREATE TABLE IF NOT EXISTS submission_renditions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key   TEXT NOT NULL,
  height     INTEGER NOT NULL,
  key        TEXT NOT NULL UNIQUE,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_key, height)
);
CREATE INDEX IF NOT EXISTS idx_renditions_file ON submission_renditions(file_key);
CREATE TABLE IF NOT EXISTS encoders (
  name       TEXT PRIMARY KEY,
  last_seen  TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '',
  working_on TEXT NOT NULL DEFAULT '',
  jobs_done  INTEGER NOT NULL DEFAULT 0,
  encode_ms  INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE submission_files ADD COLUMN encode_state TEXT NOT NULL DEFAULT '';
ALTER TABLE submission_files ADD COLUMN encode_claimed_at TEXT NOT NULL DEFAULT '';
