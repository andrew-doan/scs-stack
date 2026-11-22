# SCS.2 check-in

A Cloudflare Worker that runs event check-in end to end: registration
turns a person's details into a QR code, door crew scan those codes
(or look people up by name) on a password-locked page, a second locked
page shows the running totals for the wall, and the moment a team's
last member arrives the tab bot is told, with the time, so on-time
teams can be given their points.

Deliberately separate from everything else: its own worker, its own D1
database, its own R2 bucket, its own secrets. The public website never
links here and cannot call any of it. A tab reseed cannot touch
check-in state, and vice versa.

## How the pieces fit

```
registration script / Discord bot
        │  POST /api/register  (Bearer REGISTRATION_KEY)
        ▼
  scs-checkin worker ──► R2: qr/<random>.png   (QR image, random name)
        │                D1: attendees          (details + times)
        │
        │  door crew: /scan (SCAN_PASSWORD → session)
        │  the wall:  /board (BOARD_PASSWORD → session)
        │
        │  on every check-in and every undo
        ▼
  POST <TAB_API>/api/team-checkin  (Bearer TAB_SYNC_KEY)
        ▼
  tab bot worker ──► D1: team_checkins (complete teams: time, people)
                     surfaced in /api/stats; a line in the
                     team's Discord channel for each person
```

Two things make the QR side safe to leave public:

- The QR encodes `scs2:<token>` where the token is 16 random bytes
  (codes made earlier with 24 still scan). Codes cannot be guessed or
  enumerated.
- The image sits in R2 under a *different* 24-random-byte name, so
  even someone who can list nothing and guess nothing gains nothing:
  knowing an image URL does not reveal a token, and the check-in call
  that accepts tokens needs a scan session anyway.

Passwords are never checked in the page. `/scan` and `/board` are
plain HTML; typing the password calls `/api/login`, the worker
compares it server-side (hashed compare, a short delay on failure) and
hands back an 18-hour session token. Every API call re-checks that
token against D1. Deleting a row from `sessions` signs a device out.

## Set up

Everything happens in this folder.

1. **Install wrangler and log in**

   ```
   npm install
   npx wrangler login
   ```

2. **Create the database and bucket**

   ```
   npx wrangler d1 create scs-checkin
   npx wrangler r2 bucket create scs-checkin-qr
   ```

   Nothing in `wrangler.toml` needs editing: `npm run deploy` looks
   the database up by name on your account.

3. **Load the schema**

   ```
   npm run db:schema
   ```

4. **Set the secrets** (nothing lands in the repo)

   ```
   cp secrets.example.json secrets.json   # ignored by git
   # fill in the four values
   npm run secrets
   ```

   | Secret | What it is |
   |---|---|
   | `REGISTRATION_KEY` | bearer key for `POST /api/register` and the tab worker's status reads; the tab worker's `CHECKIN_KEY` must match |
   | `SCAN_PASSWORD` | what door crew type into `/scan` |
   | `BOARD_PASSWORD` | what the board display types into `/board` |
   | `TAB_SYNC_KEY` | reports of each check-in to the tab worker; the same value goes on the tab worker |

   Make REGISTRATION_KEY and TAB_SYNC_KEY long and random (32+
   characters — `openssl rand -base64 32` is fine). The two passwords
   are what humans type on the day, so make them typeable. Until a
   secret is set, the thing it guards refuses to work — there are no
   default passwords. To change one later, edit `secrets.json` and run
   `npm run secrets` again.

5. **Deploy**

   ```
   npm run deploy
   ```

   This writes `wrangler.deploy.toml` (ignored by git) with the
   database id filled in and deploys with it.

6. **Wire up the tab side.** Set the same TAB_SYNC_KEY on the tab bot
   worker (in `/tab`):

   ```
   cd ../tab
   # TAB_SYNC_KEY, CHECKIN_KEY and CHECKIN_API in its secrets.json
   npm run secrets
   npm run deploy
   ```

   `TAB_API` in this folder's `wrangler.toml` already points at the
   tab worker. If either side is missing the key, check-in keeps
   working and only the reports are skipped.

## Registering people

POST each person to the worker. From a spreadsheet export this is a
few lines of script; the Discord bot can call the same endpoint.

```
curl -X POST https://<your-worker-domain>/api/register \
  -H "Authorization: Bearer $REGISTRATION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex Chen","email":"alex@example.com","team_name":"Team Ferrous","zid":"z1234567"}'
```

The reply carries `qr_url` — a permanent, unguessable link to that
person's QR PNG, ready to drop into an email or a Discord DM. Inputs
are sanitised server-side (control characters and markup stripped,
lengths capped, the email shape checked, the zID normalised to
`z` + seven digits). Registering the same person twice returns the
existing QR instead of minting a duplicate, so the script can be
re-run safely.

The body may also carry `participant_id`, the tab worker's own id for
that person. It is stored, and a later registration finds them by it
first — names and teams get edited on the dashboard, that number does
not. A match also refreshes the stored name, email and team from what
was just sent, so re-registering someone repairs a row left behind by
a rename. When a rename is all that changed, the tab worker posts it
straight to `/api/rename`:

```
curl -X POST https://<your-worker-domain>/api/rename \
  -H "Authorization: Bearer $REGISTRATION_KEY" \
  -H "Content-Type: application/json" \
  -d '{"people":[{"participant_id":41,"name":"Alex Chen-Reid","team_name":"Team Ferrous","was_name":"Alex Chen","was_team":"Team Ferrous"}]}'
```

Up to 200 people at a time. Each is found by `participant_id`, or by
`was_name` and `was_team` when the row predates that column. The reply
is `{"ok":true,"updated":1,"missed":[]}`; anyone who could not be
found comes back in `missed` rather than failing the call.

## On the day

- **Door crew** open `/scan`, type the scan password once per device,
  and point the camera at codes. Each scan shows the person's name and
  their team's progress (green for a fresh check-in, yellow if they
  were already in, red for a code that is not on the list), with a
  button to scan the next one. The Search tab finds anyone by name,
  team or zID for manual check-in, with an Undo for mis-taps. Manual
  and QR check-ins are recorded separately (`checked_in_by`).
- **The wall** opens `/board`, types the board password, and gets a
  check-in wall in the style of Tabbycat's status board: people-in and
  teams-complete counters, then one chip per person, solid green with
  the arrival time once checked in, grouped under a sign bar per team
  with its count (the bar goes green when the team is complete). A
  filter box, Hide checked in / Hide absent rockers, and by-team /
  by-name / by-time sorts drive it; it refreshes every 10 seconds and
  an arrival pops on its own chip. Names and times only: zIDs never
  reach the wall. `node tests/verify-board.cjs` drives the page in a
  real browser.
- **Times**: every check-in stores `datetime('now')` (UTC). A team's
  completion time is its last member's check-in time, and that is what
  gets reported to the tab. Award the on-time points through the
  normal `/submit` flow using the times in the tab's `/api/stats`
  (`team_checkins`).

## API summary

| Route | Auth | What |
| --- | --- | --- |
| `POST /api/register` | Bearer REGISTRATION_KEY | create person, render QR, return `qr_url` + `token` (packed into the site's ticket links) |
| `POST /api/rename` | Bearer REGISTRATION_KEY | move a person or a whole team to a new name; the tab worker calls it after a dashboard edit |
| `POST /api/hide` | Bearer REGISTRATION_KEY | mark people as test people, kept off the board, the scanner's list and the counts; the tab worker calls it when a team or signup is hidden there |
| `POST /api/personal/export`, `/clear`, `/restore` | Bearer REGISTRATION_KEY | every person's email address and zID; take them off (only when the list sent holds all of them as they are) and put them back. The tab worker's Personal data card calls them |
| `GET /qr/<key>.png` | none (unguessable name) | the QR image |
| `GET /qr/demo.png` | none | a code to look at, not to scan anybody in with: drawn on the spot from a fixed string, nothing stored. The dashboard's test ticket email uses it so a test send does not put a person who does not exist on the board. |
| `POST /api/login` | password in body | `{session}` token, role `scan` or `board` |
| `POST /api/checkin` | scan session | by `{token}` (QR) or `{id}` (manual) |
| `POST /api/uncheckin` | scan session | undo by `{id}` |
| `GET /api/attendees?q=` | scan session | search for the manual list |
| `GET /api/status` | scan or board session, or `Bearer REGISTRATION_KEY` | totals + per-team progress; the tab worker reads it to mark who has checked in |
| `GET /scan`, `GET /board` | page is public, data is not | the two organiser pages |

There is no CORS on any of this — browsers on other origins (the
public site included) cannot call the API at all. The pages work
because they are served from this same worker.

## Backups

```
npm run backup                # the check-in database, as one SQL file
npm run backup -- --photos    # and the QR images in its bucket
```

The same command as the tab worker's (its README has the detail): a
dated SQL file in `backups/`, git-ignored, and with `--photos` a mirror
of `scs-checkin-qr`, which needs an R2 API token in `backup.json` (copy
`backup.example.json`). The QR images can be drawn again from the
tokens in the database, so the database is the part that matters.

## Updating the worker

Edit, then `npm run deploy`.

### The database

Four commands, and the difference between them is worth knowing before
you need it:

```
npm run db:check      read the live database and say what it is missing
npm run db:schema     create the tables and indexes that are not there
npm run db:migrate    apply the migrations/ the database has not had, oldest first
```

(`npm run secrets:check` is the same idea for the four secrets: it
lists which of them the live worker actually has. Names only — nothing
returns a value.)

`schema.sql` is the whole schema, written entirely as `CREATE TABLE IF
NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so `db:schema` is safe to
run against a live database. **It cannot add a column.** Re-running a
`CREATE TABLE` over a table that already exists does nothing at all —
it does not compare columns — so it exits successfully and changes
nothing. An index it can add, because `CREATE INDEX IF NOT EXISTS` on
an existing table is a real statement that does real work.

So a new column goes in `schema.sql` *and* in its own file in
`migrations/`, or a live database has no way to get it. `db:migrate`
applies those oldest first and is safe to rerun: SQLite has no `ADD
COLUMN IF NOT EXISTS`, so an ALTER that has already been applied is an
error, and the runner counts that and carries on rather than stopping.

`db:check` is the one to run when something is wrong and you do not
know what. It reads the live schema and compares it with `schema.sql` —
tables, columns, indexes and the column constraints — and prints what
is missing along with which of the commands above would fix it. It only
reads.

### The files in migrations/

`2026-10-participant-id.sql` adds `attendees.participant_id`, the tab
worker's id for the same person, so a rename over there can be pushed
here. `npm run db:migrate` applies it.

`2026-10-shared-zid.once.sql` drops the UNIQUE on `attendees.zid`,
which stopped a second person marked `z0000000` (not a UNSW student)
from registering at all. SQLite has no `DROP CONSTRAINT`, so it copies
the rows out, drops the table, creates it again and copies them back.
**That is why it is named `.once` and why `db:migrate` lists it instead
of running it**: nothing in SQL like that can say it has already been
done, and a loop would redo the whole thing every time. Run it by hand,
after `db:migrate` (it carries `participant_id` across, so the column
has to exist):

```
node scripts/deploy.mjs --dry
npx wrangler d1 execute scs-checkin --remote \
  --config wrangler.deploy.toml --file=migrations/2026-10-shared-zid.once.sql
```

`npm run db:check` says whether it is still needed — a live table still
carrying `UNIQUE` on `zid` is reported under "Column constraints that
do not match schema.sql". A database created from the current
`schema.sql` needs neither file.

The `--config wrangler.deploy.toml` is not optional: the committed
`wrangler.toml` carries a placeholder `database_id`, and plain
`wrangler d1 execute` reads it and fails saying it is not a uuid, which
reads like a missing database. `node scripts/deploy.mjs --dry` writes
the filled-in config; the npm commands above do it themselves.
