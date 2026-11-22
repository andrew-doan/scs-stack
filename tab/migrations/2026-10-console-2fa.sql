-- The dashboard's second factor, the codes that stand in for it, and
-- the attempts the throttle and the Security card both read.
--
-- console_attempts is a table of its own rather than a query over
-- submission_log: the throttle asks "how many failures from this
-- address in the last quarter of an hour", which needs an index on the
-- address, and the log's columns are a scoring audit that happens to
-- have somewhere to put one. Both are written — the Log tab is what an
-- organiser reads, this is what the code reads.
CREATE TABLE IF NOT EXISTS console_users (
  name         TEXT PRIMARY KEY,
  secret       TEXT NOT NULL,
  confirmed_at TEXT,
  last_step    INTEGER NOT NULL DEFAULT 0,
  last_seen    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS console_backup_codes (
  name      TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at   TEXT,
  PRIMARY KEY (name, code_hash)
);

CREATE TABLE IF NOT EXISTS console_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  name    TEXT NOT NULL DEFAULT '',
  ip      TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_console_attempts_at ON console_attempts (at DESC);
CREATE INDEX IF NOT EXISTS idx_console_attempts_ip ON console_attempts (ip, at DESC);
