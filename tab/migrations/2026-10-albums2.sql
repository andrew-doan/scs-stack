-- Albums, second part (see schema.sql). Named to sort after
-- 2026-10-albums.sql, which makes the tables. An album seen only by
-- those with its link, and its link's key; a video arriving in slices,
-- the encoder's progress on it, and the width and height the sender's
-- browser measured. The ALTERs fail harmlessly once the columns are
-- there.
ALTER TABLE albums ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN link_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_albums_link ON albums(link_key);
ALTER TABLE album_photos ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE album_photos ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE album_photos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE album_photos ADD COLUMN upload_id TEXT;
ALTER TABLE album_photos ADD COLUMN part_size INTEGER;
ALTER TABLE album_photos ADD COLUMN upload_token TEXT NOT NULL DEFAULT '';
ALTER TABLE album_photos ADD COLUMN encode_state TEXT NOT NULL DEFAULT '';
ALTER TABLE album_photos ADD COLUMN encode_claimed_at TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS album_upload_parts (
  photo_id INTEGER NOT NULL,
  part_n   INTEGER NOT NULL,
  etag     TEXT NOT NULL,
  PRIMARY KEY (photo_id, part_n)
);
