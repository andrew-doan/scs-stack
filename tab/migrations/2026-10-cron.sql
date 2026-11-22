-- Work the worker finishes on its own clock rather than when somebody
-- happens to load a page. schema.sql already has these on a fresh
-- database; run this only on an older one. npm run db:migrate applies
-- every file in this folder.

-- An announcement that did not reach everyone in one request. The save
-- sends the first batch itself and leaves the rest here with a cursor;
-- the scheduled run takes one batch a minute until the cursor passes
-- the last subscriber, then deletes the row. Nobody retypes a message
-- and nobody is notified twice.
CREATE TABLE IF NOT EXISTS push_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL DEFAULT '',
  renotify   INTEGER NOT NULL DEFAULT 1,
  urgency    TEXT NOT NULL DEFAULT 'high',
  topic      TEXT NOT NULL DEFAULT '',
  after_id   INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- How many times the scheduled run has tried to email this person
-- their ticket. A confirmation that fails is retried a few times and
-- then left alone: an address that will never accept mail must not be
-- tried once a minute for the rest of the event.
ALTER TABLE participants ADD COLUMN email_tries INTEGER NOT NULL DEFAULT 0;
