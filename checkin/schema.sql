-- SCS.2 check-in database (Cloudflare D1, its own database — the
-- scores live elsewhere on purpose: a reseed of the tab must never
-- touch who is in the building).

-- One row per registered person. `token` is the secret inside their
-- QR code; `qr_key` is the unrelated random name the QR image sits
-- under in R2, so knowing one never reveals the other.
CREATE TABLE IF NOT EXISTS attendees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  zid           TEXT NOT NULL,          -- normalised: z1234567
  token         TEXT NOT NULL UNIQUE,   -- QR payload secret
  qr_key        TEXT NOT NULL UNIQUE,   -- R2 object name for the image
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  checked_in_at TEXT,                   -- null until they arrive
  checked_in_by TEXT,                   -- 'qr' or 'manual'
  -- The tab worker's participants.id for the same person. Names and
  -- teams get edited on the dashboard; this number does not, so it is
  -- what the two databases match on and what a rename is pushed by.
  -- Null on a row written before the column existed, and on a person
  -- registered before their participants row was inserted — filled in
  -- the next time they come through /api/register or /api/rename.
  participant_id INTEGER,
  -- 1 for a person the tab worker counts as a test: their team is
  -- hidden there, or their signup is. Kept off the board, out of the
  -- scanner's list and out of every count; their code checks nobody
  -- in. The tab worker sets it through /api/hide.
  hidden        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attendees_team ON attendees(team_name);
CREATE INDEX IF NOT EXISTS idx_attendees_token ON attendees(token);
CREATE INDEX IF NOT EXISTS idx_attendees_participant ON attendees(participant_id);
-- One row per real zID. z0000000 is the shared marker for people who
-- are not UNSW students, so it is left out: several of them register,
-- each with their own code. A database made before this is still
-- UNIQUE on the whole column; migrations/2026-10-shared-zid.once.sql
-- rebuilds it, and npm run db:check says whether it still needs to be
-- run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_zid ON attendees(zid) WHERE zid <> 'z0000000';

-- Short-lived logins for the scanner and the board. The pages hold a
-- session token, never the password, and every check is server-side.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  role       TEXT NOT NULL,             -- 'scan' or 'board'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
