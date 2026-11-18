-- Team names are unique whatever their case. The UNIQUE on teams.name
-- is case-sensitive, while sign-in, Discord, the recap and check-in all
-- find a team by its name ignoring case, and every writer checks for a
-- clash in a statement of its own before writing, so two sign-ups as
-- Foo and foo at the same moment both went in.
-- This fails, changing nothing, while two teams differ only by case:
-- rename one of them first. Find them with
-- SELECT name FROM teams WHERE name IN (SELECT name FROM teams GROUP BY name COLLATE NOCASE HAVING COUNT(*) > 1)
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_nocase ON teams (name COLLATE NOCASE);
