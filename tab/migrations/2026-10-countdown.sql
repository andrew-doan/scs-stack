-- The countdown on the home page becomes a run of stops the dashboard
-- holds: the day starting, submissions closing, the ceremony. The page
-- counts to the first one still ahead and moves to the next as each
-- passes. Empty, the page keeps the date built into its own markup.
-- schema.sql already has the table on a fresh database; run this only
-- on an older one. npm run db:migrate applies every file in this folder.

CREATE TABLE IF NOT EXISTS countdown_stops (
  sort  INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  at    TEXT NOT NULL DEFAULT ''
);
