-- The line at the foot of an email announcement can be changed for a
-- send, and the send keeps what it was, so the rest of its queue goes
-- out the same way. NULL is the default line, '' is none.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE email_sends ADD COLUMN footer TEXT;
