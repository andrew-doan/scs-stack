-- Each person accepts the terms and waiver themselves, from a link in
-- their own confirmation email. Before this, whoever filled in the form
-- ticked a box on every teammate's behalf, which recorded nothing about
-- whether any of them had agreed.
--
-- terms_key is the secret in that person's link; terms_at is when they
-- accepted, NULL until they do.
--
-- schema.sql has both columns on a fresh database. The ALTERs fail once
-- they are there, which is the signal they have already run.
ALTER TABLE participants ADD COLUMN terms_key TEXT;
ALTER TABLE participants ADD COLUMN terms_at TEXT;

-- People registered before this get a link too, so a resent
-- confirmation can carry one. Safe to run again: it only fills blanks.
UPDATE participants SET terms_key = lower(hex(randomblob(18))) WHERE terms_key IS NULL;
