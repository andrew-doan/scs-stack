-- An album photo an organiser replaced in place (album_photos.version,
-- see schema.sql): how many times, so its addresses change with it and
-- nothing cached keeps the old picture. And a photo sent in slices to
-- replace another (album_photos.replaces): the id of the photo it is
-- for. Each ALTER fails harmlessly once its column is there.
ALTER TABLE album_photos ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE album_photos ADD COLUMN replaces INTEGER NOT NULL DEFAULT 0;
