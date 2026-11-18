-- The route each team recorded for the GPS quest, cleaned on the
-- dashboard's Routes tab and saved here for the replay (src/tracks.ts).
-- No foreign key on team_id: a team is deleted in one batch and its
-- route after it. schema.sql already has the table on a fresh database;
-- run this only on an older one. npm run db:migrate applies every file
-- in this folder.

CREATE TABLE IF NOT EXISTS team_tracks (
  team_id    INTEGER PRIMARY KEY,
  route      TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  ended_at   TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  gpx_key    TEXT NOT NULL DEFAULT '',
  edits      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  saved_at   TEXT NOT NULL DEFAULT (datetime('now')),
  saved_by   TEXT NOT NULL DEFAULT ''
);
