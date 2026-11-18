-- Photo albums for the site's /albums page (see schema.sql).
CREATE TABLE IF NOT EXISTS albums (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  about      TEXT NOT NULL DEFAULT '',
  adding     TEXT NOT NULL DEFAULT 'teams',
  gallery    INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS album_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id     INTEGER NOT NULL REFERENCES albums(id),
  r2_key       TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL DEFAULT '',
  team_id      INTEGER,
  added_by     TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_album_photos_album ON album_photos(album_id, id);
CREATE INDEX IF NOT EXISTS idx_album_photos_ip ON album_photos(ip, added_at);
CREATE TABLE IF NOT EXISTS album_skips (
  album_id INTEGER NOT NULL,
  r2_key   TEXT NOT NULL,
  PRIMARY KEY (album_id, r2_key)
);
