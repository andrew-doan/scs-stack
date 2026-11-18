-- The order an album opens in (albums.photo_order, see schema.sql):
-- 'added' or 'taken'. Fails harmlessly once the column is there.
ALTER TABLE albums ADD COLUMN photo_order TEXT NOT NULL DEFAULT 'added';
