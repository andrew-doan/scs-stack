-- SCS.2 scores database (Cloudflare D1).
-- The tab's model, kept as-is: every quest is worth `points` per unit,
-- and a team's entry for a quest is an `amount` — 1 for a normal
-- completion, higher counts for repeatables (Make 21), fractions for
-- partial credit (0.25 of MQ3), 0 for judged-but-no-credit. A team's
-- total is simply SUM(amount * points).

CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS quests (
  code   TEXT PRIMARY KEY,       -- as written on the tab: MQ1, S22-Burwood, Make 21
  norm   TEXT NOT NULL UNIQUE,   -- lookup key: uppercased, no spaces or hyphens
  points REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS completions (
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  quest_code TEXT NOT NULL REFERENCES quests(code),
  amount     REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, quest_code)
);

CREATE INDEX IF NOT EXISTS idx_completions_quest ON completions(quest_code);
