-- Each code of a quest is a part with a scoring type (src/parts.js):
-- '' fixed, unit, judged, tiered or counted. `most` caps a per-unit
-- count and `bands` holds the bands of a tiered or counted part as JSON
-- [{from, points}].
ALTER TABLE quests ADD COLUMN scoring TEXT NOT NULL DEFAULT '';
ALTER TABLE quests ADD COLUMN most REAL;
ALTER TABLE quests ADD COLUMN bands TEXT NOT NULL DEFAULT '';

-- The tab sums what each line was worth when it was written, so `held`
-- carries the points beside the amount.
DROP VIEW IF EXISTS held;
CREATE VIEW held AS
  SELECT e.team_id AS team_id, e.code AS quest_code, SUM(e.units) AS amount, ROUND(SUM(e.points), 2) AS points, MAX(e.at) AS updated_at
  FROM entries e
  WHERE e.voided_at IS NULL AND e.team_id IN (SELECT id FROM teams) AND e.code IN (SELECT code FROM quests)
  GROUP BY e.team_id, e.code
  HAVING ABS(SUM(e.units)) > 0.000001 OR ABS(SUM(e.points)) > 0.000001;

-- A first pass at the types, for a human to check on the Quests tab:
-- the codes of a quest that took part marks are judged, and a code
-- labelled "Per ..." or already credited more than once in one result
-- is per unit. Everything else stays fixed.
UPDATE quests SET scoring = 'judged'
  WHERE scoring = '' AND group_id IN (SELECT id FROM quest_groups WHERE json_valid(rules) AND json_extract(rules, '$.partial') = 1);
UPDATE quests SET scoring = 'unit'
  WHERE scoring = '' AND (label LIKE 'Per %' OR code IN (
    SELECT code FROM entries WHERE voided_at IS NULL AND source_kind = 'submission' AND units > 1
  ));
