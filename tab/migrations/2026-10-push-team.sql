-- Team targeting for push subscriptions, for databases that created
-- push_subs before it.
--
-- The third of the columns that were left as a comment in schema.sql
-- rather than a file here. Its neighbour, push_subs.label, did get a
-- migration (2026-10-push-devices.sql) — this one was simply missed.
--
-- Without it a push aimed at one team fails and the send stops.
ALTER TABLE push_subs ADD COLUMN team_id INTEGER;
