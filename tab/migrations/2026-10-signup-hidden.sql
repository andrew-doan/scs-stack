-- A signup with nobody yet in a team can be marked as a test, the way a
-- team can (teams.hidden): off the public sign-up count, out of email
-- announcements, and out of the dashboard while its hide switch is on.
-- Once the people on it are in a team, the team's flag is the one that
-- counts.
--
-- schema.sql has the column on a fresh database. The ALTER fails once
-- it is there, which is the signal it has already run.
ALTER TABLE registrations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
