-- A test person is kept off the board, out of the scanner's list and
-- out of the counts. The tab worker decides who that is (a hidden team,
-- or a hidden signup with no team) and sets it through /api/hide.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE attendees ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
