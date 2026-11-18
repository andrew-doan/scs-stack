-- Each person answers the photo question themselves, on the terms page
-- their confirmation email links to. The sign-up form asks it once, of
-- whoever fills it in, for everybody on it.
--
-- photo_ok: 1 yes, 0 no, NULL not answered yet.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE participants ADD COLUMN photo_ok INTEGER;
