-- People who filled in the expression of interest. Each one on a team
-- earns that team the EOI award (src/eoi.js).
CREATE TABLE IF NOT EXISTS eoi_people (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  zid   TEXT NOT NULL DEFAULT ''
);
