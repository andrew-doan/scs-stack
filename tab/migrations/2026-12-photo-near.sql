-- The places a proof photo or video was taken at, read once from the
-- file's own metadata for a quest the dashboard's Recap card shows photo
-- by photo (visits.ts): the stations on the submit page's list within
-- reach of where it was taken, and the quest's own places within reach,
-- each nearest first as a JSON list ('[]' when the file carried no
-- location or nothing was near). The location itself is not kept. No
-- foreign key: rows for files that have gone are cleared as new ones are
-- written, and a quest's rows when its setting changes. schema.sql
-- already has the table on a fresh database; run this only on an older
-- one. npm run db:migrate applies every file in this folder.

CREATE TABLE IF NOT EXISTS photo_near (
  file_id  INTEGER PRIMARY KEY,
  stations TEXT NOT NULL DEFAULT '[]',
  places   TEXT NOT NULL DEFAULT '[]',
  read_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
