-- A wager remembers that it has been settled. Before this, settling
-- one twice — a second press, a retried request, a different winner
-- picked afterwards — paid every stake again.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE quest_groups ADD COLUMN ask_settled TEXT NOT NULL DEFAULT '';
