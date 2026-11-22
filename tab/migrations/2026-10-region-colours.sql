-- Each region can carry one of the site's line colours: the quest
-- sheet's route disc and the rule along its top take it. Empty is red.
ALTER TABLE quest_regions ADD COLUMN colour TEXT NOT NULL DEFAULT '';
