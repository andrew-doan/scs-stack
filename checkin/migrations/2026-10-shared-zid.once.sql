-- Let the shared not-a-UNSW-student marker repeat.
--
-- NAMED .once BECAUSE IT CANNOT BE RE-RUN. It drops and recreates the
-- table every time it is applied, with no way to tell in SQL that it has
-- already been done, so npm run db:migrate lists it and does not run it.
-- Run it by hand, once, on a database that still has zid UNIQUE on the
-- column.
--
-- It carries participant_id through the rebuild and re-creates that
-- index. It did not, and the file that adds that column sorts BEFORE
-- this one, so applying them oldest-first added the column and then
-- rebuilt the table without it — losing every shared id and the index,
-- with nothing failing to say so. Run 2026-10-participant-id.sql first
-- (npm run db:migrate does): the copy below names participant_id, so
-- the column has to be there. The same goes for hidden, from
-- 2026-10-hidden.sql, which also sorts before this file.
--
-- attendees.zid was UNIQUE. That is right for a real zID and wrong for
-- z0000000, which stands for no zID at all: the second person carrying
-- it could not be inserted, so /api/register answered 500 and the tab
-- worker got no QR code for them. The dashboard showed that as "the
-- check-in worker answered 500"; the public sign-up form hit the same
-- wall and said nothing, so those people were emailed a confirmation
-- with no ticket in it.
--
-- SQLite cannot drop a column constraint, so the table is rebuilt
-- without it and a partial unique index keeps real zIDs unique.
--
-- Run once, against an existing database:
--   node scripts/deploy.mjs --dry
--   npx wrangler d1 execute scs-checkin --remote \
--     --config wrangler.deploy.toml --file=migrations/2026-10-shared-zid.once.sql
-- A database created from the current schema.sql needs none of this, and
-- npm run db:check says whether this one still does.

CREATE TABLE IF NOT EXISTS attendees_rebuild (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  zid           TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  qr_key        TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  checked_in_at TEXT,
  checked_in_by TEXT,
  participant_id INTEGER,
  hidden        INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO attendees_rebuild
  (id, name, email, team_name, zid, token, qr_key, created_at, checked_in_at, checked_in_by, participant_id, hidden)
  SELECT id, name, email, team_name, zid, token, qr_key, created_at, checked_in_at, checked_in_by, participant_id, hidden
  FROM attendees;

DROP TABLE attendees;
ALTER TABLE attendees_rebuild RENAME TO attendees;

CREATE INDEX IF NOT EXISTS idx_attendees_team ON attendees(team_name);
CREATE INDEX IF NOT EXISTS idx_attendees_token ON attendees(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_zid ON attendees(zid) WHERE zid <> 'z0000000';
CREATE INDEX IF NOT EXISTS idx_attendees_participant ON attendees(participant_id);
