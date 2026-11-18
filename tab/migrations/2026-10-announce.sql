-- Email announcements from the dashboard's Email tab. schema.sql
-- already has these on a fresh database; run this only on an older
-- one. npm run db:migrate applies every file in this folder.

-- One row per announcement: what it said and how far it has got.
CREATE TABLE IF NOT EXISTS email_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'text',
  body        TEXT NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'all',
  team_id     INTEGER,
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'sending',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- One row per address an announcement goes to, so each person is sent
-- their own copy, addressed to them alone, and nobody is sent two.
-- status: '' waiting, 'sending' while a batch has it, 'sent', 'failed'.
CREATE TABLE IF NOT EXISTS email_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id    INTEGER NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  error      TEXT NOT NULL DEFAULT '',
  UNIQUE (send_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_queue_send ON email_queue(send_id, status);
