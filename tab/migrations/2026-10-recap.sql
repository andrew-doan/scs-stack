-- After the event: two switches the dashboard flips so the site can
-- open each team's page (the quests it did, from the leaderboard) and
-- the recap page (submissions by hour, when each quest was done, the
-- rest of the numbers). Both start off. schema.sql already has the
-- table on a fresh database; run this only on an older one.
-- npm run db:migrate applies every file in this folder.

CREATE TABLE IF NOT EXISTS site_flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
