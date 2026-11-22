-- The link page at go.<domain>/ (src/linkpage.ts), set on the Files tab:
-- links, headings between them and social icons in one ordered list,
-- each link's clicks, and a count a day for the page and each link
-- (item 0 is the page's views). Numbers only: no address, no referrer.
-- schema.sql already has the tables on a fresh database; run this only on
-- an older one. npm run db:migrate applies every file in this folder.
CREATE TABLE IF NOT EXISTS link_page_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'link',
  label      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  icon       TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  featured   INTEGER NOT NULL DEFAULT 0,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS link_page_days (
  day     TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, item_id)
);
