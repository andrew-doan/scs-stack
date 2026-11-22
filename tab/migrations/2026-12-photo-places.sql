-- Where a team's proof was taken, read from the photo's or video's own
-- metadata the first time the replay needs it, for a quest with several
-- places that its codes cannot choose between (recap.ts, photoPlaces).
-- lat and lng NULL: read, and the files carried no location. Only the
-- quest's nearest place is ever sent out, never these. No foreign key:
-- rows for submissions no longer accepted are cleared as new ones are
-- written and when a team is deleted. schema.sql already has the table
-- on a fresh database; run this only on an older one. npm run db:migrate
-- applies every file in this folder.

CREATE TABLE IF NOT EXISTS photo_places (
  submission_id INTEGER PRIMARY KEY,
  lat           REAL,
  lng           REAL,
  read_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
