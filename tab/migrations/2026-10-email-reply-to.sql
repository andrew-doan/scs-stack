-- An email announcement can say where replies go, and the send keeps
-- it, so the rest of its queue goes out the same way. NULL is the
-- worker's own EMAIL_REPLY_TO.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE email_sends ADD COLUMN reply_to TEXT;
