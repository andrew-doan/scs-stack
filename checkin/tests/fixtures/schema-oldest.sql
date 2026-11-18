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
  zid           TEXT NOT NULL UNIQUE,   -- normalised: z1234567
  token         TEXT NOT NULL UNIQUE,   -- QR payload secret
  qr_key        TEXT NOT NULL UNIQUE,   -- R2 object name for the image
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  checked_in_at TEXT,                   -- null until they arrive
  checked_in_by TEXT                    -- 'qr' or 'manual'
);

CREATE INDEX IF NOT EXISTS idx_attendees_team ON attendees(team_name);
CREATE INDEX IF NOT EXISTS idx_attendees_token ON attendees(token);

-- Short-lived logins for the scanner and the board. The pages hold a
-- session token, never the password, and every check is server-side.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  role       TEXT NOT NULL,             -- 'scan' or 'board'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
