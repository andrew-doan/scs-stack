# The check-in worker


Separate worker, D1 (`scs-checkin`) and R2 bucket (`scs-checkin-qr`) —
deliberately unreachable from the website (no CORS anywhere). It has
its own copies of the small helpers (it cannot import from
`/tab`). `POST /api/register` (Bearer `REGISTRATION_KEY`)
sanitises name/email/team/zID (an address is required — that is what
stops a dashboard-added person with no email getting a code), mints two
unrelated base64url randoms — `token` (16 bytes; QR payload `scs2:<token>`; older 24-byte
tokens keep working, the scan takes 16–64 chars) and `qr_key` (24
bytes, the R2 object name) — renders the QR in-worker (vendored
`qrcode-generator` + hand-written `png.js`) and returns `qr_url`
(`/qr/<key>.png`, unguessable, cached forever) plus the `token`,
which the tab worker packs into ticket links (rego keeps it in
memory only, `member.checkin_token`; a resend re-registers, which is
idempotent on zID, to get it again). `GET /qr/demo.png` is the one code that is not anybody's: it is drawn
on the spot from `scs2:demo`, stores nothing and is served like any
other code image, so the tab worker's test ticket email can show a
code in the place a real one goes without registering a person nobody
can take off the board again. `/api/status` reads the roster once
and derives totals and the per-team rollup in JS. `/scan` and
`/board` are served by the worker (`pages.js`): sign-bar header,
sliding-pill tabs, shake on a wrong password, a verdict panel with
distinct checked-in / already-in / not-found states (vibrate only on
a fresh check-in), and a board whose chips are kept between refreshes
so an arrival pops on its own chip; counters pop their digits, the
timestamp swaps in place. **Auto scroll** (a rocker on the board, kept in
localStorage `scs-checkin-board-auto` on that screen) is for the board on
a wall: four seconds at the top, down at 40px a second, four at the
bottom, a glide back up and round again, measured each frame so a wall
that grows or shrinks on a refresh is followed; a wheel, a touch, a
click or a key holds it for ten seconds and it carries on from wherever
the reader left the page. A wall that fits the screen does not move.
The counts (people in, teams complete and the updated time) are
`position: sticky` at the top of the window on the page's own ground
with a hairline under them, so the names scroll under them and the
numbers never leave the screen; the filter and the switches below
scroll away with the wall. Passwords (`SCAN_PASSWORD`/`BOARD_PASSWORD`)
are checked server-side only for an 18h D1 session; roles enforced.
On every check-in and every undo the worker POSTs `/api/team-checkin`
to the tab worker with Bearer `TAB_SYNC_KEY`: the team, whether it is
complete, how many of how many are in, when the last of them arrived
(`last_at`), when this change happened (`at`), and the person and the
event (`in` or `out`). The tab keeps the complete teams, passes over a
report older than one it already has (reports are separate requests
and can arrive out of order), and posts the line in the team's Discord
channel. A report is sent once and never again; an answer that is not
2xx (a `TAB_SYNC_KEY` that does not match, say) or a failed fetch is
logged with `console.error`, and the tab records a completion it missed
from its next read of `/api/status` (`reconcileCheckins`,
`tab/CLAUDE.md`). **A check-in lands only on a person not yet in, and an undo
only on one who is** (`checked_in_at IS NULL` / `IS NOT NULL` in the
UPDATE), so two scanners on one code, or an undo tapped twice, report
once; the other reads as already in. A hide that changes a person's
flag reports their team too, with no person and no event, since hidden
people are left out of its count.
`checkin/tests/verify-board.cjs` drives the board in a real browser;
`tests/verify-migrations.mjs` is the database guard (`npm test` runs
both).
**`attendees.zid` is not UNIQUE on the column**: z0000000 is the
shared not-a-UNSW-student marker and stands for no zID at all, so a
second person carrying it could not be inserted — `/api/register`
answered 500, the dashboard showed "the check-in worker answered
500" and the public form quietly emailed that person a confirmation
with no ticket in it. A partial unique index
(`idx_attendees_zid … WHERE zid <> 'z0000000'`) keeps real zIDs
unique instead, and `handleRegister` matches shared-marker people on
name + team so a repeat registration stays idempotent while two
different people each get their own code. SQLite cannot drop a
column constraint, so an existing database needs
`migrations/2026-10-shared-zid.once.sql` run once by hand; a fresh
schema.sql database needs none of it.
**The two databases share the tab worker's `participants.id`**
(`attendees.participant_id`, plain index). It is the one thing about a
person that a dashboard edit cannot change, so it is what the two
sides match on. `/api/register` takes it in the body, looks a person
up by it first and falls back to the zID (or name + team for
z0000000); on a match it refreshes that row — name, email, team_name,
and the id when the row had none — and hands back the same token and
image, so a match can never mint a second identity. The insert for a
person nobody matched asks the same match again in the same statement
(`MATCH`), so two registrations of one person at once (the tab's sweep
and a Create QR, say) make one row: the second adds nothing, answers
with the first one's code and deletes the image it drew. That refresh is
what makes the Rego tab's Create QR code repair a row left stale by a
rename. A person registered for the first time carries no id: the tab
worker writes their `participants` row after minting the code, so the
row starts without one and the next registration fills it in.
**A row another participant holds is never matched by zID** (nor by
name and team for z0000000): `findAttendee` and `MATCH` both carry
`participant_id IS NULL OR ? IS NULL OR participant_id = ?`. The tab
does not send a zID change across, so a person whose zID an organiser
corrected still holds the wrong one here, and its real owner signing up
used to match that row and be handed the first person's code. Now the
owner's insert meets the unique zID index and is answered 409 ("zID is
on another person's code"), and a registration that matches by the
shared id takes the zID it was sent (`UPDATE OR IGNORE`, so one still on
another row is left alone): Create QR code for the corrected person
carries the correction across, which frees the zID for its owner. A
person added on the dashboard is registered before their participants
row exists, so carries no id, and still matches by zID alone.
`POST /api/rename` (Bearer `REGISTRATION_KEY`, unset key 403, wrong
key 401) is how a rename gets across: `{people: [{participant_id,
name, team_name, was_name, was_team}]}` (a single person sent bare
works too; at most 200 at a time), each row found by the id and then
by `was_name` + `was_team` case-insensitively — that is how rows
written before the column existed are found on their first rename —
then written in one `batch`. It answers `{ok, updated, missed}`;
matching nobody is an ordinary answer with the entry in `missed`,
never a 500. `/api/status` carries `participant_id` on each roster
row so the tab worker marks the right person after a rename.
`migrations/2026-10-participant-id.sql` adds the column and index to an
existing database.
**Test people are kept off the door** (`attendees.hidden`, migration
`2026-10-hidden.sql`). The tab worker decides who is one — a person
whose team is hidden on the tab, or whose signup with no team is — and
sets the flag through `POST /api/hide` (Bearer `REGISTRATION_KEY`,
`{people: [{participant_id, name, team_name, hidden}]}`, matched the way
a rename is, at most 200, answers `{ok, updated, missed}`). A hidden
person is left out of `/api/status`'s counts and team rollup, out of the
board's and the scanner's `people_list`, and out of `/api/attendees`
(the scanner's list and search); their code answers 409 `{hidden: true,
name, team_name}` and checks nobody in, which the scanner shows as a
Test ticket. The tab worker's own read of `/api/status` (the
registration key) still gets every person, each carrying `hidden`, so
it can see which flags are wrong and put them right, and each carrying
`zid` and `email`, which is how it finds a row written before the
shared id under a team name it has since changed. The board and the
scanner get neither. The `.once` rebuild
carries the column across, so run `db:migrate` before it as the note
above says.
**Taking people's data off** (`/api/personal/export`, `/clear` and
`/restore`, Bearer `REGISTRATION_KEY`; called by the tab worker's
Personal data card, `tab/src/privacy.ts`). Export answers every row
holding an email address or a real zID. Clear takes `{people: [{id,
email, zid}]}` and refuses with 409, changing nothing, unless the list
holds every such row with the same values, so nothing goes that the
organiser's file does not hold; then each email becomes '' and each real
zID `removed-<id>`, because the column is NOT NULL and real zIDs are
unique (and an older database is still UNIQUE on the column), so an
empty one could stand on one row only. z0000000 stays. Restore puts each
back only where it was taken off, with `UPDATE OR IGNORE`, so a zID
somebody has registered with since is left off that row rather than
failing the rest. Nothing reads a `removed-` zID as a zID: register
matches people by the shared id first, and the tab's roster sync skips
anything that is not a zID. `tab/tests/verify-privacy.mjs` runs both
workers through it.
**The database commands** are the bot's, over `scs-checkin`:
`npm run db:schema` (creates missing tables and indexes, cannot add a
column), `db:migrate` (applies `migrations/` oldest first, safe to
rerun) and `db:check` (reads the live schema and says what is missing —
tables, columns, indexes and the column constraints — and alters
nothing). `scripts/` here is a byte-identical copy of `tab/
scripts/`, because this worker is a separate package and cannot import
from there; `dbName()` reads the name out of this folder's own
`wrangler.toml`, and `tests/verify-migrations.mjs` (also a copy) fails
in both workers if one is edited alone.
**`2026-10-shared-zid.once.sql` is named `.once` because it cannot be
re-run**: it rebuilds `attendees` rather than altering it, so
`db:migrate` lists it and leaves it to a person. Run it **after**
`db:migrate` — the rebuild copies `participant_id` across, so that
column has to exist by then, and the file order (p before s) is already
that way. It is the reverse of what this said before, and the earlier
order lost every shared id and `idx_attendees_participant` with nothing
failing to say so. `db:check` reports a live table still carrying
`UNIQUE` on `zid` under "Column constraints that do not match
schema.sql", which is how to tell whether the rebuild has been done.
**Beware writing regexes like `[\u0000-\u001f]` via tool JSON: the
escapes become literal control bytes; double the backslashes, and
check with a byte scan afterwards.**

**The QR reader's script is asked for again until it arrives**
(`needJsqr` in pages.js, half a second doubling to eight). The scanner
used to start its camera without it and read nothing, with no message.
