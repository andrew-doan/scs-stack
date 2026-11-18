-- The albums merged into an album (albums.merges, see schema.sql): a
-- JSON list of their ids, '' for none. Fails harmlessly once the column
-- is there.
ALTER TABLE albums ADD COLUMN merges TEXT NOT NULL DEFAULT '';
