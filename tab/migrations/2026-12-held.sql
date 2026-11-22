-- What each team holds on each code, read off the ledger rather than
-- kept as a copy (schema.sql says what it is). Every reader of the tab
-- reads this; `completions` is left as it was and nothing writes it.
CREATE VIEW IF NOT EXISTS held AS
  SELECT e.team_id AS team_id, e.code AS quest_code, SUM(e.units) AS amount, MAX(e.at) AS updated_at
  FROM entries e
  WHERE e.voided_at IS NULL AND e.team_id IN (SELECT id FROM teams) AND e.code IN (SELECT code FROM quests)
  GROUP BY e.team_id, e.code
  HAVING ABS(SUM(e.units)) > 0.000001;
