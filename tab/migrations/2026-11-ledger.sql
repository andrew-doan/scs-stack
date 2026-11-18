-- The ledger (src/ledger.js): every change to a team's score is a line
-- in entries, and a team's score is the sum of its lines that are not
-- voided. An award is a batch of lines made by a rule rather than a
-- review: a challenge's places, a wager's settlement, the EOI.
--
-- The rest of this file fills the ledger in from what the tab already
-- holds, once: every statement after the tables runs only while the
-- ledger_seeded flag is unset, the first two clear anything a run that
-- stopped part way left behind, and the last sets the flag. Named 2026-11
-- so it runs after the migrations that added the columns it reads.
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  units       REAL NOT NULL DEFAULT 0,
  points      REAL NOT NULL DEFAULT 0,
  input       TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL,
  source_id   INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  made_by     TEXT NOT NULL DEFAULT '',
  made_at     TEXT NOT NULL DEFAULT (datetime('now')),
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  voided_by   TEXT,
  voided_at   TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_team ON entries (team_id, code);
CREATE INDEX IF NOT EXISTS idx_entries_code ON entries (code);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source_kind, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_once ON entries (source_kind, source_id, team_id, code) WHERE voided_at IS NULL AND source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS awards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  group_id    INTEGER,
  code        TEXT NOT NULL DEFAULT '',
  token       TEXT NOT NULL UNIQUE,
  basis       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  made_by     TEXT NOT NULL DEFAULT '',
  made_at     TEXT NOT NULL DEFAULT (datetime('now')),
  voided_by   TEXT,
  voided_at   TEXT,
  void_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_awards_once ON awards (kind, code) WHERE voided_at IS NULL;

DELETE FROM entries WHERE NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');
DELETE FROM awards WHERE NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

-- Accepted submissions, a line for each code their credit names: its
-- part mark, else its count, else the amount. A submission deleted before
-- a delete took the points off kept them, so its lines stay live too.
INSERT INTO entries (team_id, code, units, points, source_kind, source_id, note, made_by, made_at, at)
SELECT s.team_id, q.code, u.units, ROUND(u.units * q.points, 2), 'submission', s.id,
  CASE WHEN s.status = 'deleted' THEN 'Deleted, points kept' ELSE '' END,
  CASE WHEN s.added_by != '' THEN s.added_by ELSE COALESCE(s.reviewed_by, '') END,
  COALESCE(s.reviewed_at, s.submitted_at),
  CASE WHEN s.added_by != '' THEN s.submitted_at ELSE COALESCE(s.reviewed_at, s.submitted_at) END
FROM (
  SELECT s.id, j.value AS code,
    COALESCE(json_extract(s.credit, '$.amounts.' || json_quote(j.value)),
      json_extract(s.credit, '$.counts.' || json_quote(j.value)),
      json_extract(s.credit, '$.amount')) AS units
  FROM submissions s, json_each(CASE WHEN json_valid(s.credit) THEN s.credit ELSE '{}' END, '$.codes') j
  WHERE s.credit IS NOT NULL AND (s.status = 'accepted' OR (s.status = 'deleted' AND COALESCE(s.reason, '') != 'Taken back'))
) u JOIN submissions s ON s.id = u.id JOIN quests q ON q.code = u.code JOIN teams t ON t.id = s.team_id
WHERE u.units IS NOT NULL AND u.units != 0
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

-- Organisers' entries taken back: the same lines, voided.
INSERT INTO entries (team_id, code, units, points, source_kind, source_id, made_by, made_at, at, voided_by, voided_at, void_reason)
SELECT s.team_id, q.code, u.units, ROUND(u.units * q.points, 2), 'submission', s.id, s.added_by,
  s.submitted_at, s.submitted_at, '', COALESCE(s.reviewed_at, s.submitted_at), 'Taken back'
FROM (
  SELECT s.id, j.value AS code,
    COALESCE(json_extract(s.credit, '$.amounts.' || json_quote(j.value)),
      json_extract(s.credit, '$.counts.' || json_quote(j.value)),
      json_extract(s.credit, '$.amount')) AS units
  FROM submissions s, json_each(CASE WHEN json_valid(s.credit) THEN s.credit ELSE '{}' END, '$.codes') j
  WHERE s.credit IS NOT NULL AND s.status = 'deleted' AND s.reason = 'Taken back'
) u JOIN submissions s ON s.id = u.id JOIN quests q ON q.code = u.code JOIN teams t ON t.id = s.team_id
WHERE u.units IS NOT NULL AND u.units != 0
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

-- Challenges awarded and wagers settled, from the stamps that kept them,
-- each on the code its stamp names or else the quest's first code shown.
INSERT INTO awards (kind, group_id, code, token, basis, made_by, made_at)
SELECT 'challenge', g.id,
  COALESCE(json_extract(g.tally_settled, '$.code'),
    (SELECT code FROM quests WHERE group_id = g.id AND hidden = 0 ORDER BY sort, code LIMIT 1), 'quest-' || g.id),
  'seed-challenge-' || g.id, g.tally_settled,
  COALESCE(json_extract(g.tally_settled, '$.by'), ''), COALESCE(json_extract(g.tally_settled, '$.at'), datetime('now'))
FROM quest_groups g
WHERE g.tally_settled != '' AND json_valid(g.tally_settled)
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

INSERT INTO awards (kind, group_id, code, token, basis, made_by, made_at)
SELECT 'wager', g.id,
  COALESCE(json_extract(g.ask_settled, '$.code'),
    (SELECT code FROM quests WHERE group_id = g.id AND hidden = 0 ORDER BY sort, code LIMIT 1), 'quest-' || g.id),
  'seed-wager-' || g.id, g.ask_settled,
  COALESCE(json_extract(g.ask_settled, '$.by'), ''), COALESCE(json_extract(g.ask_settled, '$.at'), datetime('now'))
FROM quest_groups g
WHERE g.ask_settled != '' AND json_valid(g.ask_settled)
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

INSERT INTO entries (team_id, code, units, points, source_kind, source_id, made_by, made_at, at)
SELECT t.id, q.code, json_extract(j.value, '$[1]'), ROUND(json_extract(j.value, '$[1]') * q.points, 2), 'award', a.id,
  a.made_by, a.made_at, a.made_at
FROM awards a, json_each(CASE WHEN json_valid(a.basis) THEN a.basis ELSE '{}' END, '$.given') j
  JOIN quests q ON q.code = a.code JOIN teams t ON t.id = json_extract(j.value, '$[0]')
WHERE a.kind IN ('challenge', 'wager') AND json_extract(j.value, '$[1]') != 0
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

-- The EOI points the scheduled run used to keep counted, as one award.
INSERT INTO awards (kind, group_id, code, token, basis, made_by, made_at)
SELECT 'eoi', NULL, 'EOI', 'seed-eoi', '', 'migration', MAX(c.updated_at)
FROM completions c WHERE c.quest_code = 'EOI'
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded')
HAVING COUNT(*) > 0;

INSERT INTO entries (team_id, code, units, points, source_kind, source_id, made_by, made_at, at)
SELECT c.team_id, q.code, c.amount, ROUND(c.amount * q.points, 2), 'award', a.id, 'migration', c.updated_at, c.updated_at
FROM completions c JOIN quests q ON q.code = c.quest_code JOIN awards a ON a.token = 'seed-eoi'
WHERE c.quest_code = 'EOI'
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

-- Whatever the tab holds that nothing above explains — an award from
-- before awards kept what they gave, a score set before every change was
-- a submission — is written as a balance, so each team's lines add up to
-- exactly what it holds. Then the other way: lines on a code the tab
-- holds nothing on are brought back to nothing.
INSERT INTO entries (team_id, code, units, points, source_kind, note, made_by, made_at, at)
SELECT r.team_id, q.code, r.diff, ROUND(r.diff * q.points, 2), 'balance', 'From before the ledger', 'migration', datetime('now'), r.updated_at
FROM (
  SELECT c.team_id, c.quest_code, c.updated_at, c.amount - COALESCE((
    SELECT SUM(e.units) FROM entries e WHERE e.team_id = c.team_id AND e.code = c.quest_code AND e.voided_at IS NULL
  ), 0) AS diff FROM completions c
) r JOIN quests q ON q.code = r.quest_code JOIN teams t ON t.id = r.team_id
WHERE ABS(r.diff) > 0.000001
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded');

INSERT INTO entries (team_id, code, units, points, source_kind, note, made_by, made_at, at)
SELECT e.team_id, e.code, -SUM(e.units), -SUM(e.points), 'balance', 'From before the ledger', 'migration', datetime('now'), datetime('now')
FROM entries e
WHERE e.voided_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM completions c WHERE c.team_id = e.team_id AND c.quest_code = e.code)
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'ledger_seeded')
GROUP BY e.team_id, e.code
HAVING ABS(SUM(e.units)) > 0.000001;

INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1) ON CONFLICT(name) DO NOTHING;
