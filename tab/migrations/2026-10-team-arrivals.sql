-- A team part-way checked in: how many of its people are in and when
-- the last of them arrived, from the check-in worker's reports. The
-- team page shows that time until the team is complete, when
-- team_checkins takes over. schema.sql has the table on a fresh database.
CREATE TABLE IF NOT EXISTS team_arrivals (
  team_name  TEXT PRIMARY KEY,
  last_at    TEXT NOT NULL,
  checked_in INTEGER NOT NULL DEFAULT 0,
  people     INTEGER NOT NULL DEFAULT 0
);
