-- An album photo pointed at another photo in the same album
-- (album_photos.points_to, see schema.sql). Fails harmlessly once the
-- column is there.
ALTER TABLE album_photos ADD COLUMN points_to TEXT NOT NULL DEFAULT '';
