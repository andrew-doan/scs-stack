-- The payphone quest (src/phone.ts): a team calls the event's number
-- from a payphone and keys in its phone PIN, and the phone worker
-- reports the PIN and the caller's number here.
CREATE TABLE IF NOT EXISTS phone_pins (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id),
  pin     TEXT NOT NULL UNIQUE
);

-- Every number a capture has been tried from. state: 'new' until an
-- organiser has looked at it, 'ok' a payphone, 'no' not one.
CREATE TABLE IF NOT EXISTS payphones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  number     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per team and payphone. submission_id is the entry it made
-- on the tab; NULL while its payphone waits to be confirmed, or with
-- capped = 1 when the quest's code would take no more.
CREATE TABLE IF NOT EXISTS phone_captures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  payphone_id   INTEGER NOT NULL REFERENCES payphones(id),
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  call          TEXT NOT NULL DEFAULT '',
  submission_id INTEGER,
  capped        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, payphone_id)
);

-- Every call that reached a PIN. caller is a short hash of the number,
-- never the number: a mobile that calls by mistake is somebody's own.
CREATE TABLE IF NOT EXISTS phone_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  caller      TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',
  team_id     INTEGER,
  payphone_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_phone_calls_caller ON phone_calls (caller, at);

-- A message somebody recorded on the phone line. The audio is in the
-- bucket under r2_key; rec is the phone provider's id for it, so one
-- sent twice is kept once.
CREATE TABLE IF NOT EXISTS phone_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  rec         TEXT NOT NULL UNIQUE,
  call        TEXT NOT NULL DEFAULT '',
  node        TEXT NOT NULL DEFAULT '',
  team_id     INTEGER,
  payphone_id INTEGER,
  caller      TEXT NOT NULL DEFAULT '',
  r2_key      TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  heard       INTEGER NOT NULL DEFAULT 0
);
