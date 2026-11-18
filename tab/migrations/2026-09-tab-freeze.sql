-- The tab freeze, for databases made before it existed. Safe to re-run.
CREATE TABLE IF NOT EXISTS tab_freeze (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  frozen    INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT,
  snapshot  TEXT
);
