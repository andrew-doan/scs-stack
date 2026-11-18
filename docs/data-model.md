# The data model

Each worker has its own D1 database and R2 bucket. The tab worker's are
`scs-scores` and `scs-submissions`; the check-in worker's are
`scs-checkin` and `scs-checkin-qr`. They are kept apart on purpose: a
reseed of the tab can never touch who is in the building.

`tab/schema.sql` and `checkin/schema.sql` are the source of truth for
the tables. The comments in them say what each column holds.

## Scores: the ledger

Every change to a team's score is a line in `entries`. A team's score
is the sum of the `points` of its lines that are not voided.

- A line records the team, the code, `units` (how much of the code: a
  count, or a fraction for part marks), `points` (what it was worth when
  written), who made it, when it counts from (`at`), and what made it:
  `source_kind` is `submission`, `award` or `balance`, with `source_id`.
- **A line is never edited or deleted.** One that was wrong is voided
  (`voided_at`, `voided_by`, `void_reason`) and stays on the team's
  ledger, struck through.
- `awards` holds the lines made together by a rule rather than a
  review: a challenge's places, a wager's settlement, the EOI. Voiding
  an award voids its lines.
- Two partial unique indexes make scoring happen once:
  `idx_entries_once` allows one live line per source, team and code,
  and `idx_awards_once` one live award per kind and code. A second
  Accept fails its whole batch. An award is written only while no live
  award of its kind is on its quest or its code, so a second award
  writes nothing.
- **The view `held`** is what each team holds on each code: its live
  lines added up (`amount` from the units, `points` from the points,
  `updated_at` the newest line's time). A code whose lines come to
  nothing has no row. Every reader of the tab reads `held`: the
  standings, the stats, the score sheet, the team pages, the recap and
  the dashboard. Totals are always the sum of `points`, never amount
  times the code's points.
- Changing a code's points re-scores every team holding it: each
  affected line is voided and written again at the new points. An
  adjustment's line keeps the points it was given, and so do the lines
  of a challenge's places and a wager's settlement; of the awards, only
  the EOI's follows its code's points. A code cannot change to or from
  tiered or counted while any team holds it.
- **Deleting a quest moves what it leaves behind to one loose, hidden
  code, `DELETED`**: its submissions, and its lines and awards once they
  are voided, each keeping the code it came from in `deleted_from`. Its
  files stay, with its key in `quest_files.deleted_key`. A new quest
  given one of its codes starts with nothing, and wherever a moved
  submission is shown it reads as "SQ12 (deleted)". `EOI`, `ADJ` and
  `DELETED` are kept codes: no quest may take one.
- `completions` is the table from before the ledger. Nothing reads or
  writes it now; the ledger migration read it once.

## Tables in `scs-scores`

**Teams and the tab**

| Table | Holds |
|---|---|
| `teams` | each team: name (unique whatever its case), `hidden` (a test team, off every public read), `dnf` (on the board with no place). An id is never given out twice: `site_flags.team_id_high` holds the highest a deleted team had |
| `entries`, `awards`, view `held` | the ledger (above) |
| `completions` | the old tab, kept for the migration |
| `tab_freeze` | one row: whether the tab is frozen or closed, and the frozen copy of the three standings payloads |
| `tab_snapshots` | saved copies of the standings: one per freeze, one an hour when they moved, and any saved by hand |
| `team_checkins` | teams the check-in worker reported complete, with the time |
| `team_arrivals` | teams part-way in: how many of their people, and when the last arrived |
| `team_tracks` | each team's recorded route for the replay, the GPX file it was cleaned from, what was cut before cleaning, notes, who saved it |
| `photo_places` | where an accepted submission's photo or video was taken, read once from its metadata, so the replay can pick the nearest of a quest's places; never sent out |
| `photo_near` | the stations and the quest's places a proof photo or video was taken near, nearest first, read once from its metadata for a quest shown photo by photo; never the location itself |
| `video_originals` | a proof video's original: when a download sent it whole and when it was deleted from the bucket, leaving the encoder's copies |
| `submission_log` | the audit log: every change, by whom, from what total to what (the Log tab) |

**Quests**

| Table | Holds |
|---|---|
| `quest_regions` | the regions (the site's categories), their order and colour |
| `quest_groups` | a quest as the site shows it: key, name, region, description, pins, the questions the submit form asks, the live question (`ask_*`), visibility, opening time, rules, and whether its points are hidden |
| `quests` | the codes the tab scores: points, the quest they belong to, and how each scores (`scoring`, `most`, `bands`). A retired code ends in `-o` and is hidden |
| `quest_tags`, `quest_group_tags` | tags, which group quests so a set can be opened at once |
| `audiences`, `audience_teams`, `quest_audiences` | team groups, and which quests each may see |
| `quest_files` | files hung on a quest, kept when the quest is deleted (`deleted_key`) |
| `quest_responses` | one answer per team per live question |

**Submissions and files**

| Table | Holds |
|---|---|
| `team_codes` | each team's submit code |
| `submit_sessions` | team sessions from the submit page |
| `submissions` | one row per piece of proof or organiser entry: team, code, status (`queued`, `pending`, `accepted`, `rejected`, `deleted`), answers, who reviewed it, who is looking at it, what it put on the tab (`credit`), and the code it had when its quest was deleted (`deleted_from`) |
| `submission_files` | each proof file's R2 key, type, size, upload state and encoder state |
| `submission_upload_parts` | slices of a large upload that have landed |
| `submission_renditions` | the encoder's 480p, 720p and 1080p copies of a video |
| `encoders` | each computer running the encoder, and its pace |

**The dashboard**

| Table | Holds |
|---|---|
| `console_users` | accounts: password hash, admin, permissions, quests, authenticator secret, whether a code is required |
| `console_sessions` | dashboard sessions |
| `console_backup_codes` | ten hashed backup codes per person, one use each |
| `console_attempts` | every sign-in attempt, for the throttle and the Accounts tab |
| `staged_uploads` | dashboard files on their way straight to R2 |

**Registration**

| Table | Holds |
|---|---|
| `registrations` | one row per sign-up form sent; `hidden` marks a test signup |
| `participants` | one row per person: zID, email, dietary needs, Discord, Arc, their check-in QR, how their email went, their terms acceptance and photo answer |
| `eoi_people` | the expression-of-interest list uploaded on Settings |

**Discord**

| Table | Holds |
|---|---|
| `discord_guilds` | the servers the bot works in, with their organiser, staff and other roles |
| `discord_teams` | each team's role and channel in each server |
| `discord_members` | who has run `/verify`, matched to a signup |
| `discord_role_menus` | the role menus the bot posts |

**Messages, push, email and the home page**

| Table | Holds |
|---|---|
| `messages`, `message_files`, `message_audiences` | organiser messages, their attachments and who may read them |
| `counters` | the version numbers the site polls (`quests`, `messages`) |
| `push_subs` | push subscriptions, linked to a team when signed in |
| `push_outbox` | the rest of a push announcement still to send |
| `email_sends`, `email_queue` | email announcements, and one row per address |
| `countdown_stops` | the home page's countdown |
| `home_slides` | the home page's slideshow pictures |
| `site_text` | words the dashboard sets on public pages, and a few kept values |
| `site_flags` | named switches and numbers: the after-the-event switches (`team_pages`, `recap`, `replay`, `push_off`), the sign-up guard, holding Discord posts, the second-password switches (`guard_<key>`), the limits set on Settings, and markers a migration or the scheduled run leaves |

**Files and albums**

| Table | Holds |
|---|---|
| `drop_files` | files shared from the Files tab |
| `short_links` | `go.scs.andyrew.space` links, to a URL or a file, with a hit count |
| `albums` | albums: who may add, who may look, what they show |
| `album_photos` | each photo or video in an album, with its upload and encoder state |
| `album_upload_parts` | slices of a large album video |
| `album_skips`, `album_teams` | which gallery photos an album leaves out, and which teams' it shows |

`_migrations` is made by the migration runner, not by the schema: it
records which files in `migrations/` have been applied.

## Tables in `scs-checkin`

| Table | Holds |
|---|---|
| `attendees` | one row per registered person: name, email, team, zID, the secret `token` in their QR, the unrelated `qr_key` the image is stored under, when and how they checked in, the tab worker's `participant_id`, and `hidden` for a test person |
| `sessions` | scanner and board sign-ins (`scan` or `board`), 18 hours each |

The two databases match a person on the tab worker's `participants.id`,
which a dashboard edit cannot change.

## R2

In `scs-submissions` the key's prefix says what a file is, and the
random part of the key is what makes its address unguessable:

| Prefix | Holds |
|---|---|
| `sub/` | proof files |
| `alb/` | album photos and videos |
| `msg/` | message attachments |
| `qst/` | files hung on a quest |
| `slide/` | home page slideshow pictures |
| `drop/` | files shared from the Files tab |
| `trk/` | GPX files uploaded on the Routes tab |
| `rnd/` | the encoder's smaller copies of videos |

Beside a file, a suffix marks what was made from it: `.t` the small
copy, `.v` the viewing copy, `.x` the metadata, `.c` a video's copy with
its metadata taken out, `.p` the HEIC or WebP a photo was picked as.
Deleting a file deletes all of these.

In `scs-checkin-qr`, `qr/<random>.png` is each person's QR image. The
tile server's bucket `scs-tiles` holds `my_area.pmtiles`.

## Migrations

`schema.sql` only creates what is missing (`CREATE TABLE IF NOT
EXISTS`). It never adds a column to a table that already exists. So
**a column added to an existing table reaches a live database only
through a file in `migrations/`**.

- `npm run db:migrate` (`scripts/migrate.mjs`) applies the files in
  `migrations/` oldest first, and only those `_migrations` does not list.
  `-- --all` offers every file again.
- Running it again is safe: an `ALTER` already applied comes back as
  "duplicate column name", which the runner passes over. A file that
  was partly applied is retried a statement at a time.
- It sends SQL with `--command`, D1's ordinary query path, so the site
  keeps working while it runs.
- A file that has been applied and is then edited is not offered again.
  A change to a migration is a new file.
- `*.once.sql` files rebuild a table and cannot be rerun. `db:migrate`
  lists them and leaves them to a person. The tab worker has none; the
  check-in worker has `2026-10-shared-zid.once.sql`, to run after
  `db:migrate`.
- `npm run db:check` reads the live schema and lists what is missing
  against `schema.sql`: tables, columns, indexes and column constraints,
  with the migration that would add each. It changes nothing.
- `npm run db:schema` creates missing tables and indexes.
- `tests/verify-migrations.mjs` builds a database the way a real one was
  built (the oldest `schema.sql` in the history, then every migration)
  and fails if it does not match `schema.sql`.

The deploy and database scripts are identical copies in `tab/scripts/`
and `checkin/scripts/`; `verify-migrations.mjs` fails in both workers
if one is edited alone.

## Where to read more

- [`tab/CLAUDE.md`](../tab/CLAUDE.md): "The ledger", "Exactly-once is
  the database's", "Parts and their scoring types", and
  [Migrations](../tab/CLAUDE.md#migrations).
- [`tab/README.md`](../tab/README.md#migrations): the migration
  commands from an operator's side.
- [`checkin/CLAUDE.md`](../checkin/CLAUDE.md): the check-in database,
  the shared id and the `.once` rebuild.
- [`website/questlist/CLAUDE.md`](../website/questlist/CLAUDE.md):
  "Quest data".
