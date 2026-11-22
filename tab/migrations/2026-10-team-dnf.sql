-- A team that did not finish: it stays on the leaderboard where its
-- points put it, with no place, and the teams under it move up one.
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE teams ADD COLUMN dnf INTEGER NOT NULL DEFAULT 0;
