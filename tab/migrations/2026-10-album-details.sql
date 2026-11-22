-- Photo details on albums (see schema.sql). An album that shows when,
-- where and on what each photo was taken, and hands out the original;
-- off for the albums already made, on for new ones from the dashboard.
-- And when each album upload and proof file was taken, read from the
-- photo or the video at upload, or by the dashboard's rebuild for files
-- from before: '' when the file does not say, null when nothing has
-- looked yet. Each ALTER fails harmlessly once its column is there.
ALTER TABLE albums ADD COLUMN details INTEGER NOT NULL DEFAULT 0;
ALTER TABLE album_photos ADD COLUMN taken_at TEXT;
ALTER TABLE submission_files ADD COLUMN taken_at TEXT;
