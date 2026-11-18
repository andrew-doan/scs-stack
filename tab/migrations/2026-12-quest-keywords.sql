-- Tags teams can search a quest by and see on its sheet: comma
-- separated words the organisers type. Not the organisers' own tags
-- (quest_tags), which decide what opens together and are never public.
ALTER TABLE quest_groups ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
