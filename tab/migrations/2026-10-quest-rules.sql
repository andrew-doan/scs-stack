-- What a quest's submit form takes, how a challenge is counted, and
-- what teams see of a live question's answers (see schema.sql).
ALTER TABLE quest_groups ADD COLUMN rules TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_groups ADD COLUMN tally_settled TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_groups ADD COLUMN ask_reveal TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_groups ADD COLUMN ask_reveal_live INTEGER NOT NULL DEFAULT 0;
