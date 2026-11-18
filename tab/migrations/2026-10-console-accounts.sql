-- Dashboard accounts made by an admin, each with its own password, the
-- tabs it may use, and whether it needs a code from an authenticator
-- app. Before this every organiser signed in with the one shared
-- password and could do everything.
--
-- password_hash NULL is an account from before, which still signs in
-- with the shared CONSOLE_PASSWORD until an admin gives it one of its
-- own. perms is a comma list of tab keys (dash-access.js); admin means
-- every tab and the Accounts tab.
--
-- schema.sql has the columns on a fresh database. The ALTERs fail once
-- they are there, which is the signal they have already run.
ALTER TABLE console_users ADD COLUMN password_hash TEXT;
ALTER TABLE console_users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE console_users ADD COLUMN perms TEXT NOT NULL DEFAULT '';
ALTER TABLE console_users ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 1;
ALTER TABLE console_users ADD COLUMN created_by TEXT;

-- The organisers who had already set up a code could do everything, and
-- still can. Once only: the marker stops a later run making an admin of
-- somebody an admin has since taken it away from. site_flags is made
-- here as well because 2026-10-recap.sql, which makes it, sorts later.
CREATE TABLE IF NOT EXISTS site_flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
UPDATE console_users SET admin = 1
  WHERE confirmed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'console_accounts_seeded');
INSERT OR IGNORE INTO site_flags (name, value) VALUES ('console_accounts_seeded', 1);
