-- Dashboard files on their way straight to R2 (see schema.sql).
CREATE TABLE IF NOT EXISTS staged_uploads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key       TEXT NOT NULL UNIQUE,
  upload_id    TEXT,
  purpose      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  part_size    INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'uploading',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staged_uploads_created ON staged_uploads(created_at);
