-- The teams whose gallery submissions an album shows when it does not
-- show the whole gallery (see schema.sql).
CREATE TABLE IF NOT EXISTS album_teams (
  album_id INTEGER NOT NULL,
  team_id  INTEGER NOT NULL,
  PRIMARY KEY (album_id, team_id)
);
