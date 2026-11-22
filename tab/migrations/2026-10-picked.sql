-- The HEIC or WebP a photo was picked as, kept beside the JPEG the page
-- made of it at <key>.p (see schema.sql): its type, '' when none was
-- kept. Each ALTER fails harmlessly once its column is there.
ALTER TABLE submission_files ADD COLUMN picked_type TEXT NOT NULL DEFAULT '';
ALTER TABLE album_photos ADD COLUMN picked_type TEXT NOT NULL DEFAULT '';
