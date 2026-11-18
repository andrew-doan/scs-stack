-- A quest's submit form can ask more than one question. The first stays
-- in submit_kind / prompt / options; this holds the whole list when
-- there is more than one, and '' otherwise.
ALTER TABLE quest_groups ADD COLUMN questions TEXT NOT NULL DEFAULT '';
