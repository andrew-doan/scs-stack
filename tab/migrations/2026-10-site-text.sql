-- Words the dashboard sets on the public pages (site_text, see schema.sql).
CREATE TABLE IF NOT EXISTS site_text (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
