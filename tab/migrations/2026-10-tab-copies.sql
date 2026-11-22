-- Closing the tab: the public standings answer that it is closed and
-- nothing else, on top of a freeze or not.
ALTER TABLE tab_freeze ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tab_freeze ADD COLUMN closed_at TEXT;

-- Saved copies of the public standings: one at every freeze, one each
-- hour the standings moved, and any an organiser saves.
CREATE TABLE IF NOT EXISTS tab_snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'hand',
  taken_by  TEXT NOT NULL DEFAULT '',
  digest    TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '{}',
  snapshot  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tab_snapshots_taken ON tab_snapshots (taken_at);
