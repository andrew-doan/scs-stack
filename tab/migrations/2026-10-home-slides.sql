-- The pictures the home page runs as a slideshow: the file in R2, what
-- it shows, an optional caption and the order they play in. schema.sql
-- already has the table on a fresh database; run this only on an older
-- one. npm run db:migrate applies every file in this folder.

CREATE TABLE IF NOT EXISTS home_slides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,            -- R2 key under slide/
  name       TEXT NOT NULL DEFAULT '',        -- the file's own name, as uploaded
  type       TEXT NOT NULL DEFAULT '',        -- needed to decide what may be served small
  bytes      INTEGER NOT NULL DEFAULT 0,
  alt        TEXT NOT NULL DEFAULT '',        -- what the picture shows; never empty in practice
  caption    TEXT NOT NULL DEFAULT '',        -- printed under the picture, optional
  sort       INTEGER NOT NULL DEFAULT 0,      -- display order, lowest first
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_home_slides_sort ON home_slides(sort, id);
