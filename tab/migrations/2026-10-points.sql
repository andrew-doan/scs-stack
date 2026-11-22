-- Points an organiser records are a submission like a team's, already
-- accepted, so every change to a score has a row behind it: who
-- recorded it, and what it put on the tab, which is what taking it back
-- takes off.
ALTER TABLE submissions ADD COLUMN added_by TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN credit TEXT;

-- The quests an account may score, by quest key; empty is every quest.
ALTER TABLE console_users ADD COLUMN quests TEXT NOT NULL DEFAULT '';
