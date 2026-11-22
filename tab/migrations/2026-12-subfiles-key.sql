-- A proof file is looked up by its key on every thumbnail the edge does
-- not hold, and submission_files had an index on its submission alone,
-- so each lookup read the whole table.
CREATE INDEX IF NOT EXISTS idx_subfiles_key ON submission_files(r2_key);
