-- Share the tab worker's participants.id with the roster.
--
-- The two databases held separate rows for the same person with no
-- identifier in common, so they were matched on name and team. Nothing
-- pushed a rename across: editing a person's name, or renaming a team,
-- on the dashboard left the check-in row under the old name. Their
-- check-in mark stopped showing on the Rego tab, and a person carrying
-- z0000000 (the shared not-a-UNSW-student marker, matched on name and
-- team because the marker cannot tell two people apart) was minted a
-- second code the next time they were registered, while the first one
-- still worked.
--
-- attendees.participant_id holds the tab worker's id for the same
-- person. It survives a rename, so /api/register finds the right row
-- and /api/rename can move a name or a team across.
--
-- Run this BEFORE migrations/2026-10-shared-zid.once.sql, which is what
-- happens on its own: the files are applied oldest first and p sorts
-- before s. That one rebuilds attendees from an explicit column list
-- naming participant_id, so the column has to exist by then.
--
--   npm run db:migrate
--
-- A database created from the current schema.sql needs none of this.

ALTER TABLE attendees ADD COLUMN participant_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_attendees_participant ON attendees(participant_id);
