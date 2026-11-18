-- SCS.2 scores database (Cloudflare D1).
-- Every change to a team's score is a line in `entries` (the ledger),
-- and a team's total is the sum of its live lines' points. The view
-- `held` is what each team holds on each code, read off those lines —
-- an `amount` of the code (1 for a normal completion, higher counts for
-- a per-unit part, fractions for part marks) and the `points` it came
-- to — and the tab's readers sum the points over it.

CREATE TABLE IF NOT EXISTS teams (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  hidden INTEGER NOT NULL DEFAULT 0,               -- 1 = off every public read (test teams)
  dnf    INTEGER NOT NULL DEFAULT 0                -- 1 = did not finish: on the board with no place
);
-- An existing database gets these columns from migrations/2026-09-team-hidden.sql
-- and migrations/2026-10-team-dnf.sql (npm run db:migrate). Nothing in here is ever to be run by hand: this
-- file only creates tables, so a column added to a table that already
-- exists can only reach a live database through migrations/.
-- A name is unique whatever its case, since every reader finds a team by
-- name ignoring case (migrations/2026-12-team-names.sql). An id is never
-- reused: deleting a team raises site_flags.team_id_high, and every new
-- team is given one past it and past MAX(id) (NEXT_TEAM_ID in shared.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_nocase ON teams (name COLLATE NOCASE);

-- One quest as the site shows it: name, region, description (markdown),
-- the italic flavour line, location text and map pins, and which
-- answer box the submit page adds. Its codes live in quests.
-- The regions (the site's categories), in display order. Groups name
-- their region by text; this table holds the order and lets a region
-- exist before it has quests.
CREATE TABLE IF NOT EXISTS quest_regions (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  sort   INTEGER NOT NULL DEFAULT 0,
  colour TEXT NOT NULL DEFAULT ''  -- a line colour for the quest sheet (ROUTE_COLOURS); '' is red
);

CREATE TABLE IF NOT EXISTS quest_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,            -- the lead code, e.g. SQ1
  name        TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',        -- markdown
  flavour     TEXT NOT NULL DEFAULT '',        -- shown in italics
  location    TEXT NOT NULL DEFAULT '',
  coords      TEXT NOT NULL DEFAULT '[]',      -- JSON [{label, lat, lng}]
  submit_kind TEXT NOT NULL DEFAULT 'none',    -- none / count / text / pick / choice / codes
  prompt      TEXT NOT NULL DEFAULT '',        -- the answer box's question
  options     TEXT NOT NULL DEFAULT '[]',      -- JSON list for pick (@stations, @sushi expand)
  sort        INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0,
  -- What the quest asks every team while it is running, if anything:
  -- '' (nothing), choice (buttons), number (a sealed entry), wager
  -- (pick an option and stake points), text (a typed answer).
  ask_kind    TEXT NOT NULL DEFAULT '',
  ask_prompt  TEXT NOT NULL DEFAULT '',
  ask_options TEXT NOT NULL DEFAULT '[]',      -- JSON list of button labels
  ask_open    INTEGER NOT NULL DEFAULT 0,      -- 1 = teams may answer right now
  -- A deadline for the answers, UTC 'YYYY-MM-DD HH:MM:SS', or '' for
  -- none. It is never written to: a question counts as open when
  -- ask_open is 1 and this is either empty or still ahead of now.
  ask_open_until TEXT NOT NULL DEFAULT '',
  -- A wager once settled: JSON {winner, at, by, id}, '' before. The
  -- settle claims it from '' in the same batch as the credits, so a
  -- wager can only move the standings once.
  ask_settled TEXT NOT NULL DEFAULT '',
  -- Who sees the quest while hidden is 0: everyone, signed-in teams,
  -- or only the team groups linked in quest_audiences. hidden = 1 is
  -- organisers only, whatever this says.
  visibility  TEXT NOT NULL DEFAULT 'everyone',
  -- When the quest opens to everyone by itself, UTC 'YYYY-MM-DD
  -- HH:MM:SS', or '' for never. Opening clears it.
  opens_at    TEXT NOT NULL DEFAULT '',
  -- 1 = the site shows ??? in place of the points of every code. The
  -- tab scores the codes as it scores any other.
  mystery     INTEGER NOT NULL DEFAULT 0,
  -- Every question the submit form asks, as JSON [{kind, prompt,
  -- options}], when there is more than one. '' means the one in
  -- submit_kind / prompt / options, or none.
  questions   TEXT NOT NULL DEFAULT '',
  -- What the submit form takes and how a challenge is counted, as JSON
  -- {files: {kinds, max, required}, tally: {kind, awards, public}}
  -- (src/rules.ts); '' is the defaults: up to four photos or videos,
  -- one needed, nothing counted.
  rules       TEXT NOT NULL DEFAULT '',
  -- A challenge's places once awarded: JSON {at, by, id}, '' before.
  -- Claimed from '' in the same batch as the points, like ask_settled.
  tally_settled TEXT NOT NULL DEFAULT '',
  -- What teams see of a live question's answers: '' only their own;
  -- 'tally' how many picked each option; 'answers' every team's answer.
  -- Shown once it closes or while it is open too when ask_reveal_live
  -- is 1. No commas in this comment: SQLite drops the last column from
  -- the comma before it and would cut this comment in half. The test
  -- for a database behind the migration (verify-ask.mjs) drops both.
  ask_reveal  TEXT NOT NULL DEFAULT '',
  ask_reveal_live INTEGER NOT NULL DEFAULT 0,
  -- Tags teams search a quest by and see on its sheet
  keywords TEXT NOT NULL DEFAULT ''
);

-- Tags group quests so a set of them can be opened at once. A tag
-- hidden from the dashboard (dash_hidden) keeps its quests out of the
-- dashboard's quest list unless its switch is on: the Old tag holds the
-- quests from before tags existed.
CREATE TABLE IF NOT EXISTS quest_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  dash_hidden INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quest_group_tags (
  group_id INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (group_id, tag_id)
);

-- Team groups: named lists of teams a quest can be shown to.
CREATE TABLE IF NOT EXISTS audiences (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS audience_teams (
  audience_id INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  PRIMARY KEY (audience_id, team_id)
);

CREATE TABLE IF NOT EXISTS quest_audiences (
  group_id    INTEGER NOT NULL,
  audience_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, audience_id)
);

-- The codes the tab scores: each is a part of its quest, scored by its
-- type (src/parts.ts). Retired codes end in -o and are hidden.
CREATE TABLE IF NOT EXISTS quests (
  code     TEXT PRIMARY KEY,       -- as written on the tab: SQ1, SQ1-B, Make 21
  norm     TEXT NOT NULL UNIQUE,   -- lookup key: uppercased, spaces removed
  points   REAL NOT NULL,          -- fixed, each or at most; the top band for tiered and counted
  group_id INTEGER,                -- quest_groups.id; NULL for a loose code
  label    TEXT NOT NULL DEFAULT '',  -- what this part is: "Stations", "Longest word"
  sort     INTEGER NOT NULL DEFAULT 0,
  hidden   INTEGER NOT NULL DEFAULT 0,
  scoring  TEXT NOT NULL DEFAULT '',  -- '' fixed, unit, judged, tiered, counted
  most     REAL,                      -- the most a per-unit part counts; NULL is no limit
  bands    TEXT NOT NULL DEFAULT ''   -- tiered and counted: JSON [{from, points}]
);
-- Databases created before quest groups need migrations/2026-09-quest-groups.sql
-- (npm run db:quests).

-- The tab before the ledger, one row per team and code. Nothing reads or
-- writes it any more: migrations/2026-11-ledger.sql read it once to fill
-- the ledger in, which is why it is still made here.
CREATE TABLE IF NOT EXISTS completions (
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  quest_code TEXT NOT NULL REFERENCES quests(code),
  amount     REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, quest_code)
);

CREATE INDEX IF NOT EXISTS idx_completions_quest ON completions(quest_code);

-- The ledger (src/ledger.ts). Every change to a team's score is a line
-- here, and a team's score is the sum of its lines that are not voided.
-- A line is never edited or deleted: one that was wrong is voided, with
-- who, when and why.
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL,
  code        TEXT NOT NULL,                       -- quests.code
  units       REAL NOT NULL DEFAULT 0,             -- how much of the code: a count, or part of one
  points      REAL NOT NULL DEFAULT 0,             -- what it is worth, fixed when written
  input       TEXT NOT NULL DEFAULT '',            -- what the reviewer entered, JSON
  source_kind TEXT NOT NULL,                       -- submission / award / balance
  source_id   INTEGER,                             -- submissions.id or awards.id
  note        TEXT NOT NULL DEFAULT '',
  made_by     TEXT NOT NULL DEFAULT '',
  made_at     TEXT NOT NULL DEFAULT (datetime('now')),
  at          TEXT NOT NULL DEFAULT (datetime('now')),  -- when it counts from
  voided_by   TEXT,
  voided_at   TEXT,
  void_reason TEXT,
  deleted_from TEXT NOT NULL DEFAULT ''            -- moved to DELETED with its quest: the code it was on
);
CREATE INDEX IF NOT EXISTS idx_entries_team ON entries (team_id, code);
CREATE INDEX IF NOT EXISTS idx_entries_code ON entries (code);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source_kind, source_id);
-- a source holds one live line a team and code: a second Accept fails
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_once ON entries (source_kind, source_id, team_id, code) WHERE voided_at IS NULL AND source_id IS NOT NULL;

-- Lines made together by a rule rather than a review: a challenge's
-- places, a wager's settlement, the EOI. Voiding one voids its lines.
CREATE TABLE IF NOT EXISTS awards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                       -- challenge / wager / eoi
  group_id    INTEGER,                             -- quest_groups.id
  code        TEXT NOT NULL DEFAULT '',            -- the code its lines are on
  token       TEXT NOT NULL UNIQUE,                -- for its lines to find it in the same batch
  basis       TEXT NOT NULL DEFAULT '',            -- JSON: what it was worked out from
  note        TEXT NOT NULL DEFAULT '',
  made_by     TEXT NOT NULL DEFAULT '',
  made_at     TEXT NOT NULL DEFAULT (datetime('now')),
  voided_by   TEXT,
  voided_at   TEXT,
  void_reason TEXT,
  deleted_from TEXT NOT NULL DEFAULT ''            -- moved to DELETED with its quest: the code it was on
);
-- one live award of a kind on a code: a second press fails
CREATE UNIQUE INDEX IF NOT EXISTS idx_awards_once ON awards (kind, code) WHERE voided_at IS NULL;

-- What each team holds on each code: its live lines added up, for teams
-- and codes that are still there, `amount` their units and `points` what
-- they were worth when written. A code whose lines come to nothing has
-- no row; one below nothing (two corrections on one completion) keeps it.
-- updated_at is the newest live line's time.
CREATE VIEW IF NOT EXISTS held AS
  SELECT e.team_id AS team_id, e.code AS quest_code, SUM(e.units) AS amount, ROUND(SUM(e.points), 2) AS points, MAX(e.at) AS updated_at
  FROM entries e
  WHERE e.voided_at IS NULL AND e.team_id IN (SELECT id FROM teams) AND e.code IN (SELECT code FROM quests)
  GROUP BY e.team_id, e.code
  HAVING ABS(SUM(e.units)) > 0.000001 OR ABS(SUM(e.points)) > 0.000001;

-- Every /submit and /unsubmit, as it happened: who moved which team's
-- score, from what to what. An audit trail first, but also the raw
-- material for day-of analysis (submissions per hour and the like).
CREATE TABLE IF NOT EXISTS submission_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  action       TEXT NOT NULL,     -- 'submit' or 'unsubmit'
  team_name    TEXT NOT NULL,
  quest_code   TEXT NOT NULL,
  points_delta REAL NOT NULL,
  old_total    REAL NOT NULL,
  new_total    REAL NOT NULL,
  actor        TEXT               -- Discord username that ran the command
);

CREATE INDEX IF NOT EXISTS idx_log_at ON submission_log(at);

-- Filled in by the check-in worker (its own worker and database) the
-- moment a team's last member arrives: one row per fully-checked-in
-- team, with when. Organisers use these times to hand out the on-time
-- points through the normal /submit flow. An undo over there deletes
-- the row again.
CREATE TABLE IF NOT EXISTS team_checkins (
  team_name    TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  people       INTEGER NOT NULL DEFAULT 0
);

-- A team part-way in: how many of its people and when the last of them
-- arrived (the same reports). The team page shows it until the team is
-- complete.
CREATE TABLE IF NOT EXISTS team_arrivals (
  team_name  TEXT PRIMARY KEY,
  last_at    TEXT NOT NULL,
  checked_in INTEGER NOT NULL DEFAULT 0,
  people     INTEGER NOT NULL DEFAULT 0
);

-- Tab-team console logins (the /console page). The page holds a
-- session token, never the password; every call is re-checked here.
-- `name` is who signed in — it becomes the actor on log entries.
CREATE TABLE IF NOT EXISTS console_sessions (
  token      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT 'console',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Dashboard accounts. An admin makes them, with a password of their
-- own (password_hash; NULL signs in with the shared CONSOLE_PASSWORD),
-- the tabs they may use (perms, a comma list; admin is every tab), and
-- whether they need a six-digit code from an authenticator app
-- (require_2fa, set up on their first sign-in). console_backup_codes is
-- what stands in when the phone holding the code is dead or lost, one
-- use each.
CREATE TABLE IF NOT EXISTS console_users (
  name          TEXT PRIMARY KEY,
  secret        TEXT NOT NULL,
  confirmed_at  TEXT,
  last_step     INTEGER NOT NULL DEFAULT 0,
  last_seen     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  password_hash TEXT,
  admin         INTEGER NOT NULL DEFAULT 0,
  perms         TEXT NOT NULL DEFAULT '',
  require_2fa   INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  quests        TEXT NOT NULL DEFAULT ''  -- comma separated quest keys it may score; '' = every quest
);

CREATE TABLE IF NOT EXISTS console_backup_codes (
  name      TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at   TEXT,
  PRIMARY KEY (name, code_hash)
);

-- Every sign-in attempt, which the per-address throttle counts and the
-- Security card prints. Separate from submission_log because the
-- throttle asks a question that needs an index on the address.
CREATE TABLE IF NOT EXISTS console_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  name    TEXT NOT NULL DEFAULT '',
  ip      TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_console_attempts_at ON console_attempts (at DESC);
CREATE INDEX IF NOT EXISTS idx_console_attempts_ip ON console_attempts (ip, at DESC);


-- Web quest submissions (the site's /submit page). The proof files
-- live in R2 under random keys; these rows are pointers plus review
-- state. quest_code is deliberately un-FK'd text — console renames
-- update it in step, and a deleted quest leaves history readable.
CREATE TABLE IF NOT EXISTS team_codes (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id),
  code    TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS submit_sessions (
  token      TEXT PRIMARY KEY,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  quest_code   TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- queued / pending / accepted / rejected / deleted
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  reason       TEXT,                             -- why it was rejected or deleted; the team reads this
  gallery      INTEGER NOT NULL DEFAULT 0,       -- team opted in to the post-event gallery
  answer       TEXT,                             -- JSON from the quest's answer box, if it has one
  -- Who is looking at this one right now, and since when (UTC). A
  -- claim is advice between reviewers, not a lock: it goes stale after
  -- ten minutes and accepting or rejecting clears it.
  claimed_by   TEXT NOT NULL DEFAULT '',
  claimed_at   TEXT NOT NULL DEFAULT '',
  added_by     TEXT NOT NULL DEFAULT '',  -- the organiser who recorded it; empty when the team sent it in
  credit       TEXT,                      -- JSON {codes, amount}: what it put on the tab
  deleted_from TEXT NOT NULL DEFAULT ''   -- its quest was deleted: quest_code is DELETED and this the code it had
);
-- An existing database gets this column from
-- migrations/2026-09-submission-gallery.sql (npm run db:migrate).

-- Push notification subscriptions from the site's settings rocker.
-- The endpoint is the device's own push-service URL; keys are what
-- RFC 8291 encryption needs. Dead endpoints are pruned on send.
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  team_id    INTEGER,                             -- set when a signed-in team relinks its device
  label      TEXT NOT NULL DEFAULT '',            -- a name for this device: the site's first guess, renameable from the dashboard
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- An existing database gets this column from
-- migrations/2026-10-push-team.sql (npm run db:migrate).

-- Team registrations from the site's /rego page: one row per team
-- signup plus one participants row per person. The check-in QR URL and
-- the confirmation email's fate are stamped per person so the console
-- can retry either. Deleting a team in the console leaves these rows
-- as the paper trail (team_id is a plain column, not a foreign key).
CREATE TABLE IF NOT EXISTS registrations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id          INTEGER,
  team_name        TEXT NOT NULL,
  societies        TEXT,
  photo_permission INTEGER NOT NULL DEFAULT 0,
  questions        TEXT,
  ip_hash          TEXT,
  submitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1 = a test signup. Counts only while the people on it are in no
  -- team; once they are, their team's hidden is the one that counts.
  hidden           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id INTEGER NOT NULL,
  team_id         INTEGER,
  position        INTEGER NOT NULL,               -- 1 = whoever filled the form
  name            TEXT NOT NULL,
  zid             TEXT NOT NULL,
  email           TEXT,
  arc             INTEGER NOT NULL DEFAULT 0,
  dietary         TEXT,
  discord         TEXT,
  qr_url          TEXT,                           -- from the check-in worker
  email_status    TEXT,                           -- sent / failed / skipped / held (email off in Settings)
  -- how many times the scheduled run has retried this one. A ticket
  -- email that keeps failing is tried a few times and then left: an
  -- address that will never accept mail must not be tried every minute.
  email_tries     INTEGER NOT NULL DEFAULT 0,
  -- each person accepts the terms and waiver from a link in their own
  -- email: terms_key is the secret in that link, terms_at when they
  -- accepted (NULL until then)
  terms_key       TEXT,
  terms_at        TEXT,
  -- their own answer to the photo question, from the same page: 1 yes,
  -- 0 no, NULL not answered yet
  photo_ok        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_participants_reg ON participants(registration_id);

-- Discord servers the bot works in, managed from the dashboard's
-- Discord tab. The organiser role is the one that may change scores
-- and see every team channel; the category is where team channels
-- go. The GUILD_ID / ORGANISER_ROLE_ID secrets seed the first row when
-- this table is empty, once: site_flags.discord_seeded keeps a table
-- emptied on the dashboard empty.
CREATE TABLE IF NOT EXISTS discord_guilds (
  guild_id            TEXT PRIMARY KEY,
  name                TEXT NOT NULL DEFAULT '',
  organiser_role_id   TEXT NOT NULL DEFAULT '',
  category_name       TEXT NOT NULL DEFAULT 'Private Channels',
  category_id         TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  announce_channel_id TEXT,                      -- where a new message is cross-posted
  added_at            TEXT NOT NULL DEFAULT (datetime('now')),
  legend_role_id      TEXT NOT NULL DEFAULT '',  -- given to everyone taking part
  unknown_role_id     TEXT NOT NULL DEFAULT '',  -- given to members no signup lists
  staff_role_ids      TEXT NOT NULL DEFAULT '',  -- comma separated: roles that see every team channel
  accept_posts        INTEGER NOT NULL DEFAULT 1, -- post each accepted submission in the team's channel
  no_team_role_id     TEXT NOT NULL DEFAULT '',  -- given to a signup not in a team yet; '' = Unknown Team
  held                INTEGER NOT NULL DEFAULT 0 -- 1: nothing the bot posts here goes out; each message goes to the log
);

-- A team's role and private channel in a server, made by /verify or
-- the dashboard's Set up button.
CREATE TABLE IF NOT EXISTS discord_teams (
  guild_id     TEXT NOT NULL,
  team_id      INTEGER NOT NULL,
  role_id      TEXT,
  channel_id   TEXT,
  role_name    TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, team_id)
);

-- Role menus: a message the bot posts with a dropdown from which members
-- give themselves roles (rolemenus.js). options is a JSON list of
-- {role_id, label, description, emoji}; pick is 'one' or 'many'.
-- channel_id and message_id are where it is posted, empty until it is.
CREATE TABLE IF NOT EXISTS discord_role_menus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  pick        TEXT NOT NULL DEFAULT 'one',
  options     TEXT NOT NULL DEFAULT '[]',
  channel_id  TEXT,
  message_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

-- Who has run /verify: their Discord user, matched to a signup.
CREATE TABLE IF NOT EXISTS discord_members (
  guild_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  username       TEXT NOT NULL DEFAULT '',
  participant_id INTEGER,
  team_id        INTEGER,
  verified_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_zid ON participants(zid);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_team ON submissions(team_id);

CREATE TABLE IF NOT EXISTS submission_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  r2_key        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL DEFAULT 'ready',  -- 'uploading' until a large file's last slice lands
  upload_id     TEXT,                           -- R2 multipart id while uploading
  part_size     INTEGER,                        -- slice size agreed with the page
  -- Where this file is up to with the video encoder: '' untouched,
  -- 'encoding' claimed by a runner, 'done' renditions made, 'skipped'
  -- tried and nothing usable came out. A claim older than 15 minutes
  -- is offered again, so a runner that died mid-file is not the end
  -- of that file.
  encode_state      TEXT NOT NULL DEFAULT '',
  encode_claimed_at TEXT NOT NULL DEFAULT '',
  -- when it was taken, as album_photos.taken_at
  taken_at          TEXT,
  -- the type of the file a photo was picked as (album_photos.picked_type)
  picked_type       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_subfiles_sub ON submission_files(submission_id);
CREATE INDEX IF NOT EXISTS idx_subfiles_key ON submission_files(r2_key);

-- The smaller copies of a proof video. An organiser runs the encoder
-- on their laptop (scripts/encoder.mjs); it takes each video, makes a
-- 480p/720p/1080p H.264 copy of it and sends the copies back. They
-- live in the same bucket as the originals under their own rnd/
-- prefix, and the site asks for one with &res= on the file endpoint.
-- One row per height per file; re-sending a height replaces the row
-- and the object it pointed at.
CREATE TABLE IF NOT EXISTS submission_renditions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key   TEXT NOT NULL,                   -- submission_files.r2_key of the original
  height     INTEGER NOT NULL,                -- the bucket: 480, 720 or 1080
  key        TEXT NOT NULL UNIQUE,            -- the R2 key of the copy
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_key, height)
);

CREATE INDEX IF NOT EXISTS idx_renditions_file ON submission_renditions(file_key);

-- One row per machine running the encoder, named after itself. Any
-- number of them can work at once: each claims one video at a time, so
-- a faster machine simply comes back for another sooner and there is
-- nothing to schedule. jobs_done and encode_ms are what the dashboard
-- turns into a plain pace for each machine.
CREATE TABLE IF NOT EXISTS encoders (
  name       TEXT PRIMARY KEY,
  last_seen  TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '',        -- idle / encoding
  working_on TEXT NOT NULL DEFAULT '',        -- the file key it is on
  jobs_done  INTEGER NOT NULL DEFAULT 0,
  encode_ms  INTEGER NOT NULL DEFAULT 0
);

-- Slices of a large upload that have landed, so a reopened page can
-- carry on instead of starting over. Cleared when the file completes.
-- The tab freeze: one row, holding whether the public tab is stopped
-- and a copy of the public payloads as they stood at that moment. The
-- copy is what frozen reads answer with, so nothing asks the live
-- tables the public's questions while the freeze is on.
CREATE TABLE IF NOT EXISTS tab_freeze (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  frozen    INTEGER NOT NULL DEFAULT 0,
  frozen_at TEXT,
  snapshot  TEXT,
  -- 1 = the public standings answer that the tab is closed and nothing
  -- else, frozen or not
  closed    INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT
);

-- Saved copies of the public standings, any of which can be frozen
-- again: one at every freeze, one each hour the standings moved, and
-- any an organiser saves. kind is freeze, hour or hand; summary is the
-- team count and the top three, so the list needs no payload.
CREATE TABLE IF NOT EXISTS tab_snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at  TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'hand',
  taken_by  TEXT NOT NULL DEFAULT '',
  digest    TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '{}',
  snapshot  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tab_snapshots_taken ON tab_snapshots (taken_at);

CREATE TABLE IF NOT EXISTS submission_upload_parts (
  file_id INTEGER NOT NULL REFERENCES submission_files(id),
  part_n  INTEGER NOT NULL,
  etag    TEXT NOT NULL,
  PRIMARY KEY (file_id, part_n)
);

-- Version numbers the website polls: one for the quest list, one for
-- the messages. They only say that something changed, never what, so a
-- phone can ask often and cheaply. Rows appear the first time each is
-- bumped; the dashboard can also set either by hand.
-- Switches the dashboard flips after the event: team_pages opens
-- /api/team (a team's quests, linked from the leaderboard) and recap
-- opens /api/recap (the event's numbers). Both are off until a row
-- says otherwise; the site learns them from /api/pulse.
CREATE TABLE IF NOT EXISTS site_flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- The home page's countdown, as a run of stops in time order: the day
-- starting, submissions closing, the ceremony. The page counts to the
-- first one still ahead and moves to the next as each passes. No rows
-- means the page keeps the date built into its own markup, which is
-- also what it shows before this answer arrives.
-- Files OrgComm shares without attaching them to anything: a poster, a
-- map, a schedule. They live under drop/ in the same R2 bucket as
-- everything else and are served by their keys, the random half of the
-- key being the whole credential.
CREATE TABLE IF NOT EXISTS drop_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

-- go.<domain>/<slug>. kind='file' serves the bytes at that address;
-- kind='url' redirects. A file link serves rather than redirects
-- because an unfurler that has to follow a hop is one more way for an
-- embed to fail, and a slug ending in the file's own extension is what
-- makes Discord read the link as a picture.
CREATE TABLE IF NOT EXISTS short_links (
  slug       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'url',
  target     TEXT NOT NULL DEFAULT '',
  file_key   TEXT NOT NULL DEFAULT '',
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_short_links_file ON short_links(file_key);

-- An announcement that did not reach every device in one request. The
-- save sends the first batch itself and leaves the rest here with a
-- cursor; the scheduled run takes one batch a minute until the cursor
-- passes the last subscriber, then deletes the row. Nobody retypes a
-- message and nobody is notified twice.
CREATE TABLE IF NOT EXISTS push_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL DEFAULT '',
  renotify   INTEGER NOT NULL DEFAULT 1,
  urgency    TEXT NOT NULL DEFAULT 'high',
  topic      TEXT NOT NULL DEFAULT '',
  after_id   INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- a JSON list of team ids for a message some teams read; NULL is
  -- every subscribed device
  team_ids   TEXT
);

CREATE TABLE IF NOT EXISTS countdown_stops (
  sort  INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  at    TEXT NOT NULL DEFAULT ''
);

-- Words the dashboard sets on the public pages, one row per name:
-- countdown_over is the line the home page's countdown shows once its
-- last stop has passed. No row means the page's own words.
CREATE TABLE IF NOT EXISTS site_text (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- The pictures the home page runs as a slideshow. They live under
-- slide/ in the same R2 bucket as everything else and are served by
-- their keys, the random half of the key being the whole credential.
-- `alt` is what a screen reader reads out, so nothing is saved without
-- it. No rows means the page has no slideshow on it at all.
CREATE TABLE IF NOT EXISTS home_slides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0,
  alt        TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT '',
  -- The point the picture is cropped around: percent across then down
  focus_x    INTEGER NOT NULL DEFAULT 50,
  focus_y    INTEGER NOT NULL DEFAULT 50,
  -- 1 = kept on the dashboard and left out of the slideshow
  hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_home_slides_sort ON home_slides(sort, id);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Messages from the organisers, written in the dashboard and read on
-- the site's messages page. The body is markdown; attachments live in
-- the same R2 bucket as proof files, under their own msg/ prefix.
-- Three states keep a message off the site: hidden (a draft, never
-- published), archived (published once, now put away), and neither.
-- Urgency decides what a new one does beyond appearing: silent means
-- nothing, normal moves the counter, urgent moves it and marks itself
-- in the pulse so the site can put it in front of people.
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,       -- 1 = written but not published
  sort       INTEGER NOT NULL DEFAULT 0,       -- display order; 0 sits above anything ordered
  archived   INTEGER NOT NULL DEFAULT 0,       -- 1 = off the site, kept in the dashboard
  urgency    TEXT NOT NULL DEFAULT 'normal',   -- silent / normal / urgent
  -- When a written-ahead message should appear, UTC 'YYYY-MM-DD
  -- HH:MM:SS', or '' for one posted by hand. A message with a time on
  -- it is saved hidden; the first public read after that time
  -- publishes it and clears this.
  publish_at TEXT NOT NULL DEFAULT '',
  -- Who reads it, the same audiences a quest has: everyone, teams
  -- (any team signed in) or groups (the team groups in
  -- message_audiences). hidden = 1 is organisers only.
  visibility TEXT NOT NULL DEFAULT 'everyone',
  -- The messages counter's value when this message went up, 0 for one
  -- that moved nothing (silent, or never published). The pulse answers
  -- each reader with the newest of these among the messages they can
  -- see, so a message for some teams lights nobody else's bell.
  seq        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_audiences (
  message_id  INTEGER NOT NULL,
  audience_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, audience_id)
);

CREATE TABLE IF NOT EXISTS message_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  key        TEXT NOT NULL UNIQUE,          -- the R2 key; its random half is the file's URL
  name       TEXT,
  type       TEXT,
  bytes      INTEGER,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_message_files_msg ON message_files(message_id);

-- Files hung on a quest by the organisers: the photograph a photo
-- quest is about, the sheet a puzzle is printed on. They live in the
-- same R2 bucket as proof files, under their own qst/ prefix, and are
-- served by their keys — the random half of a key is the capability.
CREATE TABLE IF NOT EXISTS quest_files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  key      TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL DEFAULT '',
  bytes    INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0,
  deleted_key TEXT NOT NULL DEFAULT ''  -- its quest was deleted: the quest's key; the file is kept
);

CREATE INDEX IF NOT EXISTS idx_quest_files_group ON quest_files(group_id);

-- One answer per team per quest question: the button they pressed or
-- the text they typed in `choice`, the number they entered or the
-- points they staked in `amount`. A team may change its answer while
-- the question is open, so the row is upserted and updated_at says
-- when they last did — which is how a first-correct-answer quest is
-- judged.
CREATE TABLE IF NOT EXISTS quest_responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  team_id    INTEGER NOT NULL,
  choice     TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, team_id)
);

-- Email announcements from the dashboard's Email tab.
-- One row per announcement: what it said and how far it has got.
CREATE TABLE IF NOT EXISTS email_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'text',
  body        TEXT NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'all',
  team_id     INTEGER,
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'sending',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  -- the line at the foot of this send: NULL is the default line, ''
  -- is none (announce.js DEFAULT_FOOTER)
  footer      TEXT,
  -- where a reply goes; NULL is the worker's own EMAIL_REPLY_TO
  reply_to    TEXT
);

-- One row per address an announcement goes to, so each person is sent
-- their own copy, addressed to them alone, and nobody is sent two.
-- status: '' waiting, 'sending' while a batch has it, 'sent', 'failed',
-- 'stopped' (still waiting when the send was stopped).
CREATE TABLE IF NOT EXISTS email_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  send_id    INTEGER NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  error      TEXT NOT NULL DEFAULT '',
  UNIQUE (send_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_queue_send ON email_queue(send_id, status);

-- People who filled in the expression of interest, from the CSV the
-- dashboard uploads (src/eoi.ts). Each counts for their team when their
-- zID or their email address matches their signup.
CREATE TABLE IF NOT EXISTS eoi_people (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  zid   TEXT NOT NULL DEFAULT ''
);

-- Photo albums on the site's /albums page, made on the dashboard. Who
-- may add: teams signed in with their submit code, anyone, or nobody
-- (closed). gallery = 1 shows the gallery's accepted submissions in it
-- as well, read live; album_teams shows only the teams listed there
-- when it is 0; album_skips keeps one of those out of one album.
-- Who may look: anyone, from the list (the default); anyone with the
-- link (unlisted = 1), whose address is link_key, since a slug made
-- from a name can be guessed; or organisers only (hidden = 1).
CREATE TABLE IF NOT EXISTS albums (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,            -- the address, made from the first name and kept
  name       TEXT NOT NULL,
  about      TEXT NOT NULL DEFAULT '',
  adding     TEXT NOT NULL DEFAULT 'teams',   -- teams / anyone / closed
  gallery    INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,      -- 1 = organisers only
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT '',
  unlisted   INTEGER NOT NULL DEFAULT 0,      -- 1 = off the list, open to its link
  link_key   TEXT NOT NULL DEFAULT '',        -- random; /albums/?k=<link_key>
  show_hidden INTEGER NOT NULL DEFAULT 0,     -- 1 = hidden teams' photos shown here too
  details    INTEGER NOT NULL DEFAULT 0,      -- 1 = when and where and on what; originals on a download
  -- The order the album opens in: added or taken (taken needs details)
  photo_order TEXT NOT NULL DEFAULT 'added',
  -- The albums merged into this one as a JSON list of their ids and '' for none
  merges     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_albums_link ON albums(link_key);

CREATE TABLE IF NOT EXISTS album_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id     INTEGER NOT NULL REFERENCES albums(id),
  r2_key       TEXT NOT NULL UNIQUE,          -- alb/<random> in the proof bucket
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL DEFAULT '',
  team_id      INTEGER,                       -- the team that added it, signed in
  added_by     TEXT NOT NULL DEFAULT '',      -- a name typed, or the organiser's
  ip           TEXT NOT NULL DEFAULT '',      -- hashed address, for the hourly limit
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  width        INTEGER NOT NULL DEFAULT 0,    -- as the sender's browser measured it
  height       INTEGER NOT NULL DEFAULT 0,
  -- a video too big for one request arrives in slices: 'uploading'
  -- until the last lands, its R2 multipart id, and the token the upload
  -- handed back, which is what each slice has to carry
  status       TEXT NOT NULL DEFAULT 'ready',
  upload_id    TEXT,
  part_size    INTEGER,
  upload_token TEXT NOT NULL DEFAULT '',
  -- the video encoder's progress, the same columns and meanings as
  -- submission_files'; a video's copies go in submission_renditions
  encode_state      TEXT NOT NULL DEFAULT '',
  encode_claimed_at TEXT NOT NULL DEFAULT '',
  -- when it was taken, UTC: '' when the file does not say, null when
  -- nothing has looked yet
  taken_at          TEXT,
  -- A HEIC or WebP is made a JPEG by the page before it goes up. The file
  -- as picked is kept beside it at <key>.p and this is its type ('' when
  -- none was kept). It carries the location and is handed out only where
  -- the original is: an album showing details and the dashboard. No comma
  -- in this comment: DROP COLUMN finds where the column starts by the
  -- comma before it.
  picked_type       TEXT NOT NULL DEFAULT '',
  -- How many times an organiser has replaced the file in place under the
  -- same key: its addresses carry it so nothing cached keeps the old one
  version           INTEGER NOT NULL DEFAULT 0,
  -- An upload still arriving in slices that is to take the place of the
  -- photo with this id once it is whole; 0 for any other
  replaces          INTEGER NOT NULL DEFAULT 0,
  -- The key of the photo in the same album this one points to: left out
  -- of the album and every address it had redirects there. '' for none
  points_to         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_album_photos_album ON album_photos(album_id, id);
CREATE INDEX IF NOT EXISTS idx_album_photos_ip ON album_photos(ip, added_at);

-- Slices of a large album video that have landed. Cleared when it
-- completes.
CREATE TABLE IF NOT EXISTS album_upload_parts (
  photo_id INTEGER NOT NULL,
  part_n   INTEGER NOT NULL,
  etag     TEXT NOT NULL,
  PRIMARY KEY (photo_id, part_n)
);

CREATE TABLE IF NOT EXISTS album_skips (
  album_id INTEGER NOT NULL,
  r2_key   TEXT NOT NULL,
  PRIMARY KEY (album_id, r2_key)
);

-- The teams whose gallery submissions an album shows when it does not
-- show the whole gallery (albums.gallery = 0), read live as the gallery
-- is.
CREATE TABLE IF NOT EXISTS album_teams (
  album_id INTEGER NOT NULL,
  team_id  INTEGER NOT NULL,
  PRIMARY KEY (album_id, team_id)
);

-- Dashboard files on their way straight to R2 (src/staged.ts): opened
-- by upload/start, 'ready' once upload/finish has joined the slices,
-- 'used' once a save has claimed the file, and deleted when the save
-- writes its own row. The scheduled run clears what is left a day on.
CREATE TABLE IF NOT EXISTS staged_uploads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key       TEXT NOT NULL UNIQUE,
  upload_id    TEXT,
  purpose      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  part_size    INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'uploading',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staged_uploads_created ON staged_uploads(created_at);

-- The route each team recorded for the GPS quest, cleaned on the
-- Routes tab (src/tracks.ts): the replay's copy in `route`, the GPX file
-- it came from in the bucket at `gpx_key` (trk/ for one uploaded there,
-- sub/ for the team's own proof file), and what was cut before cleaning
-- in `edits`. No foreign key: a team is deleted in one batch and its
-- route after it.
CREATE TABLE IF NOT EXISTS team_tracks (
  team_id    INTEGER PRIMARY KEY,
  route      TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  ended_at   TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  gpx_key    TEXT NOT NULL DEFAULT '',
  edits      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  saved_at   TEXT NOT NULL DEFAULT (datetime('now')),
  saved_by   TEXT NOT NULL DEFAULT ''
);

-- Where a team's proof was taken, read once from the file's own metadata
-- for the replay (recap.ts, photoPlaces): the quest's nearest place is
-- what goes out, never these. NULL lat and lng: the files carried none.
-- No foreign key; rows for submissions no longer accepted are cleared.
CREATE TABLE IF NOT EXISTS photo_places (
  submission_id INTEGER PRIMARY KEY,
  lat           REAL,
  lng           REAL,
  read_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A proof video's original (submission_files.r2_key): when a download
-- sent it whole and when it was deleted from the bucket, leaving the
-- encoder's copies (originals.ts). No foreign key.
CREATE TABLE IF NOT EXISTS video_originals (
  r2_key   TEXT PRIMARY KEY,
  bytes    INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT,
  gone_at  TEXT,
  gone_by  TEXT NOT NULL DEFAULT ''
);

-- The places a proof photo or video was taken at, read once from its
-- metadata for a quest the Recap card shows photo by photo (visits.ts):
-- the stations within reach, and the quest's own places within reach,
-- each nearest first as a JSON list. The location itself is not kept.
CREATE TABLE IF NOT EXISTS photo_near (
  file_id  INTEGER PRIMARY KEY,
  stations TEXT NOT NULL DEFAULT '[]',
  places   TEXT NOT NULL DEFAULT '[]',
  read_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The payphone quest (src/phone.ts, migrations/2026-12-phone.sql): a team calls the event's number
-- from a payphone and keys in its phone PIN, and the phone worker
-- reports the PIN and the caller's number here.
CREATE TABLE IF NOT EXISTS phone_pins (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id),
  pin     TEXT NOT NULL UNIQUE
);

-- Every number a capture has been tried from. state: 'new' until an
-- organiser has looked at it, 'ok' a payphone, 'no' not one.
CREATE TABLE IF NOT EXISTS payphones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  number     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per team and payphone. submission_id is the entry it made
-- on the tab; NULL while its payphone waits to be confirmed, or with
-- capped = 1 when the quest's code would take no more.
CREATE TABLE IF NOT EXISTS phone_captures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  payphone_id   INTEGER NOT NULL REFERENCES payphones(id),
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  call          TEXT NOT NULL DEFAULT '',
  submission_id INTEGER,
  capped        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, payphone_id)
);

-- Every call that reached a PIN. caller is a short hash of the number,
-- never the number: a mobile that calls by mistake is somebody's own.
CREATE TABLE IF NOT EXISTS phone_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  caller      TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',
  team_id     INTEGER,
  payphone_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_phone_calls_caller ON phone_calls (caller, at);

-- A message somebody recorded on the phone line. The audio is in the
-- bucket under r2_key; rec is the phone provider's id for it, so one
-- sent twice is kept once.
CREATE TABLE IF NOT EXISTS phone_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  rec         TEXT NOT NULL UNIQUE,
  call        TEXT NOT NULL DEFAULT '',
  node        TEXT NOT NULL DEFAULT '',
  team_id     INTEGER,
  payphone_id INTEGER,
  caller      TEXT NOT NULL DEFAULT '',
  r2_key      TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  heard       INTEGER NOT NULL DEFAULT 0
);
