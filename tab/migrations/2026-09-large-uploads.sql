-- Large proof files upload in slices: file rows carry an uploading
-- status and the R2 multipart bookkeeping, and landed slices are kept
-- for resume. For databases created before large uploads; the ALTERs
-- fail once the columns exist (same caveat as the other migrations —
-- schema.sql already has them on a fresh database).
ALTER TABLE submission_files ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE submission_files ADD COLUMN upload_id TEXT;
ALTER TABLE submission_files ADD COLUMN part_size INTEGER;
CREATE TABLE IF NOT EXISTS submission_upload_parts (
  file_id INTEGER NOT NULL REFERENCES submission_files(id),
  part_n  INTEGER NOT NULL,
  etag    TEXT NOT NULL,
  PRIMARY KEY (file_id, part_n)
);
