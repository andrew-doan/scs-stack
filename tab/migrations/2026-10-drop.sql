-- Files OrgComm shares without attaching them to anything, and the
-- short links that point at them. schema.sql already has both on a
-- fresh database; run this only on an older one. npm run db:migrate
-- applies every file in this folder.

CREATE TABLE IF NOT EXISTS drop_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,            -- R2 key under drop/
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',        -- what it is, for whoever finds it later
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

-- go.<domain>/<slug>. kind='file' serves the bytes at that address;
-- kind='url' redirects. A file link serves rather than redirects
-- because an unfurler that has to follow a hop is one more way for an
-- embed to fail.
CREATE TABLE IF NOT EXISTS short_links (
  slug       TEXT PRIMARY KEY,                -- lower case, what goes after the slash
  kind       TEXT NOT NULL DEFAULT 'url',     -- url / file
  target     TEXT NOT NULL DEFAULT '',        -- where a url link goes
  file_key   TEXT NOT NULL DEFAULT '',        -- drop_files.key, for a file link
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_short_links_file ON short_links(file_key);
