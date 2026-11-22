-- A quest whose points the site does not show: every code reads ???
-- on the quest list, the sheet and the submit page. The tab scores its
-- codes as it scores any other.
ALTER TABLE quest_groups ADD COLUMN mystery INTEGER NOT NULL DEFAULT 0;
