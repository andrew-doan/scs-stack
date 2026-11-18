-- The proof videos as teams sent them, as the dashboard's Original videos
-- card downloads and then deletes them (originals.ts). A row is written
-- when a download sends a video's original whole (saved_at) and stamped
-- when the original is deleted from the bucket (gone_at); the copies the
-- encoder made stay and are what every page plays. No foreign key: keyed
-- by submission_files.r2_key, and a row whose file has gone with its
-- submission is ignored. schema.sql already has the table on a fresh
-- database; run this only on an older one. npm run db:migrate applies
-- every file in this folder.

CREATE TABLE IF NOT EXISTS video_originals (
  r2_key   TEXT PRIMARY KEY,
  bytes    INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  gone_at  TEXT,
  gone_by  TEXT NOT NULL DEFAULT ''
);
