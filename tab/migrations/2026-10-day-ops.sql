-- Running the day: a claim on a submission under review, a time on a
-- message so it publishes itself, and a deadline on the question a
-- quest asks. For databases made before any of it existed. The ALTERs
-- fail once the columns are there (same caveat as the other
-- migrations — schema.sql already has them on a fresh database, so run
-- this only on an older one).
-- npm run db:migrate applies every file in this folder.

-- Who is reviewing a submission right now. Advice between reviewers,
-- not a lock: it goes stale after ten minutes, and accepting or
-- rejecting clears it. The reason a rejection carries already lives in
-- submissions.reason.
ALTER TABLE submissions ADD COLUMN claimed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';

-- When a message written ahead of time should appear (UTC). It is
-- saved hidden and the first public read after that time publishes it.
ALTER TABLE messages ADD COLUMN publish_at TEXT NOT NULL DEFAULT '';

-- When a quest's question stops taking answers (UTC). Nothing writes
-- to it at the deadline: the question reads as closed once the time
-- has passed.
ALTER TABLE quest_groups ADD COLUMN ask_open_until TEXT NOT NULL DEFAULT '';
