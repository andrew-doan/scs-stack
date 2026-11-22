# The tab worker

One Cloudflare Worker: the public read-only JSON API the site runs on,
web submissions, push, registration, the organisers' dashboard and the
Discord slash commands. The folder was called `discord-bot` and the
Discord side is about a sixth of it, which is why it is not any more.
The site-side pages that read it are written up beside their own code.

Single Worker behind Discord's interactions endpoint (Ed25519-verified
POSTs; no gateway) plus a public read-only JSON API with open CORS:
`/api/leaderboard`, `/api/quests`, `/api/stats`, `/api/questlist` and
the rest — Cache-API cached 30s, the leaderboard, the stats and
`/api/tab` (the two in one answer, which the live tab polls) 10s
because the live tab asks every 10 (`s-maxage`, `LIVE_PATHS` in
index.ts), purged on any accepted write — **on every hostname, not
just the one the write arrived on**. **Every cached read carries a
weak ETag** (`bodyTag`, a SHA-1 of the body, stored with the copy) and
answers 304 with its CORS and cache headers to an `If-None-Match` that
names it (`tagged`). Browsers get `max-age=0` and the site fetches
with `cache: 'no-cache'`, so the browser sends its copy's tag and an
unchanged answer is a 304 with no body; the page sending the header
itself would make every request a CORS preflight, and weak because
Cloudflare turns a strong tag weak when it compresses. The copy is
kept under the address with its query (`cache.match(request.url)`, not
the request, so a conditional header never decides what is served):
`/api/questlist?v=N`, which the site asks once the pulse names version
N, is a copy of its own, so a data centre that missed a purge cannot
hand an older list back for it. `/api/questlist` carries `version`, the
quests counter read before the list is built. `/api/stats` is the
totals and `submissions_pending` and nothing else: it also carried
Discord `/submit` counts per hour and the teams fully checked in, read
by nothing, and every phone on the live tab downloaded them every ten
seconds; the check-ins are read from `team_checkins` by the recap and
the team page. One worker answers on several
(`files.scs.andyrew.space` for the site, `dashboard.scs.andyrew.space`
for organisers) and the Cache API
is keyed by the whole URL, so a copy stored under one is invisible to a
purge aimed at another: a score set in the dashboard purged nothing the
site reads and sat stale on the tab for the full 30 seconds.
`purgeOrigins(env, origin)` in index.ts builds the list from the
request's own origin plus `PUBLIC_API` (`wrangler.toml` `[vars]`). A purge is `cache.delete`, which only
reaches the data centre that ran it: every other one keeps its copy
until it expires, so for a phone served elsewhere the expiry, not the
purge, decides how late a score arrives. `PUBLIC_API` is also what the Discord
cross-post builds its file links from, so an organiser posting from the
dashboard cannot put the dashboard's hostname in a public channel; it
falls back to the request origin when unset. `verify-messages.mjs`
covers both. **What a build costs** (an audit of the day's hot paths): a cached read
is 0 statements, and a miss was a run of reads one after another. The
copy is kept under origin and path alone (`cachedApi`; the quest list
keeps its `v`), so any other query string is the same copy rather than
a build of its own. `/api/tab` reads the freeze gate and the date rules
once for both halves and builds them side by side (`dateRules`,
`undatedBy`), `lastScored`'s two queries and the pulse's four
independent reads go out together, and `afterPagesShut` reads the two
switches without the frozen copy beside them. `ledgerReady` is asked of
a database until it says yes and not again in that isolate. A proof
file's row is found by `idx_subfiles_key` (migration
`2026-12-subfiles-key.sql`): `submission_files` had an index on its
submission alone, so every thumbnail the edge did not hold read the
whole table.
**Cloudflare limits the account, not the worker**: on the free Workers
plan every worker on the account together (this one, the map tiles'
and the check-in worker) gets 1,000 requests a minute and 100,000 a
day. Past the first Cloudflare answers 429 with its error 1015 page,
past the second error 1027, before the worker runs, and with no CORS
header, so a page on the site sees a dropped connection and only the
dashboard, on its own origin, sees the 429. Every album thumbnail, every
upload slice and every page's polling is a request: one person
scrolling a large album while uploading can reach the minute's limit,
and the live tab, two requests every ten seconds, reaches it with about
85 phones open on it. The paid plan has no per-minute limit, and the
account is on it, so **a 429 there comes from in front of the worker**:
nothing in the worker answers 429 to a thumbnail, an album list or an
organiser's upload (its own 429s are the sign-in throttle, an open
album's hourly limit, sign-ups, push subscriptions and a team's review
cap, and an R2 failure comes back as 500 or 502). A Cloudflare one says
"Error 1015" with a Ray ID, and the zone's Security, Events names the
rule; a rate limiting rule that matches the dashboard's whole hostname
is met by scrolling an album grid, one request per thumbnail. What the pages do
about it: the dashboard's uploads wait out a 429 (`waitOutLimit` in
`src/dash/js/uploads.js`, 20, 40, 60 and 60 seconds) — the album upload on
the upload, each slice's signature, each slice and the finish, its row
saying so, and a staged file on its start, each slice's signature and
its finish, a toast saying so; `api()` hands a 429 back as `{status:
429, error}` rather than reading Cloudflare's page as JSON; the album page tries a
send four more times over about a minute (`SEND_WAITS`); the dashboard's reads are asked again three times when the request does not arrive or a gateway answers 502, 503 or 504 (`ask` in core.js; a write is sent once), its first load every five seconds until the console has its data (`refresh` in tabs.js, which used to leave the page blank), and the spinner's teams the same way; and pictures
that fail together back off (`retryAfter`, `website/assets/CLAUDE.md`).
**`src/shared.ts` holds
every cross-module helper** — `json`/`corsJson`, `cleanText`,
`cleanBody` (markdown text: line breaks kept, other control characters
out), `configured` (a secret still reading `PASTE…` counts as unset),
`secretMatches` (hashed compare), `bearerToken`, `randomKey`/`b64url`,
`drain`, `delay`, `normQuest` (hyphens kept: `SQ2-3` ≠ `SQ23`),
`serveStoredFile` (R2 with Range passthrough), `utcStamp` (now as
`YYYY-MM-DD HH:MM:SS`) and `readStamp` (a typed UTC stamp cleaned to
that shape, T or space, '' when unreadable). Modules import from it; don't re-implement. Multi-row
writes go through `env.DB.batch` (the test shim `tests/d1-shim.mjs`
runs a batch as one sqlite transaction).
**Freezing the tab** (`src/freeze.ts`, `tab_freeze` one row): partway
through the day the public tab stops. Freezing renders
`/api/leaderboard`, `/api/quests` and `/api/stats` as they stand and
stores them as `snapshot`; while frozen those three paths answer with
the copy and the live tables are never asked. The check lives at the
top of `apiResponse`, the one place public payloads are built, so a
new route cannot forget it — and an unreadable or missing snapshot
answers `{frozen: true}` with no data rather than falling through.
Discord reads are covered too (`stoppedFor`): `/leaderboard` and
`/score` answer from the copy, `/quest` waits, and organisers
(`writeGuard` returning null) get the live answer **as an ephemeral
reply** (flags 64, `liveToOrganiser`), frozen or closed, because a
plain reply in a channel is read by everyone in it; their `channel:`
is refused with the reason while the tab is stopped. Console:
`GET/POST /api/console/freeze`, logged as `tab-freeze`/`tab-unfreeze`,
cache purged; the dashboard's own queries never go through
`apiResponse`, so organisers always see the real tab. The live tab page ices over (`html.tab-frozen`, `#tab-ice` built by
`Ice` in scs2-tab.js, z1040 so it stays under the z1100 chrome and
`pointer-events: none`, so the page still scrolls and taps through it):
a slab over the whole screen (`.tab-ice::before`, a cold wash and a 1px
backdrop blur), a canvas of frost growing in from the frame with light
bands and a few straight fractures across the middle, a second canvas
of falling snow (left out under reduced motion), and icicles under a
ledge of snow appended inside `.site-nav` so they leave with the bar.
All of it is drawn, seeded per screen size so a resize does not
reshuffle it, and redrawn when the theme changes. The line under the
title reads "Standings as of" the freeze time, to the minute, with a
snowflake in place of the refresh mark; there is no FROZEN word.
**Closing the tab** (`tab_freeze.closed`/`closed_at`, migration
`2026-10-tab-copies.sql`; console `freeze/close {closed}`, logged
`tab-close`/`tab-open`, purged) goes further than the freeze: the
three paths answer `{closed: true}` and nothing else, ahead of the
freeze in the same gate (`tabState` reads both halves from the one
row). It sits on top of a freeze rather than replacing it, so opening
again shows the frozen copy, or the live tab. Everything the freeze
stops checks it too: the score sheet answers `{ok, closed}`, Discord's
`/leaderboard`, `/score`, `/quest` and `/list` say "The tab is closed
until the ceremony.", `/api/team` and `/api/recap` are 404 whatever
their switches say, and the team channel posts leave the total out.
**The freeze shuts the after-the-event reads as well** (`afterPagesShut`
in recap.ts): `/api/team`, `/api/recap`, `/api/recap/quest`,
`/api/replay` and `/api/replay/route` read the live tables, so while
frozen they are 404 like while closed, and the pulse reports
`team_pages`, `recap` and `replay` off so nothing links to them; the
pages say not open, as they do before the switches go on.
`/list` was not stopped by the freeze before, and leaked a team's live
total; it waits for the thaw with `/quest` now. On the site the live tab
puts a sign (`#tab-closed`, `html.tab-closed`) where the board was and
keeps the closed answer as its kept copy, the submit page's score
section says scores are hidden, and the quest sheet's teams line drops
its kept counts.
**Saved copies** (`tab_snapshots`: `taken_at`, `kind` freeze/hand/hour,
`taken_by`, `digest`, `summary` with the team count and the top three,
and the three payloads in `snapshot`; same migration). `setFrozen`
saves every fresh freeze as one. **A press repeated changes nothing**: a fresh freeze writes
only while the tab is live and a thaw only while it is frozen, closing
or opening only when it changes `closed`, each in the statement, and
one that changed nothing answers the state as it stands and is not
logged, so two Freeze presses at once keep one copy and a second Close
keeps the time it closed. **Save the standings now** (`freeze/save`) saves one by hand;
and the scheduled run's `hourlyCopy` saves one at the first tick of each
hour (`site_flags.tab_copy_hour` marks the hour as checked, so the other
ticks cost one read; the mark is claimed with an upsert that writes only
over an older hour, and only the run whose claim changed the row goes
on, so two overlapping runs save one copy), skipped while nobody has scored and when the
board's digest matches the last hourly copy. The newest 240 hourly
copies are kept. **A copy is always of the live tables**:
`livePayload(path, db)` in index.ts is the public payloads' live half,
handed to the console and to the scheduled run, because a copy saved
while frozen has to be of the tab and not of the frozen copy (the old
renderer went through the freeze gate, which was harmless only because
it was never asked while frozen). `freeze` with `copy_id` puts a copy
back up with its own time as `frozen_at`, also while frozen, which is
how a thaw by mistake is undone. `GET freeze` lists the copies;
`GET freeze/copy?id=` answers one board and the board of the copy
before it, and the card draws the change between them (points and
places), stepping Earlier and Later hour by hour; `freeze/copy/delete`
removes one. The second password's `freeze` switch covers closing too.
`tab_snapshots` rides the full export.
`tests/verify-freeze.mjs` covers it.
**What the live tab's columns read** (`apiResponse` in index.ts):
`/api/leaderboard` carries `last_quest` `{code, name, at}` per team —
the team's newest accepted submission by `submitted_at` (an organiser's
entry by the time it is recorded for), joined through `quests` to
`quest_groups` for the name (the code when there is no group), `null`
for a team that has scored nothing. **It is the team's last accepted
submission, not its last change of score**: an award by place, a wager
settled or the EOI has no submission row and never shows, an
organiser's entry that took points off is skipped and so is an
adjustment (a credit carrying `points`, which on a tiered or counted
code has amount 0), and an award landing
on a code the team already held (which restamps that completion) no
longer pushes the quest out from under the cutoff. A team with no such
submission falls back to its newest completion worth something, for
scores from before every change was a submission row. `lastScored` is
two grouped queries rather than one per team: SQLite takes the bare
columns from the row `MAX()` picked. `/api/stats` carries `submissions_pending`, the
submissions still waiting on review, hidden teams left out like every
other public number. Both paths are in `FROZEN_PATHS`, so the freeze
stops the new fields with the rest of the payload and needed no code
of its own — `verify-freeze.mjs` checks that rather than assuming it,
scoring a quest and queueing a submission while frozen and proving
neither shows.
**Messages + pulse** (`src/messages.ts`): `counters` (name→value,
rows `quests`/`messages`, moved forward by writes and either way by the
dashboard's manual set, and the site follows either; `website/assets/CLAUDE.md`,
What the device has seen), `messages` (`sort`, `hidden` = draft, `archived`, `urgency`
silent/normal/urgent) and `message_files` (R2 keys under `msg/` in
the SUBMIT bucket, thumbs at `<key>.t`). Public reads, built in
`apiResponse` **above** the freeze gate so a frozen tab still
answers live: `GET /api/pulse` `{quests, messages, message_seqs, urgent}` (urgent
= the id of the live urgent message with the highest seq, else 0; per
reader, below) and `GET /api/messages`
(hidden + archived excluded, array order = display order:
`ORDER BY sort, created_at DESC, id DESC`, each with its `seq` so the
site marks read exactly what it drew); files at
`GET /api/messages/file?key=` (+`&thumb=1`), key-gated like submit
files; both paths are in the purge list. Counter bumps: creating a
message bumps `messages` unless it is `silent` or a draft —
publishing a draft bumps, ordinary edits never do; any successful
console `quests/*` write bumps `quests` once, at the routing level
in console.ts. **Who reads a message** (`messages.visibility`,
`message_audiences`, migration `2026-10-message-audience.sql`) is the
choice a quest has, from the composer's Who can see it: `everyone`,
`teams` (any team signed in with its submit code) or `groups` (the
teams in the team groups ticked); a draft is the organisers'.
`messageSeenSql` in access.ts is `canSee` written as SQL, because the
messages are read as a list with a limit. The public `/api/messages`
and `/api/pulse` carry everyone's messages only; a signed-in team asks
`GET /api/messages/team` and `GET /api/pulse/team` (Bearer submit
session, `private, no-store`, a bare 401 when the session is unknown,
routed through `apiResponse` with a viewer so publishing still runs
first). **The bell is per reader**: each message stores `seq`, the
`messages` counter's value when it went up (`bumpForMessage`, the bump
and the stamp in one batch; silent ones get none), and the pulse's
`messages` is the newest seq the reader can see, with `message_seqs`
(the newest fifty) for the bell and the app icon's count, and `urgent`
the urgent message the reader can see that went live last — so a
message for some teams lights nobody else's dot. **A new seq is above
every seq already given**: the counter moves to the larger of one past
itself and one past `MAX(seq)`, so a counter set back by hand cannot
number a new message below an older one (the pulse's `messages` would
not move, and the urgent pick would stay on the older one). **The urgent
pick is by seq, not id**: ids are fixed when a message is written, so a
message scheduled after one written later, a draft published later, an
older message edited to urgent and an unarchived urgent one never came
first. Publishing (a save or `publishDue`) already stamped a seq; a save
that turns a live message urgent restamps it, decided by a conditional
write in the save's batch ahead of the publish so a draft published as
urgent counts once, and `messages/archive` restamps a live urgent
message it unarchives (`UPDATE … WHERE archived != ?2 RETURNING`, so two
at once restamp once). An ordinary edit renumbers nothing. The
migration numbered the messages already up,
newest first ending at the counter, once (`message_seq_seeded`). The
counter itself still moves on every message and is what the dashboard
sets by hand; raising it by hand no longer lights anybody's bell until
the next message, and lowering it changes nothing on the site until a
message is posted, which still takes a seq above the rest. **A push and a Discord post follow the audience**: a
message for some teams pushes only to devices linked to those teams
(`sendAllPush(…, teamIds)`; the outbox keeps the list in
`push_outbox.team_ids` for the batches after the first) and posts in
those teams' own channels rather than the announcements channel
(`teamChannels`, hidden teams left out, the server's automatic-posts
switch ignored because an organiser ticked this one). Deleting a team
group takes its messages away from its teams, as it does its quests.
**No list says who else can read a message.** `verify-messages.mjs`
covers the lists, the pulse, the push and the Discord post per
audience, and the seqs and the urgent pick after a counter set back
and in each of the four late-going-live cases, `verify-bell.cjs` the
site's read and dismissed sets, the site asking for the team's copies and
never painting a team's kept copy signed out, and
`verify-console-ui.cjs` the composer's fields. **Scheduled publishing**: `messages.publish_at`
(migration `2026-10-day-ops.sql`; the dashboard's Publish at field,
datetime-local converted to UTC) — a future time forces the save
hidden, and `publishDue(db)` runs in `apiResponse` before the pulse
and messages payloads (the site polling is the clock, and a Cron
Trigger is the floor under it — see **The worker's own clock**):
due rows flip live, the stamp comes off (put back into
drafts, it stays a draft), `messages` bumps unless silent, logged
`message-publish` actor `schedule`, cache purged. The flip is one
`UPDATE … RETURNING` that asks again whether each row is still hidden,
scheduled and due, and only the rows it changed are logged and bumped,
so pages polling at the same moment publish a message once; an
archived message is never due. A save that puts a draft live decides
so from its own conditional write, not from what it read, so a save
and `publishDue` at once bump once between them. It must never
throw — it runs in front of the pulse. A scheduled publish reaches
the site only: no push and no Discord cross-post, which happen on
an explicit save alone. **Posted at** (`posted_at` on
`messages/save`, the composer's Posted at field) is the other way
round: a time already past (no more than five minutes ahead, never with
a future Publish at) is written as the message's `created_at`, so it
goes in the list where that time puts it, and the save moves no counter
and sends no push and no Discord post whatever was ticked — it fills in
the history. With no seq it lights no bell dot and no pop-up. Empty on
an edit keeps the date. `verify-messages.mjs` covers it. Console actions `messages/list|save|delete|archive|
order|file/delete`, `counters`, `counters/set` (log: `message-post/
edit/archive/unarchive/order/delete/discord`, `counter-set`).
`messages/save` is multipart (≤6 files ≤25MB, images/PDF/docs,
canvas thumbs made in the page); `push: '1'` needs the Push tab and
the second password when sending a push asks for it (the header, as
everywhere; wrong = 403 and nothing saves), then goes out via
`sendAllPush` in push.ts; a "Post to Discord"
tick (on by default) cross-posts new messages to each enabled
guild's `announce_channel_id` (picked in the Discord tab's server
card, saved by `discord/guild/save`) in `ctx.waitUntil` — bold
title, body, absolute file links, 2000-char cap; failures log,
never fail the save; edits never re-post. **Those links end in the
file's name** (`fileLink`, `GET /api/messages/file/msg/<key>/<name>`,
extension from the type via `fileNameFor`): Discord decides whether a
link is a picture from the URL's shape alone, and `?key=` with nothing
on the end is not one to it, so a cross-posted GIF arrived as a bare
link instead of playing. The path serves exactly the same bytes — the
key is still the whole capability, the name is only there to be read —
and the `?key=` form keeps working for everything already linked and
for the site itself. The dashboard's Messages
tab does compose/edit/hide (drafts)/reorder (up/down writing
`sort`)/archive (its own view, unarchivable from there)/urgency,
and the reusable markdown toolbar + preview wraps the message body
and the quest description editor (the message body's toolbar also
has a Quest button inserting `[[quest:]]`, and the preview shows a
token as a stub box). A body line of its own reading `[[quest:KEY]]`
is a quest embed: the site renders the card; the public payload
keeps the token; `expandQuestTokens` (quest matched by group key or
any code) turns it into the quest's code and name for readers that
cannot render it — with a `SITE_URL/questlist/#KEY` link for the
Discord cross-post, name alone for the push summary; an unknown key
passes through as typed. `tests/verify-messages.mjs` covers it.
D1 schema: `teams` (with `hidden`), `quests` (the codes, each a part of
its quest with a scoring type, below, its points and the `norm`
lookup), `entries` (the ledger, below: a team's score is the sum of its
live lines' points), the view `held` (each team's live lines per code
added up, `amount` their units and `points` what they were worth, which
every reader of the tab reads), `awards`, `completions` (what the tab
held before the ledger, left as it was and never written),
`submission_log` (audit + per-hour analysis).
**The ledger** (`src/ledger.ts`, migration `2026-11-ledger.sql`,
`tests/verify-ledger.mjs`). Every change to a team's score is a line in
`entries` — team, code, `units` (how much of the code: a count, or part
of one) and `points` (what it was worth when it was written, by the
code's type: units × its points for a fixed, per-unit or judged part, the
band a tiered part's number reached, nothing for a submission on a
counted part, and what an award or an adjustment set),
who, when (`at`, which an entry's moved time moves) and what made it:
`submission` (an accept, or an organiser's entry, one line a code),
`award` (a row in `awards`: a challenge's places, a wager's settlement,
the EOI) or `balance` (what the tab held before the ledger that nothing
else explained, written once by the migration). **A line is never edited
or deleted**: one that was wrong is voided (`voided_at`, `voided_by`,
`void_reason`) and stays on the team's receipt with why. Undo, Change,
Reject, Delete and Take back all void a submission's lines
(`relineSubmission`, with the reason "Sent back to the queue", "Changed",
"Rejected", "Deleted: <note>" or "Taken back") and Change and Put back
write new ones, carrying the time and note of the lines they replace (a
time moved with Time, a desk's note, an adjustment's reason); an award is
undone by voiding it (`voidAward`).
**Exactly-once is the database's**: a partial unique index allows one
live line per source, team and code (`idx_entries_once`), and one live
award per kind and code (`idx_awards_once`), so a second Accept fails its
whole batch (`isTaken`), on top of the claimed_at stamp every submission
batch still lands under (`claimed`). An award row goes in only while no
live award of its kind is on its quest group or its code, and its lines
only under it (`awardStatements`), so a second award changes nothing and
the caller reads that from the award statement's `changes`; `liveAward`
looks a group's award up the same way, by the group or any of its codes.
Accept, Change and Put back claim the submission only while every code
the credit names is still on the tab (`codesThere`), so a rename or a
delete in between is a 409 rather than a credit with no line. **The tab
is read off the lines** (the view `held`, migration `2026-12-held.sql`):
each team and code that is still there, `amount` its live lines' units
added up, `points` their points and `updated_at` the newest one's `at`; a
code whose lines come to nothing either way has no row, and a sum below
nothing (two corrections taking off one completion) is kept as it is.
Every total is the sum of `points` (`SUM_POINTS`), never amount × the
code's points, which a tiered or counted part's lines are not. Every reader of the tab — the
standings, the stats, the score sheet, the team pages and the recap, the
dashboard's lists, the queue's "already has points" — reads it, so there
is no copy to drift. It took the place of `completions`, a table every
batch used to rebuild from the lines; that table keeps what it last held,
the ledger migration reads it, `ledgerReady` asks whether it holds
anything, and the deletes and renames of a team or a code still clear
its rows, because D1 holds them to their foreign keys. Nothing else reads
or writes it. **Run db:migrate before deploying** this: a worker reading
a view the database does not have answers 500 naming db:migrate until it
does.
**Changing a code's points re-scores every team holding it**
(`rescoreLines`, from the quest editor, the old quest edit and the EOI's
points): each live line worth its units × the old points is voided
("Re-scored: SQ8 50 → 75 points") and written again at the new points
under the same source, so undoing the submission later still takes off
what it is worth now; lines whose points were set another way are left
(an adjustment's, whose credit sets its worth, and **the lines of a
challenge's places and a wager's settlement**, `setByAward`, which gave
what they gave when they were made; the ledger check leaves all of
those out too), and so are a tiered or counted code's, whose points
follow its bands. Of the awards only the EOI's is its code's points per
person, so only its lines move with them. A stake is written as units of
the code (stake ÷ its points) and would otherwise have been re-scored as
if it were a share of the code. **A code cannot change into or out of
tiered or counted while `held` has a row for it** (409, in the editor's
save and in an import's plan): those lines were worth what bands gave,
not units × points, and cannot be read again under the other kind. The
old quest edit (`quests/edit`) refuses a tiered or counted code outright,
since its points are its bands', and renames a code with no quest round
it in the accounts limited to it (`renameInScopes`). **A
tiered code's new bands re-score it the same way** (`rebandLines`): each
line a submission wrote is worked out again from the number it reached,
kept in the line's `input` ("Re-scored: SQ39's bands changed"). An award
already made on a counted part keeps what it gave; undo it and award
again.
A renamed code's lines and awards follow it (`codeRenamed`) and a
deleted one's are voided ("Quest deleted", `codeGone`); a deleted team's
lines go with it. **A deleted quest leaves nothing under its codes**
(`src/deleted.ts`, migration `2026-12-deleted-quests.sql`): its
submissions, and its lines and awards once `codeGone` has voided them,
move in the same batch to one loose, hidden code, `DELETED` ("Deleted
quests", worth 0, made the first time as `ADJ` is), each keeping the code
it came from in `deleted_from`. `submissions.quest_code` is plain text,
so before this a new quest given the old code took over the old one's
submissions in Review, Already sent, a challenge's count, the receipt and
the gallery, and its voided lines. Its files stay where they are, still
served by key, with the quest's key in `quest_files.deleted_key`; group
ids are AUTOINCREMENT, so no new quest can take them. Both
`quests/group/delete` and the one-code `quests/delete` do this, and
`DELETED` itself cannot be deleted, renamed or retired. Wherever a
submission's quest is named it reads as "SQ12 (deleted)" (`nameDeleted`,
which reads `deleted_from` only for rows in the holder): the team's Already sent and
the upload status (`mine` in submit.ts), Review and its quest filter
("Deleted quests"), the receipt (a block per deleted code, keyed to the
holder's desk) and the desk, the gallery, an album's gallery photos, the
`/photo/` and `/view/` pages and the Original videos card. A moved
submission is never credited again: Accept, Change and Put back answer
409 and the Queue offers none of them, leaving Reject and Delete.
`verify-ledger.mjs` deletes a quest with
an accepted submission, a wager and a file, makes a new quest with the
same key and code, and checks it starts with nothing.
**The migration fills the ledger in once**, in SQL:
every accepted submission's credit as lines (its part marks and counts),
a submission deleted before deletes took points off as a live line
("Deleted, points kept"), a taken-back organiser entry as a voided line,
each wager and challenge stamp as an award (with a line per team where
the stamp kept `given`), the EOI as an award, and then a balance line
for whatever each team and code still differs by, both ways, so every
team's lines add up to exactly what it held. Each statement runs only
while `site_flags.ledger_seeded` is unset, the first two clear what a
run that stopped part way left, and the last sets it; it is named
2026-11 so it runs after the files that add the columns it reads.
**Scoring needs the ledger** (`ledgerReady`): every write answers 503
naming db:migrate until it is there, with no fall back to writing the
tab the old way — that fall back is how rows with no record behind them
came to exist. A database made from schema.sql that holds nothing is
marked ready the first time it is asked. **The check** (`ledgerCheck`,
`hourlyLedgerCheck` on the scheduled run, `GET`/`POST ledger/check` with
Scores): each team's live lines on a fixed, per-unit or judged code
against their units at the code's points now, and each line a submission
wrote on a tiered code against the band its number reaches, which differ
only if a code changed without a re-score or a line was written by hand
(a counted code's lines are set by its award and are not checked, nor
are an adjustment's line and a challenge's or a wager's award lines,
which keep what they were given); the
result is kept in
`site_text.ledger_check`, and the Scores tab shows it in red only when
something differs. `tests/ledger-fixture.mjs` is how a suite puts points
on a team by hand (`credit`, a line) and reads the board both ways
(`ledgerAgrees`: the view against the lines added up in the test, units
and points);
`verify-ledger.mjs` holds the public board to the lines.
**Parts and their scoring types** (`src/parts.ts`, migration
`2026-12-parts.sql`, `tests/verify-parts.mjs`). Each code of a quest is a part, and `quests.scoring`
says how it scores: '' **fixed** (its points, once), `unit` **per unit**
(its points for each one counted, up to `most`, NULL for no limit),
`judged` (up to its points: the reviewer gives part of them), `tiered`
(the band the reviewer's number reaches, `bands` as JSON `[{from,
points}]`) and `counted` (nothing on its own: each accepted submission
adds to the quest's challenge count, and the band the count reaches and
the place it earns are awarded once, at the end). A tiered part's points
are its top band and a counted one's its top band and first place, set
on save (`cleanPart`), so what a page shows as the most there is follows
the bands. **`buildCredit` reads every credit against the types**, for
Accept, Change and a desk's Record alike (`readCreditFrom` in points.ts):
a fixed, judged, tiered or counted part is credited once, a per-unit one
counts up to its most, a judged one is given 0 to its points (`awarded`),
a tiered one needs `numbers` `{code: n}`, and anything else is a 400
saying what would make it work ("Make it per unit in the quest editor
to count it"). The credit stored on the submission gains `numbers`, and
an adjustment's `points` `{code: points}`, a line worth that outright
(units 0 on a tiered or counted code), so Undo, Change and Put back
write the same lines again. **The line's worth is worked out in its own
statement** (`lineInsert`, a `CASE` on `q.scoring` with the band looked
up in SQL by `bandSql`), so the batch that writes it needs nothing read
first. `ledgerReady` asks for the three columns, so a database behind the
migration answers every write 503. **What it replaced**: the quest-wide
part-marks switch (`rules.partial`, which nothing stores now; an older
file asking for it makes the quest's codes judged) and counts on any
code. **The migration** adds the columns, re-creates `held` with
`points`, makes the codes of a quest that took part marks judged and a
code labelled "Per ..." or credited above one in one result per unit, and
leaves the rest fixed; folding tier codes into one part is a person's job
(`scripts/classify-quests.mjs`). **Tiers and
challenges**: a counted part needs the quest's challenge
(`rules.tally.kind`), a quest has at most one (both held against the
quest as the save leaves it: the codes a save does not send keep their
stored types and count too), and **Award bands and
places** (`tally/award`) writes one line a team on the counted part, its
band plus its place's points; a challenge with no counted part is still
awarded by place on its lead code as before. Discord's `/submit` and
`/unsubmit` refuse a tiered code, since there is no number to give, and
the post for a counted submission says it counts towards the challenge.
`/submit` builds its credit with `buildCredit` and holds it to the same
rules against what the team has (`submitCredit` in index.ts): a fixed or
judged part it already has is refused ("credited once"), a per-unit part
stops at its most, and a counted part may be recorded again, since each
one adds to the challenge's count. `/unsubmit` takes one off, which can
break neither rule, so it records the negative amount as it always did,
except on a counted part, which it refuses: the count is the accepted
submissions, and an entry taking one off would lower the tab and leave
the count where it was.
The public list carries each code's `scoring`, `most` and `bands`, a
mystery quest's band points and places as null; the score sheet, the
team pages and `/quest` show only what a tiered or counted code came to
(`bandsScore` in tab.ts). The page side is in
`website/questlist/CLAUDE.md` and under the desk and the Queue below. `/submit` and `/unsubmit`
are refused in-code unless the interaction comes from a server in
`discord_guilds` (enabled, with an organiser role) *and* the member
holds that server's `organiser_role_id` (`writeGuard` in
`src/discord.ts`, async; the `GUILD_ID`/`ORGANISER_ROLE_ID` secrets
only seed the table when it is empty, and only once: `guildRows` sets
`site_flags.discord_seeded` when it seeds, and adding or removing a
server on the Discord tab sets it too, so removing the last server
leaves none rather than bringing the secrets' one back). The same guard
covers `/post` and the optional `channel:` on the read commands
(ephemeral confirm via `{content, flags: 64}`); both need the
`DISCORD_BOT_TOKEN` secret and a `bot`-scope invite. Team and quest
options autocomplete from D1. `src/tab.ts` holds `standings` (each row
with its `rank` and `dnf`), `lastPlace`/`placeRows`,
`fmtPts`/`fmtAmount`/`ordinal` and `leaderboardText` for every reader.
**Discord side (`src/discord.ts`)**: `discordApi(env, method, path,
body)` (bot token, `{ok, status, data, why}`; a 429 is waited out
for its `retry_after`, three times at most, and an answer saying its
bucket is empty (`x-ratelimit-remaining: 0`) waits for
`x-ratelimit-reset-after` before returning, each wait capped at 30s),
`guildRows`/`guildConfig`, `roleNameFor` (team name tidied, ≤100) and
`channelNameFor` (lowercase, hyphens, `\p{L}\p{N}` only),
`ensureTeamSetup(env, guild, team, known)` (one at a time per team
through a lock row `discord-setup:<guild>:<team>` in `site_flags`
holding its expiry, so teammates running /verify together or two
organisers pressing Set up make one role; a run lets go of its own
lock only, matched on that expiry, so one that outlasted it leaves the
next holder's alone; `known` is the server's
roles and channels, fetched once per batch; a new role's id is
written to `discord_teams` the moment it exists, with the channel id
still empty, because a run stopped between the role and the channel
used to leave a role nobody had recorded and make another next time;
role by stored id only, else a
new one with no permissions of its own → category by stored id or
`category_name` → channel by stored id only, else a new one under the
category, its name suffixed with the team id when another channel
there already has it, with overwrites: @everyone deny VIEW, team role
+ organiser role + bot allow VIEW|SEND|HISTORY; existing channels get
missing overwrites PUT; ids upserted into `discord_teams`),
`renameTeamDiscord` (called by the Teams-tab and Rego renames; leaves
alone a role or channel another row also names, or the organiser
role), `findSignups` (participants by `discord` username,
`@`/case/`#0` ignored — **never by display name**, which anybody can
set to somebody else's username), `verifyUser`, and `handleVerify` —
**A team name never picks a role or a channel.** They used to be
adopted by name when no id was stored, so a team registered as
"OrgCom" was handed the organiser role by /verify — which is what
`writeGuard` checks for score changes — and two teams whose names tidy
to one channel name shared a channel. `teamRoleOk` refuses @everyone,
the organiser role, a managed role, another team's role and any role
carrying a staff permission (`STAFF_PERMS`) even when it is the stored
id, since a mapping from before could be any of those; the team gets a
new role and the refused one loses its overwrite on the channel.
`verify-discord.mjs` registers a team called after the organiser role
and two whose names collide.
 `/verify` answers
`{type: 5, data: {flags: 64}}` (deferred, ephemeral), does the work
in `ctx.waitUntil`, then PATCHes
`/webhooks/{application_id}/{token}/messages/@original`; `route()`
passes any `{type}` object straight through as the interaction
response. `runCommand(interaction, env, ctx)` takes ctx now. Tables:
`discord_guilds` (guild_id, name, organiser_role_id, category_name,
category_id, enabled), `discord_teams` (guild_id+team_id → role_id,
channel_id, names), `discord_members` (guild_id+user_id →
participant_id, team_id). Dashboard API `discord/*` (`status`,
`guild?guild_id=` roles+channels, `guild/save`, `guild/delete`,
`register` = PUT guild commands with the app id from
`/oauth2/applications/@me`, `post` with `preset: 'leaderboard'`,
`setup` for one team or every team with people on it, with
`members: true` also running `giveTeamRoles` — each person on the team
with a Discord username is found by `GET /guilds/{id}/members/search`
and matched on the username exactly, as /verify matches, then given
the role and recorded in `discord_members`; a username on two teams'
signups gets nothing — and the dashboard's button sends one team per
request; `leftovers` / `leftovers/delete` list and delete roles with a
team's role name, no permissions and no `discord_teams` row, and text
channels in the team category carrying the bot's topic and no row,
twenty deletes a request, recomputed server-side rather than taken
from the page). A team counts as set up in `status` once it has a
channel. Tests:
**Who sees a team channel** (`teamOverwrites`, `staffRoles`,
`channelAllow`): the team's role, the organiser role, the roles in the
server's own **staff list** (`discord_guilds.staff_role_ids`, comma
separated, migration `2026-10-discord-staff.sql`; the card's "Roles
that see every team channel" boxes, since every server's roles are its
own — TabTeam on one is nothing on another) and the bot. Each gets
`CHANNEL_ALLOW`: view, send, history, reactions, embeds, attachments,
outside emoji and stickers, threads, app commands and voice messages —
what anybody does in an ordinary channel. **Discord refuses an
overwrite granting something the bot does not hold itself**, so the set
is masked by the bot's own server permissions (its roles plus
@everyone, asked once a batch; administrator gets the lot), keeping the
three it always gave. An existing channel is brought up to date on every
setup: an overwrite that differs is written again, and a **role overwrite
the bot could have written** — nothing denied, exactly one of the sets it
hands out (old or new) — for a role no longer wanted is removed. One made
by hand with any other permissions is left alone. **Update team channels**
on the card runs the setup for every team with a channel here, one
request each, and saving a changed role list runs it on its own.
`verify-discord.mjs` holds the upgrade, the removal and that a channel
already right is not written to.
**Three kinds of role** on a server: the organiser role, given by
hand and never touched by the bot; **Legend**, which every participant
has; and a role per team, with **Unknown Team** as the team role for a
member no signup lists. Legend and Unknown Team (`fixedRole`) are found
by the id stored on `discord_guilds` (`legend_role_id`,
`unknown_role_id`, migration `2026-10-discord-legend.sql`), then by
their exact name if that role passes `teamRoleOk`, and made otherwise —
so a Legend the committee made by hand is the one used. Finding these
two by name is safe where a team name was not: the names are the
organisers', never a registrant's. **Unknown Team can be
picked** on the server card (**Not on any signup**, any of the server's
roles; the first choice, with nothing stored, is the bot's own found by
name or made): `guild/save` takes `unknown_role_id`, checked like the
role for a signup not in a team (below), and only a changed pick is
looked up, so an unchanged card still saves while the bot cannot see the
server. Picking another role answers a note that whoever has the old one
keeps it — the bot only ever looks at the one role, so it does not take
the old one back — and the recheck button and the sweep's report use
the picked role's name. Every way a team role
is given (/verify, Give roles, the sweep) gives Legend with it and takes
Unknown Team off (`markLegend`). **Give every member a role**
(`discord/roles/all`, `sweepMembers`) goes through the server's members
in id order: one holding no role but Legend and Unknown Team is matched
by username as /verify matches — one team's signup gives that team's
role (setting the team up first if it has none here) and Legend, and
none, two teams', or a signup not yet in a team gives Unknown Team and
Legend; one holding only team roles gets Legend; anybody with any other
role, and bots, are left alone. Each change is one `PATCH` of the
member's roles, so a request makes at most `SWEEP_CHANGES` (a team
setup counts as four) and answers the cursor it stopped at; the
dashboard posts again until `done`, and stops on `halted` (a 403 on a
change, which every change after would meet too). Listing members needs
the bot's **Server Members Intent**; without it the answer says so.
Running it again changes nothing, and someone tagged Unknown Team who
signs up later is moved to their team on the next run.
**A hidden team is a test, and the bot leaves it alone**:
`ensureTeamSetup` refuses one (so /verify, Set up, Update team channels
and the sweep all stop at it; `setup` with a hidden `team_id` is a 409),
/verify tells its members there is no role to give, the sweep ignores a
signup on a hidden team or a hidden signup with no team — a member whose
only signups are those is left alone rather than tagged Unknown Team —
and /verify and Give roles pass over such a test signup beside a real
one (`testSignup`), so a person on a test team as well is not refused
as being on two signups,
and `teamRoleIds(db, guild, true)` leaves hidden teams' roles out of
"holds only team roles". Teams set up before they were hidden keep their
`discord_teams` rows, which is what kept bringing their channels back,
so **Find leftover roles and channels** lists a hidden or deleted team's
stored role and channel (`hidden: true`, plus `hidden_teams`) beside the
true leftovers, and once a delete leaves nothing over it drops those
teams' `discord_teams` and `discord_members` rows for the server
(`forgotten`). Showing the team again sets it up from scratch.
**Role menus** (`src/rolemenus.ts`, migration
`2026-10-discord-role-menus.sql`, table `discord_role_menus`: guild,
title, body, `pick` one|many, `options` a JSON list of `{role_id,
label, description, emoji}`, and the `channel_id`/`message_id` it is
posted at). A message the bot posts with one dropdown (`menuMessage`:
the title in bold, the words, a string select with `custom_id
"rm:<id>"`, at most 24 roles; a pick-one menu adds a None option with
min 1, a pick-any menu has min 0), from which members give themselves
roles — name colours, pronouns, pings. A pick arrives as a
MESSAGE_COMPONENT interaction (type 3, routed in index.ts by
`isRoleMenu`) and is answered with a deferred ephemeral reply, the role
calls made in `waitUntil` and the reply filled in after ("Added Blue.",
"Swapped Red for Blue." or "Removed Red."). **Only the roles the menu offers ever move**: the
values Discord sends are filtered against the menu's own list before
anything is added, so a forged pick cannot ask for the organiser role;
in a pick-one menu the other roles of the menu are taken off, and a
pick from a deleted menu's old message changes nothing. A server that
is paused or not added answers in words instead. The bot can only give
roles below its own highest role: save and post check that
(`rolesTooHigh`, the bot's member record against the role list) and
answer a `note` naming the roles it cannot give, and a member whose pick
hits one is told an organiser has to move the bot's role. Console `GET
discord/menus?guild_id`, `POST discord/menus/save` (a menu already
posted is edited in place), `discord/menus/post {id, channel_id}`
(the same channel edits; another channel posts anew and takes the old
message down, and if the old one will not come down the new one is
taken back and nothing moves; a message deleted in Discord, a 404 on
the edit, is posted again, and any other failed edit is an error rather
than a second post),
`discord/menus/delete` (takes the message down, a 404 counts as gone)
and `discord/roles/create {guild_id, name, color}` — a role with no
permissions, made at the bottom of the list, where its colour still
shows because team roles have none; one already called that, any case,
is used instead. Logged `discord-menu-add/edit/post/delete`,
`discord-role-add`. The Discord tab's **Role menus** card lists them
per server and edits one at a time: title, one or any number, the
channel, the words, then a row per role (role, its label in the
dropdown, a description, an emoji, the role's colour as a swatch),
**Make role** with a name and a colour, and **Add the line colours**,
which makes (or finds) a role for each of the site's nine line colours
and adds them all. `guild` detail now carries each role's `color`.
**Holding posts, server by server** (`discord_guilds.held`, migration
`2026-12-discord-held-servers.sql`, which set every server to the one
switch it replaced; `holdPost`, `postsHeld`, `guildOfChannel`, `setHold`
in discord.ts; console `discord/hold {guild_id, held}`, logged
`discord-hold`/`discord-release` with the server's name; the Discord
tab's **Hold posts** card, a tick box a server, and `discord/status`
carries `held` on each server). While a server is ticked, nothing the
bot would post or edit in a channel on it reaches Discord: `discordApi`
and `postToChannel` in index.ts (the `/post` command and the `channel:`
option) are the only ways a message goes out, and both ask first. With
no server held that costs one read. **Which server a post is for** is
the channel's: the tab's own record first (a team's channel, an
announcements channel, a role menu's), then the server the caller names
(the dashboard's Send a message, a command's own server), then Discord's
answer to `GET /channels/<id>`; a channel none of those can place is
held while any server is. Each
held message is a log row instead, `discord-held`, with where it was going
in the team column (the team whose channel it is, "Announcements", or the
channel's id) and what it says in the quest column (the words, then its
buttons and menu options; "Edit: " in front of an edit), and the Log tab
keeps its line breaks. A held post answers `{ok: false, held: true, why}`,
so every caller treats it as a post that did not go: a dashboard post or a
role menu answers 409 with the reason, a team's submit code lists it under
failed, and **Refresh photo and video previews** stops at once on a held
server rather than logging every edit. Replies to slash commands, the
deferred /verify reply and role-menu picks are not posts and still
answer, but a command run on a held server answers ephemeral, so only
whoever ran it sees it. A team with a channel on two servers, one held,
gets its posts on the other. Roles, channels and their permissions are
not messages and are not held. `verify-discord.mjs` covers it, the
command reply through a signed request.
**Stopping every email** (`site_flags.email_held`; `emailsHeld`,
`EMAIL_OFF` and `emailOffRefusal` in shared.ts, `emailHoldRead` and
`emailHoldSet` in email.ts; console `GET email/hold` and `POST
email/hold {held}`, both the Settings tab, logged `email-hold`/
`email-release`; the Settings tab's Email card, **Stop sending email**).
While it is on nothing reaches the mail binding or Resend: `trySendEmail`
is the only way a message goes out, and it asks before every message
and answers status `held` without sending. No row, or no `site_flags`
table, reads as not held. Each path:
- **A send, a step, a retry and both tests** (the Email tab's and the
  Settings tab's) answer 409 `{error: 'Email sending is off. Turn it on
  in Settings.', email_off: true}` before anything is written, so
  nothing is left half queued.
- **The scheduled run and the batches** (`announceTick`, `sendBatch`)
  claim nothing, so an announcement part way out waits with its queue
  as it was, neither sent nor stopped, and carries on once the switch is
  off. Stop still works. A batch that meets the switch between its claim
  and a message puts that row back in the queue rather than marking it
  failed.
- **A registration** still succeeds and mints its codes. Each
  confirmation is recorded `email_status = 'held'` with no try spent
  (`registerTeam` asks once, ahead of the hourly caps). A person added
  on the Rego tab is recorded the same way, through `trySendEmail`.
- **The ticket sweep** (`regoRetryTick`) does nothing at all, codes
  included, because a code that fails to mint spends a try too. Once
  the switch is off, `held` is not `sent`, so the sweep sends the held
  confirmations, three rows a minute like any other; a try spent on a
  row the switch caught after its claim is given back. The sweep only
  looks back `SWEEP_DAYS` (14), so a signup held longer than that is
  left to Send email on the Rego tab.
- **Send email on the Rego tab** (`rego/email`) is refused like a send,
  before a code is minted.
- **A move or a placing** still happens. Its email is not sent and not
  sent later: it is a notice of the new team, and the person already
  has their ticket. The answer carries `email_off`.
The Email tab learns the state from `GET announce` (`email_off`), the
Rego tab from `GET rego` and the Scores tab's line from `GET schedule`,
so only a Settings account or an admin reads or changes the switch
itself. Opening the Email tab while it is on puts up a pop-up
(`#email-off`, the second password's overlay) with Go to Settings for an
account that has the tab; a line stays at the top of the tab
(`#ann-mail-off`), Send and the test are off, a send part way out reads
"(paused)" with no Carry on, and a send the worker refuses turns the
tab to the same state. The Rego tab carries the same line, Send email
is off, and the move and place controls lose "Email them". The
`email_held` in a `rego/person/save` answer is older and unrelated: no
code, so no email (**No code, no email**, below).
`verify-announce.mjs` and `verify-rego.mjs` cover every path,
`verify-console-auth.mjs` the permission and `verify-console-ui.cjs`
the switch and the pop-up.
**Reviews, points and check-ins in the team's channel** (`postVerdict`,
`verdictText`, `checkinText` and `postToTeam` in discord.ts; `tellTeam`
in points.ts, run in `ctx.waitUntil` after the dashboard has its
answer, never throwing). One message per enabled server where the team
has a channel: `**<quest name>** (<codes>) accepted for N points.
<Team>’s points now T.`, `… rejected: <reason>` or, for points taken
back or set by hand, `…: N points taken off.` / `added.`, the codes
left off when there is no group name, then up to four file links. A
quest can be worth negative points (a penalty): accepting it takes them
off and reads `… accepted: N points taken off.`, the desk's toast
says `Took N points off <Team>`, and the quest list ticks it off as
−N.
**A check-in** is one line: the check-in worker reports every check-in
and every undo to `/api/team-checkin` with `person`, `event` (`in` or
`out`), `checked_in` and `people` (a double scan or a double undo is
reported once), and `handleTeamCheckin` posts
`**Alice Park** checked in (2 of 3).`, `… checked in. The whole team is
here (3 of 3).` or `**Alice Park**’s check-in was taken back (2 of 3).`
for a team the tab knows. The name goes through `plainName`, which
escapes Discord's markdown, since a registrant typed it. **The links are
`PUBLIC_API/api/submit/file/<key>/<name>`**, the same trick as the
message attachments: `?key=` is not a picture to Discord, a path ending
in `.jpg` is, and the route in submit.ts serves exactly what `?key=`
serves (the photo with its metadata cut out, never the original).
**A video is linked as `<name>.mp4?res=720`** (`fileLink` in discord.ts):
the encoder's H.264 copy, which Discord plays. Linked bare, the route
answered with the clean copy of what the phone filmed — often HEVC in a
`.mov`, which Discord shows no player for — under a `.mov` name.
**Discord keeps the preview it made for an address**, so a post whose
preview came out wrong stays wrong after the route is fixed: a photo
from before `uprightPreview` squashed, a video linked the old way, or
one posted before the encoder reached it, which previewed as its still.
The server card's **Refresh photo and video previews**
(`discord/refresh {guild_id, team_id, before}`, `refreshPosts`, logged
`discord-refresh`) reads the bot's own messages in a team's channel a
hundred at a time, newest first, and rewrites every link to a proof file
that still exists into `fileLink`'s form with `v=<mark>` on the end, a
new address each run, which makes Discord fetch each preview again. It
edits at most `REFRESH_EDITS` (20) a request and answers `before`, where
the next carries on, null at the end of the channel; the page asks team
by team. Other people's messages, the bot's other posts and a link to a
deleted file are left as they were, and a 403 or a rate limit that
outlasts the waits stops the run (`halted`). Every post it edits shows
Discord's "(edited)". `verify-discord.mjs` covers the rewrite and the
paging, `verify-console-ui.cjs` the page's loop. What it was worth is the
codes' points times the amount, not the total's change, which a score
set at the same moment would throw off. **While frozen the total is
left out**, because the team's own score sheet goes quiet then and this
must not be the way round it. A hidden team gets nothing. Each server can turn it off (`discord_guilds.accept_posts`, default
1, migration `2026-10-discord-accept-posts.sql`; the server card's
"Posted in team channels" select, Reviews, points and check-ins or None
— the column kept its first name when rejections and check-ins
joined). Mentions are off
(`allowed_mentions.parse: []`), since a quest name is typed by an
organiser and a team name and a reason by somebody else.
**A team's role and channel by hand** (`saveTeamDiscord`, console
`discord/team/save {guild_id, team_id, role_id, channel_id}`, logged
`discord-team-edit`; **Edit** in a team's cell of the teams table opens
a row under it with the server's roles and text channels). The bot's
rules still hold, because /verify hands this role to whoever it
matches: `teamRoleOk` plus Legend and Unknown Team, another team's role
or channel is a 409, and only a text channel (setUpTeam only keeps a
stored channel of that type). Empty forgets one. The save takes the
team's setup lock, so a setup running at the same time cannot write
over it. With both set, the setup runs inside that lock so the
channel's overwrites let the role in, and
a role new to the team goes to its people through `giveTeamRoles`; the
old role is left on whoever holds it.
`tests/verify-discord.mjs` runs everything against a pretend Discord
(a `fetch` stub with roles/channels/members in memory). `seed.sql` is generated from the tab CSV
exports in `data/` by `scripts/build-seed.mjs`; reseeding replaces
everything recorded since.
**Each team's submit code in its channel** (`sendCode`, `codeText` in
discord.ts, console `discord/codes/send {team_id}`, logged
`discord-codes`; the Discord tab's **Submit codes** card, every
team with a channel or the ones ticked, one request per team). A team
with no code is minted one first (`mintCode`, shared.ts). The message
mentions the team's role and nothing else (`allowed_mentions: {parse:
[], roles: [role]}`), puts the code alone in a code block so Discord
draws a copy button on it, and carries a link button to the submit
page. Hidden teams and teams with no channel are skipped. The second
password can be asked for it (`discord-codes` in `GUARDS`, off by
default). **Recheck Unknown Team** on the server card runs the member
sweep with `recheck: true`: only members holding no team role (Unknown
Team, or nothing) whose username is now on one team's signup are moved
to that team, set up first if needed; nobody is given Unknown Team and
nobody else is touched. Logged `discord-roles-recheck`.
**The role for a signup not in a team yet** (`discord_guilds.
no_team_role_id`, migration `2026-10-discord-no-team.sql`; the server
card's **Signed up without a team**, a pick from the server's own roles,
Unknown Team by default). Somebody who signed up without a team and has
not been placed is not unknown — their signup is found — so a server
can give them a role of its own, and the name is the organisers' to
choose, which is why it is a setting and not a name in the code. Once
set: the full sweep gives it (and Legend) to a member whose signups are
all without a team, where it gave Unknown Team; /verify gives it and
says so; moving someone out of a team gives it; and the recheck covers
it — its holders move to their team once placed, and a member in
Unknown Team who turns out to have signed up without a team moves to
it (the button names it, "Recheck Unknown Team and …"). `markLegend`
takes it off with Unknown Team whenever a team role goes on. **Somebody
holding it whom no signup lists keeps it**: an organiser may have given
it by hand, and the sweep does not demote them to Unknown Team. The bot
hands it out, so saving refuses what a team's role is refused (the
organiser role, staff permissions, a bot's role, a team's role) plus
Legend and **any role on the server's "see every team channel" list**,
which would open every team channel to everybody without a team; and
`noTeamRole` checks the same again before each use and falls back to
Unknown Team if the role has since become one of those. A team's role
set by hand cannot be it either. `verify-discord.mjs` covers the
refusals, the sweep, the recheck both ways, the hand-given holder and
/verify; `verify-console-ui.cjs` the card's field.
**Points organisers record** (`src/points.ts`, migration
`2026-10-points.sql`, `tests/verify-points.mjs`). **Every change to a
score is a submission row**, whoever makes it: a quest's desk on the
dashboard (`points/add`, multipart like the team's own create — the quest,
the codes to credit, an amount, the quest's answer, a note, the files
the quest takes through the same `proofFilesProblem` and
`storeProofFiles` in submit.ts; files optional), an adjustment on the
team's ledger (`ledger/adjust`, **Adjust**, below) and
`/submit` / `/unsubmit` in Discord (`changeAmount` in index.ts, by
`discord:<username>`). `recordPoints` writes the submission
`accepted`, `added_by` the organiser, `credit` the JSON `{codes,
amount}`, the files and its lines on the ledger in one batch. **The
submission goes in only while every code it credits is on the tab**
(`codesThere`, as Accept claims), and its lines and file rows find it by
a stamp of its own in `claimed_at` (`recordClaim`; `{claim}` in
storeProofFiles' `Into`), cleared by the batch's last statement. They
used to find it as the team's newest: a rename or a delete between the
read and the write saved an accepted entry worth nothing while the desk
said +50, and with the insert refused they would have landed on the
team's previous submission. A refused entry answers 0; `points/add` and
`ledger/adjust` answer 409, the desk's staged files are given back to be
sent again (their release waits on the same stamp) and its stored files
are taken back, and Discord answers as for an unknown quest.
An accept stores `credit` too, in the statement that claims it. **Taking
back** (`points/undo`) is for an organiser's entry only, whichever way
it moved the score: the row goes to `deleted` with "Taken back" (who did
it is in the log, not on the row the team reads) and what it did is
undone in the same batch, guarded by the claimed_at stamp the way Accept
is, so a second press is a 409, and taken only from the credit it was
read with, as Change is, so a Change in between is a 409 too. Its lines are voided, so an entry that
took points off — Discord's `/unsubmit`, an adjustment below zero — gives them
back, even to a code the team holds nothing on any more. **Putting back** (`points/redo`, logged `points-redo`) is
the undo of that: a taken-back entry (status `deleted`, reason "Taken
back") is accepted again and does to the tab what it did before, once,
under the same guard; anything else is a 409, and so is one whose code
has left the tab. An adjustment gets its reason back: `recordPoints`
wrote it as the note on the entry's first line, where a desk's entry
has its own note, so Put back takes the reason from there. Both are open to Points,
Scores and Review, and the team's channel is told either way, as for a
correction. `points/form` hands the desk the quests the
account scores with their codes, answer boxes (`questions`, one box
each, none required; a `choice` is a select there), whether each runs a
challenge (`tally`) or asks a question (`ask`), and the place lists;
Review reads it too, for the desk's list of quests. **An entry's time
can be moved** to when the quest was done (`points/time {id, at}`,
**Time** on its line on a desk or a ledger, a datetime-local box read in
the device's zone and sent as UTC). The
recap's hours, its first and last submission and each quest's busiest
hour read `submitted_at`, and an entry typed in at 6pm otherwise piles
the afternoon into one hour. It moves `submitted_at` only: `reviewed_at`
keeps when it was typed in, the list shows both once they differ
("entered …"), and the log has the old and new times. The entry's lines
move with it (`entries.at`), so the time `held` gives the code, which is
what the team page's per-quest time reads, follows where this entry is
the code's newest line. Any organiser entry may be moved,
Discord's and an adjustment included, never a team's own
submission (404); a time more than five minutes ahead or before 2020 is
refused, and the account must score every code on the entry. **The
recap's review times leave organiser entries out**: they never waited
in the queue, and a moved one would otherwise read as hours.
**The team's own list shows them** (`mine` carries `organiser`:
`added`, `taken` when what the entry was worth — the quests' points
times the amount — comes out negative, which covers both a credit taken
back and a quest worth negative points (the amount's sign decides when
the quests are worth 0), or '' for the
team's own), never with the organiser's name; the submit page puts a
note under the status, an adjustment's reason after it ("Points taken
off by an organiser: Late to the finish"), and the post in the team's
channel ends with the reason in brackets. Review shows them with "Recorded by …".
Before the migrations every one of these answers 503 naming db:migrate.
**A count per code** (`buildCredit` in parts.ts, `countFor` there too,
re-exported by tab.ts). A per-unit part has its own count on the Queue's
Accept and Change and on the desk's form — one of the quest's code and
three of its bonus, where the bonus is per unit — and the desk has no
one Amount box any more; `points/add`, Accept and `submissions/revise`
take `counts` `{code: n}` beside `amount`, which stays the count of any
code not named. A count runs above 0 to its part's most (1000 at the
outside), a count above one on a part that is not per unit is a 400, and
a code not being credited is a 400. The credit keeps `counts` only where
they differ from `amount`, so every older credit reads as it did.
`countFor` is a code's count and its full points are its count times its
points; `amountFor` is what it was given — the part mark if there is
one, else the count — and everything that works out "of N points"
(`partMarks`, `worthOf`, the team's list, the receipt) goes through
`creditWorth`, which knows the types. `verify-points.mjs` covers the
counts and the refusals, and `verify-console-ui.cjs` what both forms send.
**Part marks** (a judged part, parts.ts; `partMarks` in points.ts). A
reviewer can give a judged code part of its points: each ticked judged
code on the Queue's card (and on the desk's form) has a points box set
to its full points until somebody types in it. Accept and `points/add`
take them as `awarded` `{code: points}`; a code given its full points is
not a part mark and needs no type. A part mark runs from 0 to the full
points, or for a code worth negative points from 0 down to them, and
anything else, or a part mark on a code that is not judged, is a 400
with nothing decided.
**It is stored as an amount**, points given ÷ the code's points (28 of
50 is 0.56), so the scoring model stays amount × points; the
submission's `credit` gains `amounts: {code: amount}` for the codes that
differ (left out otherwise, so every older reader and test still reads
`{codes, amount}`), and `points/undo` takes off each code's own amount.
A part mark of 0 accepts the submission and credits nothing on that
code. The exactly-once guard is untouched: the per-code amounts go
through the same stamped batch. **A line's points are rounded to the
hundredth when it is written, and every sum of them again in SQL**
(`SUM_POINTS`: the standings, every `teamTotal`, the dashboard's team
list, `/api/stats`, the recap's sums and its biggest score), because 0.56
× 50 is 28.000000000000004 and a total read without it carried that into
the accept's answer, the dashboard and the log; the log's delta is
rounded in JS. **Where a team is told**: the post in its channel says
`accepted for 28 of 50 points`, the submit page's Already sent puts
"Part marks: 28 of 50 points" under the status (`mine`'s `part`), and
its score sheet reads "28 of 50" for an amount under one; Review's
history reads "part marks, 28 of 50 points" (the list's `part`; each row
carries its codes' `scoring`, `most` and `bands`, and its own code's,
for the boxes). **A mystery quest keeps its
points**: the post says `accepted with part marks: 28 points`, `part.of`
is null, and wherever a code's amount and points travel together to a
team or the public — the score sheet, `/api/team`'s lines, the recap's
biggest score, `/quest` and `/list` — a mystery quest's amount that is
not whole goes out as null (`showsPoints`), since the two together give
the full points away. `verify-points.mjs` covers the total landing
exactly, the refusals, the desk's form and undo, and the mystery reads;
`verify-quests.mjs` the switch through save, export and import.
**Accounts limited to some quests** (`console_users.quests`, comma
separated quest keys, a group's key or a loose code; '' is every quest;
admins ignore it). `scopeCodes(db, session)` is the codes it covers or
null, and `inScope` is asked by `points/add`, `points/undo`,
`ledger/adjust` (an adjustment with no quest is refused outright),
`ledger/void`, the receipt (codes left out), the review list (rows
filtered), accept, reject, delete and claim; outside it is a 403 with
`no_access`. Recording on a desk is the `points` permission (or
`scores`, which carried score setting before; the Accounts editor names
the permission Desk); `GET file` and `GET file/meta` are open to both
so a desk's lines and a ledger's rows can show their photos and the
preview's details (`verify-console-auth.mjs`). The Accounts editor has **Every quest** and a
filterable list of quests under the tabs. An account with only Points
and one quest is the one for the people out at a main quest: its tabs
are the Desk and the Ledger, and it lands on its quest's desk with
nothing to pick.
A quest saved under a new key is renamed in every account's list in the
same save (`renameInScopes` in quests.ts), since an account names its
quests by key and would otherwise lose one nobody meant to take away.
**An empty list is every quest**, so `accounts/save` takes one for a
non-admin only with `all_quests: true`, which is what the editor's Every
quest sends; an empty list without it is a 400 ("Tick at least one quest,
or Every quest."), where it used to widen the account to everything
because only the page refused it. A request that sends no `quests` at
all leaves the list as it is. **A deleted quest's key comes out of every
list** (`dropFromScopes`, in the delete's batch, each write only from the
list it read), or a quest given the key later would be handed to an
account nobody gave it to; the one-code delete does the same for a code
with no quest round it. An account whose list held that key alone would
be left with an empty list, which reads as every quest, so **the delete
is refused (409) naming the account** until an admin gives it another
quest or deletes it. A quest's question is scoped as its desk is: an
account limited to other quests cannot read its answers, open it,
settle its wager or undo the settlement (`quests/group/ask/responses`,
`open`, `settle`, `unsettle`; `scoresGroup` in quests.ts).
**Deleting a team** takes its submissions, their file rows, slices and
renditions, its submit code, its sign-ins and its lines on the ledger in
the same batch, then
its files from the bucket — each refers to the team, so the delete used
to fail on any team that had sent something or had a code.
**A deleted team's id is never handed on.** `teams.id` is a plain
`INTEGER PRIMARY KEY`, which reuses the highest id once it is free, and
rows still keyed by it stay on purpose (its signups' people and
registrations as the paper trail, and `discord_teams`,
`discord_members`, `audience_teams`, `quest_responses`, `push_subs`):
the next team made would have inherited its people, Discord role and
channel, team groups, answers and phones. The delete's batch raises
`site_flags.team_id_high` (`retireTeamId` in shared.ts), and every
`INSERT INTO teams` names its id from `NEXT_TEAM_ID`, one past both that
mark and `MAX(id)`, in the statement itself (the console's add, the
signup and Rego tab create through `registerTeam`, and placing people
in a new team). `verify-console.mjs` checks that no insert in src/
leaves the id out. Rebuilding the table with AUTOINCREMENT was the
other way and was not taken: other tables reference it, and a rebuild
on D1 is a `.once` file. Migration `2026-12-team-ids.sql` seeds the mark
from the highest team id in any of those tables.
**A team name is unique whatever its case** (`idx_teams_name_nocase`,
migration `2026-12-team-names.sql`, which fails while two teams differ
only by case). Every writer still checks first for the clean refusal,
and one that loses a race to the index (two signups as Foo and foo at
once) answers that same refusal, never a 500 (`uniqueClash`).
**"No team yet" is not a team name** (`reservedTeamName` in rego.ts,
compared the way check-in stores names, ignoring case): it is what
check-in and the terms page call everyone not placed, and a team of
that name would be merged with them at the door. The signup form, the
Rego tab's create, save and place, and the Teams tab's add and rename
refuse it with a 400.
**The countdown on the home page** (`src/countdown.ts`, migration
`2026-10-countdown.sql`, table `countdown_stops` sort/label/at): a run
of stops in time order rather than one date. `GET /api/countdown`
`{stops: [{label, at}], over}` is a cached public read like the rest, routed
**above** the freeze — it is site chrome, not standings. Console
`GET countdown`, `POST countdown/set {stops, over}` replaces the whole list
(≤8, every stop needs a label and a time `readStamp` can read, logged
`countdown-set`, cache purged); the Settings tab's Home page card holds it. A
read that fails gives no stops rather than an error, because the page
has its own date built into its markup and must never lose its clock.
**`over` is the line the page shows
once every stop has passed**, the `countdown_over` row of `site_text`
(migration `2026-10-site-text.sql`, the first table of words the
dashboard sets, name to value, since `site_flags` holds integers). Up to
160 characters, saved with the stops when it is sent and left as it is
when it is not; blank deletes the row and the page goes back to its own
"SCS.2 is over. Results are on Discord.", which is the dashboard field's
placeholder. The page keeps the last one in `scs2-countdown-over`, so
the line is right at the first paint. Covered in `verify-recap.mjs`,
`verify-console-ui.cjs` and the site's `verify-countdown.cjs`.
**What a quest takes and counts** (`src/rules.ts`, `quest_groups.rules`,
migration `2026-10-quest-rules.sql`, which also adds `tally_settled`,
`ask_reveal` and `ask_reveal_live`). One JSON column, '' for the
defaults: `files` is which kinds the submit form takes (photo, video,
gpx, pdf), how many per submission (0 to `MAX_FILES_LIMIT`, 20; 4 by
default) and whether one is needed, no kinds being a quest answered with
its questions alone; `tally` makes the quest a challenge counted across
a team's submissions (`kind` picks / sum / highest / submissions, `awards` the
points per place, `public` whether the site shows the standings). The
editor shows the challenge only for a quest with a counted part, or one
that had a challenge before parts had types. `partial` is read from what
older files and rows hold and never stored (Parts and their scoring
types, above).
`rulesOf` always answers a whole object and `cleanRules` refuses what it
does not know. A save writes them only when it sends them (`rules` on
`quests/group/save`), so a page or a file that leaves them out keeps
what is stored; they ride the dashboard's and the public quest lists
and the CSV and JSON export, and an import with the column applies
them. The quest list reads them with the rest of the quest
(`GROUP_COLS`); `storedRules` and `rulesForGroup` read them alone for
the readers that want nothing else. The quest editor's **What teams send**
and **Challenge** sections set them. `verify-quests.mjs` covers the
save, the lists and the export.
**What teams see of a live question's answers** (`quest_groups.ask_reveal`
''/tally/answers and `ask_reveal_live`, migration
`2026-10-quest-rules.sql`; `ASK_REVEALS` and `revealOf` in
quests.ts). `saveGroupAsk` writes them only when `reveal` is sent. A
question's editor in Polls and wagers has **Teams see** and **While it
is open too**.
**Polls and wagers** (the question a quest asks every team on the day;
`groupAsks`, `openGroupAsk` and `saveGroupAsk` in quests.ts). It is not
part of the quest's editor any more, where ninety quests showed an empty
card: the Quests tab's **Polls and wagers** button opens a list of its
own (`GET quests/asks`, Quests: every quest that asks something, with
whether it is taking answers, how many teams answered, hidden teams left
out, and a wager's settlement), where a question's words are added,
edited and removed (`ask/save` with no `open` or `open_until`, which a
save now leaves as they are). **Taking answers is the desk's**:
`POST quests/group/ask/open {key, open, open_until}` (Quests, Points or
Scores, and an account limited to some quests only for a quest it
scores; logged `quest-ask`) switches it and sets the time it closes at,
refusing a quest that asks nothing (409), a closing time already
past while opening (400) and a settled wager (409: undo the settlement
first). A save that sends `open: true` is held to the same three; a
question taken off (`kind: ''`) stops taking answers; and a question
teams have answered keeps its kind (409), since a number read as a
stake, or a stake as a number, is not the answer given. A question put
on a quest whose last one was taken off starts with no answers: the
answers left behind are deleted in the same batch, since they were to
the question that went. The conditions
are in the UPDATE as well as read first. **A team's answer is written
only while the question is open and still the kind it was read for**
(the upsert selects from `quest_groups`), and the settle closes the
question before it reads the stakes, and again with the award, so no
answer lands after the settle or goes unsettled. The quest's desk shows it as an O/I rocker
that saves at once, with the closing time and **Set** beside it, over
the answers and the settlement. The data stays on the quest
(`quest_groups.ask_*`), one question a quest, which is what the site
reads.
`GET /api/quest/ask` answers `results` once the question closes, or
while it is open with `reveal_live`: `total`, `counts` per option for
choice and wager (points staked, `winner` after a settle) and, for
'answers', `answers: [{team, choice, amount}]`. Hidden teams are left
out, and the reader's own count and row carry `mine: true`. A closed
question with results becomes public once a team that is not hidden has
answered it; until then it reads as no question, so one written ahead
stays secret. The public list strips the two fields from an open ask.
**The schema comment over the two columns must not hold a comma**:
SQLite's DROP COLUMN finds where the last column starts by the comma
before it, which is what the before-migration tests do. `verify-ask.mjs`
and `verify-ask.cjs` cover it.
**Search tags** (`quest_groups.keywords`, migration
`2026-12-quest-keywords.sql`; `cleanKeywords` in quests.ts). Words the
organisers give a quest for teams to search by and see on its sheet:
the quest editor's **Search tags, shown on the quest**, typed with
commas, stored lower case, each once, at most twenty of forty letters,
joined by ", ". Like the rules, a save writes them only when it sends
them. The public list carries them as `keywords`, an array, and the CSV
and JSON export and import carry a `keywords` column. They are not the
organisers' own tags (`quest_tags`), which are never public.
`verify-quests.mjs` covers the save, the list and the export; the
site's half is in `website/questlist/CLAUDE.md`, Quest search.
**Who can see a quest** (`src/access.ts`, the access half of
`src/quests.ts`, migration `2026-10-visibility.sql`,
`tests/verify-visibility.mjs`). A quest group is seen by one of four
audiences: `hidden = 1` is organisers only whatever else it says, and
otherwise `quest_groups.visibility` is `everyone`, `teams` (any team
signed in with its submit code) or `groups` (the teams in the team
groups linked through `quest_audiences`; `audiences` + `audience_teams`
are the groups, named "team groups" everywhere a person reads them).
Organisers only keeps `visibility` as it was, so showing the quest again
brings back whoever could see it before. Messages use the same
audiences and the same team groups (**Who reads a message**, under
Messages above). **`canSee`/`rowVisibleTo` are
the one answer**, asked by every reader that hands a quest to somebody:
`questListPayload` (the public `GET /api/questlist` with viewer null,
and `GET /api/questlist/team`, Bearer submit session, `private,
no-store`, 401 bare when signed out), the ask GET and POST (a quest the
team cannot see is a 404, the same as one that is not there), the
submit create (`Pick a quest.`, the same answer as a hidden code), the
public `/api/quests` stats (everyone's only) and Discord's `/quest`
autocomplete (everyone's only; `/submit` and `/unsubmit` are the
organisers' and suggest everything). The leaderboard's `last_quest`
still names whatever a team scored. **No list says
who else can see a quest**: the payload strips `visibility`, `opens_at`,
`tags` and `audiences`, and the public list's `more` (true when a quest
not hidden is kept from it) is all it says about the rest.
**Opening on time** is `opens_at` (UTC, '' for none): `releaseDue`
flips a due quest to everyone, hidden 0, time off, logs `quest-open`
actor `schedule` and bumps the `quests` counter so open pages offer the
new list. Each flip is made only while the quest's time is still the one
read and still due, so a time moved later in between keeps it shut, and
only the quests a call actually opened are logged and counted: two
callers at once open it once. Like scheduled messages, the site's reads are the clock
(`questListPayload` and the pulse call it, and the pulse purges when it
opened anything) and the cron in schedule.ts is the floor. **Saving a
quest never changes who sees it**: `upsertGroup` only reads `hidden`
for a new quest, and the dashboard writes a new one hidden before
giving it its audience, so it is never public in between. The editor's
one Save sends `quests/group/access` after the quest only when the
"Who can see it" section (audience, time or tags) changed since the
editor opened: sending it every time would let an editor left open
across Open everything now close the quest again, and a separate button
for the section was how tag changes came to be dropped — the Save at
the bottom said "Saved" and ignored them. While a quest's editor is
open its row shows no Who dropdown: that one saves at once and redraws
the editor, which lost anything ticked there and not yet saved.
**Tags** (`quest_tags` with `dash_hidden`, `quest_group_tags`) group
quests to be opened together: `quests/tags/apply` with `do` = `open`,
`at`, `clear` or `set`. A tag hidden from the dashboard keeps its quests
out of the Quests tab until its switch is on, and `quests/open-all`
(typed OPEN, counts only what it changes) leaves them alone along with
any quest whose time is still to come. The migration filed every quest
hidden before it under **Old** (hidden from the dashboard), once:
`site_flags.quest_tags_seeded` stops a rerun filing a quest hidden
since, and `retireAll` files what it retires there too. Console:
`quests/group/access`, `quests/tags/save|delete|apply`,
`quests/open-all`, `quests/team-groups/save|delete`, `GET
quests/visible?team_id=` (the dashboard's "As …" view; 0 = signed out).
**The home page's slideshow** (`src/slides.ts`, migration
`2026-10-home-slides.sql`, table `home_slides`, R2 keys under `slide/`
in the SUBMIT bucket). `GET /api/slides` `{ok: true, step_ms, slides: [{key,
name, alt, caption, x, y}]}` in display order (`ORDER BY sort, id`), routed
**above** the freeze with the countdown and the pulse — a slideshow is
site chrome, not standings — cached and purged like the rest.
`GET /api/slides/file?key=` (+`&thumb=1`) is key-gated the way
`/api/messages/file` is and goes through the same chain:
`.t` → the picture cut as it is served → the file. No pictures is the
state the site ships in: the page hides the section. **Only JPEG, PNG and GIF may be uploaded** — those
are exactly the pictures the stripper can clean, so the ones that can
be served without handing out where they were taken. WebP, AVIF and HEIC can all carry EXIF and
the stripper knows none of them, so they are refused at the door rather
than uploaded and then unservable. **A GIF gets no thumb and is served
whole**, the same rule as everywhere else. **Alt text is required** on
upload and cannot be blanked by an edit: a picture with no alt is one
that somebody using a screen reader has no way to know is there.
**How long a picture stays up** is `step_ms`, the `slide_step_ms`
`site_flags` row, 3000 by default and bounded 1000..60000 — under a
second nobody can read a caption and over a minute it has stopped being
a slideshow. `site_flags` is an integer store, so what is held and what
crosses the wire is the millisecond count; the dashboard's field is in
seconds and takes a decimal point. The page keeps it with the list in
`scs2-slides-cache` so the first paint after a reload runs at the right
pace, and a changed interval alone restarts the clock without rebuilding
the deck.
**There is no cap on how many**: it was 30, because the page loaded
every picture whole as soon as it drew the deck. The page now loads the
picture on screen, the one either side and the one after next, and lets
go of any further than three away (`holdNear` in index.html), so a run of
any length holds at most seven photographs. Past ten pictures the dots
under it are a window of seven that slides along with the picture on
screen, the dots at its edges smaller where more lie beyond
(`paintDots`, `.hs-dots.is-many`), the way Google's carousels do it.
**Where a picture is cropped** is `x` and `y`, the `focus_x` and
`focus_y` columns (migration `2026-10-slide-focus.sql`, 50 and 50
unless set): the point to keep in view, in percent across and down. The
stage is about twice as wide as it is tall on a computer and a little
taller than wide on a phone, so one picture loses different edges on
each, and a centred crop cut off whatever was not in the middle. The
pages draw it as `object-position: x% y%`, which puts that point the
same share of the way across the box as it is across the picture, so it
is in the frame on every screen. The home page and the photo strip
both read it. Console `slides/focus` `{key, x, y}` sets it (whole
percents, kept to 0..100), logged `slide-focus`; on the card a click
on the picture sets it and saves, the arrow keys move it by five, and
two previews beside it show the crop at 2:1 and 4:5.
**A hidden picture** (`hidden`, migration `2026-10-slide-hidden.sql`)
stays on the dashboard's card and is left out of `/api/slides`, and so
out of the slideshow, the photo strip and the after-the-day pages; the
link preview's cover and the Discord card take the first picture shown
(`firstShown`). Console `slides/hide {keys, hidden}` takes one or
several, logged `slide-hide` or `slide-show`. **The card's
Edit button** swaps the table for a grid of tiles: a tile dragged with
the mouse or a finger moves as it passes the others and the order saves
when it lands (`slides/order`); a click picks a tile, and Hide or Show
acts on the picked ones; Done goes back to the table. Each row has its
own Hide or Show too.
Console `GET slides`, `slides/save` (multipart: the picture, or
`staged`, the id of one sent straight to R2, then `alt`,
`caption` and the browser-made `thumb`), `slides/edit` (alt and caption
only — a different picture is a different upload), `slides/delete`
(`.c`, `.x` and `.t` go with the file), `slides/order` and
`slides/step`, `slides/focus` and `slides/hide`; logged
`slide-add/edit/delete/order/step/focus/hide/show`, each purging
`/api/slides`. The
Settings tab's **Home page** card (Slideshow) does the lot, with the row's
own alt box beside the picture. `tests/verify-slides.mjs` covers the
worker side and `verify-console-ui.cjs` the card.
**What a link to the site looks like in Discord** (`src/embed.ts`,
`tests/verify-embed.mjs`). Discord builds a link's preview from the
page's head and does not run scripts, and the site is static. Each of
the nine main pages (home, info, questlist, tab, submit, welfare, rego,
messages, gallery) carries `<link rel="discord:component-embed"
href="https://files.scs.andyrew.space/api/embed/<page>">` — Discord's
component embeds, a card drawn from the same components a bot message
uses, with no bot involved — and `GET /api/embed/<page>` (a trailing
`.json` allowed, `max-age=300`, open CORS) builds it when Discord asks:
the event's name small, the page's name and one line (`PAGES`; the
lines are the 404 page's "Where to go" list), the slideshow's first
picture with its alt (or, with none uploaded, the app icon as a
thumbnail beside the words), the date and place, and link buttons Home,
Event info and Sign up — **Quest list in place of Sign up once
`guardClosed` says the form is shut**, since a button to a closed form
goes nowhere. The link may point at a subdomain of the page's host,
which is why it can live on the worker; a deploy preview's host is not
a parent of it, so previews fall back to Open Graph. **Discord's rules
throw the whole card away over one wrong key**: one Container (17) at
the top and none inside it, types 1/2/9/10/11/12/14 only, 40 components
and 3,000 bytes at most, buttons `style: 5` with no keys but id, type,
url, style, label, emoji and disabled, and a picture's address ending
in its extension — so the slide is linked at
`/api/slides/file/slide/<key>/<name>` (slides.ts, the messages
attachments' trick; the key is what is checked). The pages also carry
`og:site_name`, `og:type`, `og:title`, `og:description`, `og:url`,
`og:image` and `twitter:card`: what Discord falls back to and what
every other app reads. The image is `GET /api/slides/cover`, the first
slide, metadata cut, at one address that does not change (five minutes,
not immutable, since reordering changes it; a 302 to the icon with no
slides). **Each page's og:title and og:description must say what its
`PAGES` entry says**; verify-embed reads the nine pages and fails if
they drift, and checks the card against the rules above with and
without pictures and with the form shut. A new main page needs the
same block in its head and an entry in `PAGES`. Discord keeps a preview
with the message it was posted in, so a change shows on the next share.
**The worker's own clock** (`src/schedule.ts`, `[triggers] crons` in
`wrangler.toml`, once a minute → `scheduled` in index.ts). Until this
existed the only clock was somebody loading the site: a message written
for 3am went out when the first person opened a page, and a ticket
email that failed waited for an organiser to notice. The comment that
said "a Worker has no cron" was simply wrong. Five jobs, each wrapped
so one failing cannot take the others down, and one log row per tick
only when something happened (`scheduled-run`, actor `schedule`) —
a row a minute would bury the day's real entries:
`publishDue` and `releaseDue` (the site polling still does both first,
this is the floor), `pushOutboxTick`, `announceTick`, `regoRetryTick`,
and once an hour the ledger check.
**The push outbox** (`push_outbox`, migration `2026-10-cron.sql`).
Every push is one subrequest and a Worker gets a fixed number of those,
so a send to everyone is a run of batches, not a loop. `pushBatch` is
the single batch every caller shares (a send to everyone from the Push
tab or a message save, through `sendAllPush`, and the scheduled run), so
they cannot disagree about how
many a request may carry. `sendAllPush` takes the first batch inline —
an urgent message is on most phones before the save answers, and the
dashboard gets a real count — and leaves the rest in `push_outbox` with
the cursor for the scheduled run to finish a batch a minute. **The run
claims a batch before sending it**: it moves the cursor past the batch
only while the cursor is where it read it, so two overlapping runs send
it once, and a run that dies after its claim loses that batch rather
than anybody getting it twice. **What it
replaced**: one pass of 400 with no follow-up, so past that the only
way to reach the rest was to retype the message into the Push tab and
send to everybody, notifying the first 400 twice. `failed` and `dead`
were counted and then dropped by the dashboard, so a send that reached
fifty of three hundred read exactly like one that reached everybody;
the toast says both now.
**Three numbers, and why they are not one** (all in push.ts). A
notification is one HTTPS request to the device's push service, and
none of them depend on each other — so `pushMany` sends them
`PUSH_FANOUT` (25) at a time rather than awaiting each. Waiting in turn
spent the batch in round trips: 300 phones was 300 waits and about
fifteen seconds of an organiser watching a spinner. `PUSH_INLINE` (100)
is what goes out while somebody watches a Send button; `PUSH_SWEEP`
(500) is what the scheduled run takes, where nobody is waiting, bounded
by the 1000 subrequests an invocation may make. One number could not be
both: raising it slowed the save, lowering it stretched the tail.
**Aiming a push** (`pushToTeam`, `pushToDevice`; console
`push/send` takes `target: {kind: all|team|device, team_id, sub_id}`).
A team or one device is a handful of phones and finishes in the request
that asked, so neither touches the outbox or a cursor; everyone is
`sendAllPush`, the first batch in the request and the rest from the
outbox, so closing the tab part way drops nobody (the answer carries
`remaining` and `queued`, and the tab says the rest follow). The
reason it exists is the
test send: before it, the only way to see what an announcement looked
like on a phone was to send it to everybody. A send that is not to
everybody leaves the boxes filled, because it is a draft about to go
out for real. An unknown team is a 400 rather than a silent fall back
to everybody, and the second password guards a targeted send like any
other.
**The device list** (`pushDevices`, `deviceService`, `nameDevice`;
`push_subs.label`, migration `2026-10-push-devices.sql`). The endpoint
and the two keys never leave the worker — they are enough to send a
push to that phone, which is why `push_subs` is left out of the full
export — so a device is described by the name it was given, the push
service its endpoint host belongs to, and the team it linked itself to.
**The service is not the device**: Safari on a Mac and Safari on an
iPhone both go through Apple, which is why the site sends a name at
all (`scs.pushSub.label()`, the browser's own guess, on every
subscribe). A name already there is never written over, so an
organiser's rename survives the next time that device re-posts its
subscription; the label write is a separate best-effort UPDATE so a
database without the column can still subscribe. Renaming checks the
row exists first — an UPDATE matching nothing is not an error.
**The ticket sweep** (`regoRetryTick` in rego.ts, `participants.
email_tries`). A confirmation that failed used to sit there until the
person said so at the door. The sweep takes three rows a tick, mints a
missing QR and sends a missing email, and stops at five tries so an
address that will never accept mail is not retried every minute for
the rest of the event. `ticketsOutstanding` is what the Scores tab
shows about it. **A person whose email went out without a code** —
which tells them it will come separately — is sent the confirmation
again, carrying it, once the sweep has minted one; before, a row
reading `sent` was never emailed again and the promised code never
came. It leaves alone a signup under two minutes old, which is still
the request's own to send out. While email is off in Settings it does
nothing (**Stopping every email**). **Each row is claimed before anything
is sent**: the try is spent by an UPDATE that only lands while the row
still reads as it did (tries, status and code), so two overlapping runs,
or a run after a Resend has finished, email nobody twice. A Resend
still in flight when the sweep claims is not covered: that needs a
time on the row, which `participants` does not have. **With email not
set up** it only makes missing codes and spends no tries, so the rows
are still there to send once email is set up; with neither email nor
check-in set up it does nothing. Its age window is the registration's
time, because a person has no time of their own: someone added later
to an old registration is past it.
**What a failure says** (`fetch` in index.ts): an unhandled exception
is a JSON 500. On the dashboard's paths it names the cause, as it
always did, and so does any path when the cause is a missing column or
table, with the command that fixes it (`verify-console.mjs` holds
that). Anything else on a path the public reads says only that
something went wrong and a reference, and the cause goes to the
worker's log under that reference.
**Email announcements** (`src/announce.ts`, migration
`2026-10-announce.sql`, tables `email_sends` and `email_queue`,
dashboard tab Email). **One message per person, never Bcc**: every
message `trySendEmail` is handed has exactly one address in `to` and
nothing in cc or bcc. A Bcc send puts every address in one request to
the mail service, so a provider that mishandles the header, a reply-all
from a client that keeps it, or one wrong field in the code shows the
whole list to everyone on it. One message each cannot leak an address
it was never given. `oneAddress` refuses a value that holds more than
one address (a participant row reading `a@x.com, b@y.com` is skipped,
not sent to both), and the queue is deduplicated on the lowercased
address with `UNIQUE (send_id, email)`, so a person registered twice
gets one copy. "Everyone" leaves hidden teams and hidden signups out,
as every count does,
and takes in people who signed up without a team and have not been
placed (a `LEFT JOIN teams`): they are the ones most in need of being
told things.
**The line at the bottom** of an announcement (`DEFAULT_FOOTER`,
"You are getting this because you are registered for SCS.2. Questions?
Email …") is a box under the message in the tab, started with that line
and then with whatever was last typed on that device; the body's
Markdown works in it and a bare address becomes a link. Emptied, the
email has no line there. It travels with the draft to the preview and
the test, and a send keeps it (`email_sends.footer`, migration
`2026-10-email-footer.sql`; NULL is the default line), so a queue that
runs on for minutes goes out the way it started.
**Where replies go**: the binding's field is `replyTo` (Resend's is
`reply_to`). The binding was handed `reply_to` for a while and accepted
the message while ignoring the field, so every email — the
confirmations too — went out with no Reply-To and replies landed on the
From address. Every message now carries `replyTo`: `EMAIL_REPLY_TO`
unless the message names its own. The Email tab's **Replies go to** box
names one for an announcement (started with the worker's own, then with
the last typed on that device; blank is the worker's own), a typed one
that is not an address is refused before anything goes out, and a send
keeps it (`email_sends.reply_to`, migration
`2026-10-email-reply-to.sql`).
**Three audiences**: everyone signed up, one team, or addresses typed
or pasted into the tab (`audience: 'list'`, `emails` the box's text as
it stands). `pastedAddresses` takes every piece of the text that is an
address — one a line, comma or semicolon separated, `mailto:` or
`<...>` around it, or whole rows copied out of a spreadsheet with names
in the next columns — lowercased and each once, at most 2000 a send; a
piece with an @ that is not an address comes back so the tab can say
which, and the tab counts the box the same way as it is typed into. The
Sent list says "N addresses" for one of these.
**The send is a queue**, for the same reason the push outbox is: a
Worker gets a fixed number of subrequests. `announceSend` writes the
send row and one queue row per address, then sends `ANNOUNCE_INLINE`
(20) while the dashboard waits; the page keeps posting
`announce/step` while it is open, and `announceTick` takes
`ANNOUNCE_SWEEP` (50) a minute whether it is open or not. Rows are
claimed with one `UPDATE … RETURNING` that marks them `sending`, so the
page and the scheduled run working the same send at the same moment
cannot both take a row; a claim older than ten minutes is taken back
(a request that died mid-batch). `settle` counts the queue rather than
trusting a running total. Stop marks the rest `stopped`, in the same
batch as the send; Retry puts the failed ones back and never the
stopped ones, and a stopped send retried ends `stopped` again (`settle`
reads the queue). The claim asks in the same statement whether the
send is still `sending`, so a Stop between its read and its claim takes
nothing more. Each group of `FANOUT` is marked as soon as it has gone,
and the marking is tried twice: a row left `sending` is taken back
after ten minutes and sent again, so a failure between a send and its
mark can still send that group a second time. While email is off in
Settings a send, step or retry is refused and the queue waits
(**Stopping every email**). **Two formats**: text is the same Markdown the
messages use (`markdownEmail`, inline styles because mail clients drop
a `<style>` block), HTML is pasted as is and goes through `cleanHtml`
(scripts, frames, embeds, `<base>`, `<meta>`, `<link>`, `on*`
attributes and `javascript:` links come out). The plain-text copy and
the preview line are built from the cleaned HTML, not the draft, or a
link taken out of one survives in the other. Both go into the
confirmation email's shell (`E.shell`) under the same header. The
dashboard's preview is the worker's own render of the message in an
`<iframe sandbox="">`, so nothing in a draft can run on the dashboard's
origin. A test send goes to one typed address with "[Test]" in front
of the subject. `tests/verify-announce.mjs` reads every outbound
message for a second address anywhere in it.
**The drop and the short links** (`src/drop.ts`, migration
`2026-10-drop.sql`, tables `drop_files` and `short_links`, dashboard
tab Files). A file uploaded with nothing attached to it — a poster, a
map, a schedule — into the SUBMIT bucket under a random `drop/` key,
served at `GET /api/drop/<key>/<name>` with the name on the end for
the same reason the message attachments carry one. Sent with the save
it is one request, so 90MB; with the R2 token set the dashboard sends it
straight to R2 first and the save names it, up to 4GB (**The
dashboard's uploads straight to R2**, below).
`serveDropFile` goes through `servePublicCopy` like the message, quest
and slide endpoints: the picture cut as it is served, and for one it
cannot read its browser-made preview, never the original. A file that is not a picture
(a PDF, a schedule, a video) is served as it was uploaded — that is
what the drop is for. `dropList` hands the page `api` (from `PUBLIC_API`)
so a link copied out of the dashboard reads on the public hostname.
Deleting a file deletes what is kept beside it (`deleteStored`) and
**every short link pointing at it** — a link left answering 404 under a
name already shared is worse than the name being free again.
**A file can be replaced after it went up** (`drop/edit`, multipart:
`key`, `name`, `note` and optionally `file`; **Edit** on a file's row
turns the row into its form). The new bytes go in **under the same
key**, so the address already handed out and every short link pointing
at it serve the new file with nothing else to update; `.x`, `.t` and
`.v` (and a `.c` from before) are deleted straight after, because they
describe the old picture, and the next read makes the block from the
new file. The cached cut records the size and etag it was made for, so
the new file gets its own. A replacement of another type swaps the
name's extension rather than adding a second. Without a file it edits
the name and the note. Logged `drop-replace` or `drop-edit`. **That is
why the drop answers `public, max-age=300` rather than `immutable`**:
what an address serves can change now, and a year-long cache would keep
the old file on every phone that had opened it. `verify-drop.mjs`
replaces a picture and checks both addresses serve the new bytes rather
than the old picture.
`go.<domain>/<slug>` is `SHORT_HOST` in `wrangler.toml` pointed at
this worker as a custom domain; `handleShortLink` answers **first in
`route()`**, because on that hostname nothing else exists, and returns
null everywhere else so the rest of the worker is untouched. Unset, the
short links are off. **A file link serves the bytes at the short
address rather than redirecting**: an unfurler decides whether a link
is a picture from the URL's shape and a hop is one more way for an
embed to fail — which is also why the slug may end in the file's own
extension. `findLink` resolves both spellings (`poster` ⇄
`poster.png`; the no-extension direction is a `LIKE` with `%` and `_`
escaped out of the path first, shortest slug wins). A url link is a
302. Hits bump in `ctx.waitUntil` — a count that fails is not worth
failing a link over. `cleanSlug` is lower case, `[a-z0-9._-]`, ≤64,
trimmed of leading and trailing punctuation, and refuses the names
that would shadow the worker; a clash answers 409, and `was` on a save
renames rather than leaving the old name answering, in the same batch
as the new name. A link to a file is written only while the file is in
the drop, asked in that batch, so a delete of the file at the same
moment cannot leave a link to nothing. Console actions
`drop` (GET), `drop/upload` (multipart, answered before the JSON
parse), `drop/delete`, `links/save`, `links/delete`, all logged; both
tables ride the full export. `tests/verify-drop.mjs` covers the worker
side and `verify-console-ui.cjs` the tab.
**The link page** (`src/linkpage.ts`, migration `2026-12-link-page.sql`,
tables `link_page_items` and `link_page_days`, the Files tab's **Link
page** card, `tests/verify-linkpage.mjs`). What `go.<domain>/` shows: a
title and a line under it (`site_text.link_page_title`/`_bio`) on a black
board with the logo, a row of social icons (`SOCIAL_ICONS`: Discord,
Instagram, TikTok, Facebook, YouTube, X, LinkedIn, email, website), and
links in the site's button with headings between them, one ordered list
of rows (`kind` link, heading or social), a link optionally green
(`featured`) and any row hidden. **Off by default** (`site_flags.link_page`):
off, the bare domain redirects to the site as it always did, so the
deploy changes nothing until the card's Show the link page is ticked.
`handleShortLink` asks `linkPageRoute` first, which answers `/` while the
page is on and `/l/<id>` always — a slug cannot hold a slash, so that
path is never a short link — and returns null for everything else.
**Every link goes through `/l/<id>`**, which counts it (`clicks`, and a
row a day in `link_page_days`) in `waitUntil` and redirects; a hidden row,
a heading or an unknown id is a 404. A view is the page drawn for a
person (`isLinkPreview` is not counted), kept as item 0 in the same daily
table. **Counts are numbers and nothing else**: no address, no
referrer, no cookie. An address must be `https://`, `http://`,
`mailto:` or `tel:` (`cleanTarget`), a bare address on an email icon
becoming a mailto link, so nothing typed can put script in an `href`.
The page is built by the worker with the site's tokens written out and
the fonts and logo from `SITE_URL`, light or dark by the device, and is
sent `no-cache`. Console `GET linkpage` (the rows with each one's opens
in the last 30 days, views and opens a day, the icons), `POST
linkpage/settings {on, title, bio}`, `linkpage/save` (a new row, or `id`
to change one), `linkpage/delete` (its counts go with it) and
`linkpage/order {ids}`, all on the Files tab, logged
`link-page-settings/add/edit/delete/order`; both tables ride the full
export. At most 60 rows.
**The board can be a picture** (`site_text.link_page_bg`, a key in the
Files tab's drop that has to be a picture; `site_flags.link_page_dim`,
0 to 90 percent and 45 untouched, and `link_page_blur`, 0 to 20px;
`linkpage/settings {bg, dim, blur}`). The page draws it as a layer under
a black shade at that opacity, the layer pulled 40px past the board's
edges so a blur leaves no pale rim, and served from the drop's public
route (`pictureUrl`, `PUBLIC_API`), since the short host answers nothing
else; deleting the file from Files puts the black board back. The card
uploads a picture into Files shrunk to 2400px and made a JPEG in the
browser (which leaves its camera data behind), and shows the header as
it will look beside the two sliders, with the WCAG contrast of white type
against the shaded picture's brightest tenth worked out on a canvas
(`paintContrast`), red under 4.5:1. While the database is away the
backup's page still names the picture, but the drop's route needs the
database, so the board shows its plain black then.
**The page reads the database once a view** (`readPage`: the switch, the
two lines of text and the rows in one `batch`), and **survives the
database being away**: every save (`writeSnapshot`, and the card's first
read when none is there) writes the drawn page and each shown link's id
and address to Workers KV (`LINK_PAGE_KV`, key `snapshot`), a separate
service. A visit reads the database live, so an edit shows at once;
when that read fails or takes over `LIVE_WAIT` (3s, `within`) the page
comes from the snapshot, and `/l/<id>` redirects from its list. Nothing
is counted then, a hidden link is not in the list, and with the page off
the snapshot is deleted, so an outage sends the bare domain to the site.
Without the binding there is no backup and the card says so (`backup`
in `GET linkpage`). The binding is `id = "PASTE-KV:scs-link-page"` in
`wrangler.toml`, filled by `npm run deploy` (root `CLAUDE.md`, Hard
rules); the setup is in README.md, Link page backup. The test D1's
batch answers a read's rows as D1 does (`tests/d1-shim.mjs`).
`verify-linkpage.mjs` fails the database and checks the page and a link
come from the snapshot and nothing is counted.
**The payphone quest** (`src/phone.ts`, migration `2026-12-phone.sql`,
`tests/verify-phone.mjs` and `verify-phone.cjs`; the phone worker is
`phone/`). A team rings
the event's number from a payphone and keys in its phone PIN. Twilio
posts the call to the phone worker, which checks the signature and asks
this worker what the call does next: `POST /api/phone/step {node, state,
digits, from, call, recorded}` (Bearer `PHONE_SYNC_KEY`, routed beside
`/api/team-checkin` ahead of the Discord signature check) answers
`{actions, result}`, the actions being `say`, `gather` (keys wanted,
with `to: {node, state}` for where they come back), `record` and
`hangup`. **This worker decides everything and owns every word**
(`resultLine`); the phone worker only speaks.
**A capture** (`capture`) is one team at one payphone, once: `UNIQUE
(team_id, payphone_id)` on `phone_captures` decides a repeat, so two
calls at once make one. It is recorded as an organiser's entry on the
code picked on the dashboard (`recordPoints`, by `phone`, note
"Payphone: <name>"), so the ledger's rules, undo, the receipt, the
team's channel post and hidden teams all apply with no code of their
own. The code has to be **per unit or counted**, which the settings
save enforces: per unit pays each capture up to its `most`, and past
that a capture is kept with `capped = 1` and no entry; counted adds to
the quest's challenge. A code renamed or deleted afterwards is not
followed (`code_missing` on the card says so).
**The caller's number decides before the PIN is read**, so neither a
withheld number nor a mobile is a way to try PINs: `callerKind` reads
Twilio's `From` as `private` (empty, `anonymous`, +266696687), `mobile`
(+614, +615), `landline` (+61 2/3/7/8) or `other`, and only a landline
goes on. Eight wrong PINs from one number in ten minutes lock that
number (`phone_calls`, where `caller` is a hash of the number, never the
number: a mobile that rings by mistake is somebody's own). **A number
counts once an organiser says it is a payphone** (`payphones.state`:
`new`, `ok`, `no`): a capture from a `new` number waits with no entry,
and confirming the number on the card, or an organiser keying the
organiser PIN (`site_text.phone_staff_pin`) at that phone, records
every capture waiting on it (`settleWaiting`). Saying a number is not a
payphone stops new captures there; entries it already made are taken
back on the ledger like any organiser entry.
**PINs** (`phone_pins`, six digits, `pinFor`): minted the first time a
team asks, never the submit code, which has letters and opens the
team's submissions. `GET /api/phone/mine` (a submit session, `private,
no-store`, 404 while captures are off) answers the number, the PIN and
the team's payphones by name, never their numbers. The public quest
list marks the quest holding the code with `phone: {number}` while
captures are on, and a settings save bumps the `quests` counter so the
site reads the list again.
**The phone tree** (`site_text.phone_tree`, `cleanTree`, `phoneTree`,
`phoneStep`): what a call hears, as up to thirty named steps, edited on
the card and heard by the next call. A step is a `menu` (words, and a
step for each key), a `capture`, a `record` (a message of 5 to 120
seconds, from a team when `pin` is on) or a `say`, and any but a menu
may name the step that follows. With none saved a call is one capture
step (`DEFAULT_TREE`). **What a call has proved travels in `state`**
(`{t: team, n: tries, w, c: caller key, p: payphone}`): the phone
worker puts it in the address Twilio posts back to, which Twilio signs,
so it cannot be changed on the way. A capture that proves a team goes on
to its next step with that team; one that proves none ends the call. A
walk is held to `MAX_HOPS` steps a request, so a tree that loops ends.
**Messages** (`phone_messages`, audio in the bucket under `phn/`):
`POST /api/phone/message?rec=&call=&node=&seconds=&state=` (the same
key) takes one recording's audio as its body, at most 10MB, and keeps
it once per `rec`, Twilio's id for it, with the team and payphone from
the state. The storage card counts `phn/` as Phone messages and the
table rides the full export. Console (all under the Quests tab): `GET
phone` (settings, payphones, PINs, the last sixty calls, the tree, the
last two hundred messages), `POST phone/settings {code, number, open,
staff_pin}`, `phone/payphone {id | number, name, state}`, `phone/pin
{team_id}`, `phone/tree {tree}` or `{reset}`, `GET phone/message?id=`
(the audio, fetched by the page with its session and played from a
blob), `phone/message/heard` and `phone/message/delete`; logged
`phone-settings`, `phone-payphone`, `phone-pin`, `phone-tree`,
`phone-message-delete`. Deleting a team takes its PIN and captures
(`forgetPhoneTeam`). The card is `src/dash/js/phone.js`, behind the
Quests tab's **Payphones** button.
**The EOI award** (`src/eoi.ts`, migration `2026-10-eoi.sql`, table
`eoi_people`, `tests/verify-eoi.mjs`). Everyone who filled in the
expression of interest before sign-ups opened earns their team points,
once per person. The Settings tab's **EOI** card takes the points per
person (`eoi/points`) and a CSV (`eoi/list`, replacing the list before
it): one person a row, their email address and/or zID in any columns,
a heading row and anything with neither passed over, the same person
twice kept once, `z0000000` not a zID. A person counts when **either**
matches their signup — not everyone is a UNSW student, and people give
different addresses in different forms. **It is a loose code, `EOI`**:
no quest group, hidden, `points` the set value, `label` "Expression of
interest". **The points go on when somebody presses Award the EOI
points** (`eoi/award`, logged `eoi-award`): an award on the ledger with a
line per team crediting how many of its people are on the list. Pressing
it again (**Award again**) voids the last award and makes a new one from
the list as it is then, in one batch, so a second press at the same
moment pays once; with nothing changed it answers `unchanged`. Neither a
new list nor a signup moves anybody's score on its own: the card says
how many teams have a different count now (`waiting`) and each team's
people beside what was awarded. It used to be recounted by the scheduled
run every minute, which moved scores with nothing in the log and nothing
on the receipt. Changing the points re-scores the award's lines, as any
code's points do. What treats a completion as a quest leaves it out, and
the adjustments' code `ADJ` and the deleted quests' `DELETED` with it
(`NOT_QUESTS` and `notQuest` in tab.ts): `standings`' quests done, the
team page's quests done, `questsDone` and `lastScored` (Last scored), and
the quest list never had any of them. **No quest may take one of those
codes** (`reservedCode`): a quest saved, imported or added through
`quests/add` with `EOI`, `ADJ` or `DELETED` as its key or one of its
codes, or anything whose `norm` reads as one (`adj`), is a 400 saying
what the code is kept for, since the save would otherwise adopt the
loose code and its points and submissions with it. A quest that already
holds one may rename it away. The team page shows it
under **Non-Quest Tasks** (`award: true` on the line) in a table headed
Task with no Recorded column, because the time is only when it was
awarded. The score sheet names a loose code by its label. `eoi_people`
rides the full export.
**Six numbers the dashboard can change** (`settingValue`/`setSetting`
in shared.ts over `site_flags`, which is an integer store): the Rego
tab's `rego_per_hour`, `rego_per_ip_hour`, `rego_email_per_hour` and
`rego_email_per_day` (through the existing `rego/settings/set`), and
the Settings tab's `submit_max_pending` and `album_anyone_per_hour`
(`GET limits`, `POST limits/set`, `CONSOLE_LIMITS` in console.ts, an
allow-list so a typo cannot create a setting nothing reads). Each
falls back to the value the code ships with, so an untouched dashboard
behaves exactly as before; each is bounded 1..100000 server-side,
because a limit reading zero turns everybody away; each change is
logged. **What is not settable is deliberate**: the Workers request and
subrequest caps, R2's part size, Discord's limits and the design
system's numbers are someone else's constraint, and a dial there is
only a way to break things at 2am.
**What the event keeps** (`src/storage.ts`, `GET /api/console/storage`,
Settings; the Settings tab's **Storage** card, `paintStorage` in the dashboard's `storage.js`).
The bucket is listed object by object, five list calls of a thousand a
request, and the page asks again with `cursor` until `done`, adding the
answers up. Each object gets an area from its key's prefix (`sub/`
proof, `alb/` albums, `msg/`, `qst/`, `slide/`, `drop/` the Files tab,
anything else elsewhere; a deleted quest's file is kept and named for it,
"SQ12 (deleted): sheet.pdf", from `quest_files.deleted_key`) and a kind (`placeObject`): a key a row points
at is the file as sent, a photo, a video or other by its type; one in
`staged_uploads` is an upload not saved yet; a key with a `DERIVED`
suffix whose base has a row is that copy (`.t` thumbnail or still, `.v`
viewing copy, `.x` metadata block, `.p` the file as picked, `.c` a
video's full-size copy, or on a photo the old cleaned copy Tidy
deletes); an `rnd/` key is a video copy at its height in
`submission_renditions`, counted in the area of the file it copies;
and a key nothing points at is not linked to anything. **The file's
type comes from the listing** (`include: ['httpMetadata']`), which every
upload sets, so photos and videos are told apart without a row each.
The first answer also carries the database (its size from D1's
`meta.size_after` and the rows in every table, which the test D1
reports too), the files as sent by team and by album, read from the
rows; every answer carries the biggest twelve objects it saw. Nothing
is stored: a count is the page's. The check-in worker's database and
bucket and the map tiles' bucket are not bound here and are not in it.
`verify-storage.mjs` lists across requests from a bucket that answers
four objects a call and checks every object's place, and
`verify-console-ui.cjs` that the card follows the cursor.
**`POST /api/team-checkin`** (the check-in worker's report, Bearer
`TAB_SYNC_KEY`) is routed in `route()` *before* the Discord signature
check — it used to fall through to the signature verify and 401. It
comes on every check-in and every undo now, not only when a team
completes, and carries the person; see the team channel posts above.
**A team part-way in** (`team_arrivals`, migration
`2026-10-team-arrivals.sql`: team name, `last_at`, `checked_in`,
`people`; `noteArrival` in index.ts). The report also carries `last_at`,
the check-in worker's latest time for the team; an older check-in
worker sends none, and then an arrival is stamped now and a departure
leaves the time alone. Nobody in deletes the row. **A report older than
what the tab holds changes nothing** (`stale` in the answer): the report
carries `at`, when its change happened (an older check-in worker's
arrival is read by its `last_at`), and one earlier than the team's
stored completion or last arrival is passed over, so a "2 of 3"
arriving after "3 of 3" does not take the completion away. The stamps
are whole seconds, so **on a tie the report with fewer people in is the
older one** and is passed over too (`lastReported` answers the time with
how many were in by then). Its line is
still posted, since the person did arrive. A rename on the Teams tab or
the Rego tab moves both tables to the new name (`moveTeamCheckins`).
**The team is found the way check-in stores its name** (`teamForCheckin`
in rego.ts): check-in's `cleanText` drops ``<>&"'` ``, so `Salt & Pepper's`
is reported as `Salt Peppers`. The tab's own spelling is tried first,
then every team's name through `checkinName` (the same stripping),
ignoring case, hidden teams included (they get no Discord line). Both
tables are written and read under the tab's real name, by name ignoring
case, the way `moveTeamCheckins` and the team page read them; rows a
worker from before this kept under check-in's spelling are moved across
on the team's next report. A name check-in cannot tell from another
(`Foos` and `Foo's`) goes to the tab's exact spelling: check-in has
already merged the two at the door.
**A lost report is caught up** (`reconcileCheckins`): check-in sends
each report once, and one the tab refuses (a `TAB_SYNC_KEY` that does
not match) is gone; check-in now logs the refusal with `console.error`.
The day board (`GET board`) and the Rego tab already fetch check-in's
`/api/status` on every read, and in
`waitUntil` every team its `team_list` shows complete that has no
`team_checkins` row gets one, with check-in's `completed_at` and size,
`ON CONFLICT DO NOTHING`, so it is idempotent and never fails the
overview. It only adds: a lost undo is not taken back off. The team page reads
`team_checkins` first and this only while the team is not complete, so
its line says "3 of 4 checked in, the last at …" until the last person
arrives; a time outside the Recap card's Arrivals frame is left off as a
test run.
Web submissions (`src/submit.ts`, site `/submit`): team name + submit
code (minted in the console, `team_codes`) → 24h session; multipart
`POST /api/submit/create` (what the quest takes, below, past the
team's review cap queued rather than refused (below); ≤48MB per inline
file and ≤90MB per request) → R2
`scs-submissions` under random `sub/<16 chars>` keys (`sub/<id>/…`
before, and both shapes are read). **The files go into the bucket
before any row, and the submission and every file row go in as one
batch**: a bucket failing part way used to leave a pending submission
with no proof in it, counting against the team's limit, and the retry
made a second one. Now a failure takes back what was stored and
answers 500 with nothing recorded; the file rows find their submission
with `(SELECT MAX(id) FROM submissions WHERE team_id = ?)`, which is
the one just inserted because D1 runs a batch with nothing between its
statements. Files over 48MB (≤4GB)
ride a `bigfiles` manifest on the same create call: each gets a
`submission_files` row with `status='uploading'` plus an R2 multipart
upload (`upload_id`, `part_size` 20MB), so the tab sees the
submission at once — Review and mine mark the file "still uploading"
(`media[].uploading`), the gallery filters it out, and the thumb
(sent as `bigthumb<i>`) previews meanwhile. The bytes follow as
`PUT upload/part?file=&n=` (exact slice size enforced; R2 wants every
part equal but the last), etags in `submission_upload_parts`;
`upload/finish` completes and flips the row to ready,
`upload/status` lists landed slices **and answers `name` + `quest`**
(a page picking an upload back up days later must not have to guess
what the half-finished thing is proof of; an entry stored by an older
build is repaired from this), `upload/abort` drops file (and
an emptied pending submission). **The flip to ready and the abort are
each conditional on the row still uploading**, so whichever of the two
lands first wins: an abort after the flip is a 409 and the file stays,
and a finish whose row went meanwhile (an abort, the submission's
Delete) deletes the file it just joined. A slice landing after either
is refused rather than writing its parts row back, and the emptied
submission is deleted in the same statement that asks it has no file
left. The dashboard's two deletes (a submission, a team) abort a
direct upload through R2's own API (`directAbort`), as the routes here
do. The page splits files at 48MB, sends
slices one at a time with three tries each, keeps unfinished uploads
in localStorage `scs2-submit-uploads`, nudges >500MB toward
/compress, and after a reload asks for the same file again (size must
match) to resume from the missing slices; `beforeunload` warns while
slices are in flight. OPTIONS now allows PUT. Thumbnails: workers cannot resize images, so the
submit page downscales each photo (and grabs a frame of each video)
to a ≤300KB JPEG before upload (`thumb<i>` fields, 480px long edge)
and the worker stores it at `<key>.t` — no DB row; `?thumb=1` on the
file endpoints serves it, falling back to the viewing copy (`.v`) for
a photo and only then to the file, so older uploads keep working
without a grid of them being a grid of whole photos (the album and
submit routes). A video with no still answers 404 to `thumb=1` on those
two routes rather than sending the video: Safari takes a video in an
img and downloads every byte of it. **A video can arrive with no still**
when the browser sending it cannot decode it (an iPhone's HEVC in
Firefox, a long video past the page's four seconds), so two things make
one later. The encoder takes a frame from the smallest copy it made and
sends it to `PUT /api/encoder/still` (`encoderStill`), which stores it
at `<key>.t` through `storePreview` only where there is none: the
page's own is kept. And for a video encoded before that, the album page
asks again with `fetch` when a video's tile fails (`opts.instead` on
`scs.keepPicture`), and on a 404 draws a frame from its smallest copy in
the browser (`scs.videoFrame`) for the tile and the viewer's poster.
**What a quest takes** (`rules.files` through `rulesForGroup`;
`proofKind`, `proofBytesMatch`, `publicKind` in submit.ts). The create
refuses a file of a kind the quest does not take, more than its `max`,
none when `required`, and any file on a quest with no kinds, which is
sent with its answers alone (and with nothing at all when it asks
nothing: a claim the reviewers check). `MAX_FILES` is gone; the default
of four lives in rules.ts. A file's kind is its type, or its name when
the type is empty or `application/octet-stream` (how a GPX arrives). A
GPX track or a PDF has its first bytes read (`documentMatches`), is
stored under `storedTypeFor`'s type, and gets no `.t`, `.v` or `.c`; a
file sent in slices is read once it is whole, at either finish
(`storedMatches`/`refuseStored`), and dropped with its row when it is
wrong, which now covers a big photo too. **A GPX or a PDF is the
organisers' alone**: `/api/submit/file` answers 404, the gallery,
gallery albums, `/photo/` and `/view/` leave it out (`SHOWN` in
albums.ts), and `verdictText` links photos and videos only, up to ten,
each link whole within the 2000 characters. `points/add` applies the
quest's kinds and max (files stay optional; a staged GPX or PDF is read
there), and `points/form` carries each quest's `files`;
`submissions/files` applies the kinds and not the max, and the review
list carries each row's `files`.
`GET /api/console/file/track?key=` (`src/track.ts`; review, points,
scores) reads a GPX with a tolerant regex reader into `{points,
distance_m, started, ended, line}`, the line at most 300 [lat, lng] and
the distance the sum of consecutive points (so a gap between segments
counts); the Queue's cards draw it as a route with its name
as a download, and show a PDF as a link to the original.
`verify-submit.mjs` and `verify-points.mjs` cover it.
**A GIF never serves a still**: every small copy is one frame drawn
onto a canvas, so a GIF handed one in place of itself is a GIF that
does not play. `animatedType(type)` in shared.ts (GIF only — WebP and
PNG can be animated but usually are not, and treating them all as
animated would send full photos wherever a thumbnail was asked for)
gates three ends, not two. **The callers stop asking**: the messages
grid, the gallery grid and its `mediaUrl`, the submit page's lightbox
and the dashboard's review grid and preview all know the file's type,
so they drop `thumb=1` and `res=` for a GIF rather than relying on the
worker to overrule the request (`scs.animatedType` on the site, a local
copy in the dashboard page). The worker's half is the safety net for
callers that do not know the type — and for GIFs uploaded before any
of this. Then the four file endpoints (messages, submit, the
console's, quest files) skip `.t` and `.v` for one and serve it whole
whatever `thumb=1` or `res=` asks, and the upload paths store neither
copy — the submit page and the dashboard compose skip making them too.
Old GIFs that already have a `.t` are covered by the serving half.
**Metadata, and who gets to see it** (`src/strip.ts`,
`tests/verify-strip.mjs`): a phone writes where a photo was taken, on
what, and enough of a trail to say whether it has been edited since.
That belongs to the organisers judging it, not to every team that can
open the gallery — and `/api/submit/file` takes no session at all.
`stripImage(bytes, type)` removes it **by deleting bytes, not by
re-encoding**: a JPEG is a flat chain of labelled segments and nothing
in it refers to an absolute position, so dropping `APP1` (EXIF and
XMP), `APP13` (IPTC) and `COM` leaves a valid file with the identical
picture — `APP0`, `APP2` and `APP14` stay because they change how it
decodes. PNG is the same with `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`
chunks, and **GIF** with its comment, plain-text and application
blocks (XMP rides in one), keeping only the two that set the loop and
the colour profile's — it used to be served whole on the grounds that
it had nowhere to put a location, and it does. **A file it cannot
parse is handed back untouched** (`parsed: false`) and never guessed
at; one read through with nothing to take out is `parsed: true`,
`changed: false`, and is served as it is.
**What may come in** (`proofTypeOk`, `bytesMatch`, `storePreview` in
submit.ts; `sniffImage`/`imageMatches` in strip.ts): a team's proof is
JPEG, PNG, GIF, WebP, HEIC, HEIF, AVIF or a video type, and a picture's
first bytes have to be what its type says. **Never SVG** — it is a
document that can run script, and these files are served from the
dashboard's hostnames too. Messages and quest files take JPEG, PNG and
GIF for pictures, the same as the slideshow. A browser-made preview
(`.t`, `.v`) must be a JPEG or PNG and goes through the stripper on the
way in: the pages draw them on a canvas, but anybody can post to the
API without the page.
**The file a photo was picked as** (`<key>.p`; `storePicked`,
`pickedDeclared`, `recordPicked`, `settlePicked` in submit.ts,
`pickedMatches` in strip.ts; `picked_type` on `submission_files` and
`album_photos`, migration `2026-10-picked.sql`). The submit and album
pages make a HEIC, HEIF or WebP a JPEG before it goes up
(`website/assets/CLAUDE.md`), and the file as picked now goes up beside
the JPEG and is kept, its type in `picked_type` ('' for none), so the
people allowed the original can save what the phone wrote as well as
the JPEG. It travels the way its JPEG does: `picked<i>` beside a file
sent whole, `bigpicked<k>` beside a manifest whose slices come through
the worker, and for slices going straight to R2 the manifest entry names
it (`picked: {type, size}`), the upload answers that entry `picked:
true`, and the page sends it after the last slice in one PUT, with no
content type, to the address `upload/sign?…&picked=1` signs
(`directPutUrl`), before `upload/finish` reads it (`settlePicked`). Its
first 64 bytes have to be what its type says — RIFF....WEBP, or an
`ftyp` box naming a HEIF brand (heic, heix, mif1, msf1 and the rest),
which `....ftyp` alone does not prove, since every MP4 starts that way —
it has to sit beside a JPEG, and it is held to the size of a file sent
whole on that route, 25MB for albums and 48MB for proof; the page counts
it in the 90MB a request may carry and leaves it off a request with no
room. One that fails any of that is left out, or thrown away at finish,
and the photo goes in without it. The type is written after the rows
(`recordPicked`); where that write fails the file is deleted again,
since nothing could list it.
**It goes out only where the original already does**, because it holds
the location and nothing here can cut metadata out of a HEIC:
`picked=1` on `/api/albums/file` under `detailsHolder`'s rule (an album
showing details holds the photo, a gallery photo's too) and `picked=1`
on `/api/console/file` for proof on the dashboard. Anywhere else is
404, `/api/submit/file` included: the submit page hands a team only the
cut copy of its own proof, so it does not offer this either. Both answer
it as a download (`servePickedFile` in shared.ts) under the type in the
row, since one sent straight to R2 carries none, and the photo's name
with that type's extension. An album's listing carries `picked` (the
type) only where the album shows details, the dashboard's always, and
`attachMedia` on proof. The dashboard offers an album upload's through
the album's route, so only where its album shows details, the same as
its JPEG. **Every delete goes through `deleteStored`** (shared.ts): the
key and everything in `DERIVED` (`.t`, `.v`, `.x`, `.c`, `.p`) — an album
upload or album, a submission or a team deleted on the dashboard, a
proof upload aborted or refused, a staged upload, the drop, a message's
attachments, a quest's files and a slide. `verify-albums.mjs`,
`verify-direct.mjs` and `verify-submit.mjs` cover it.
**A stored file opened in a tab of its own is sandboxed**
(`serveStoredFile`): `content-security-policy: sandbox` and
`x-content-type-options: nosniff` on every answer except a PDF's,
which Chrome will not open in a sandbox and whose script runs in the
viewer anyway. A picture or video shown in a page is unaffected; a
document that somebody opens directly has no script and no origin, so
nothing in it can read the dashboard's session out of storage.
**Orientation is put back** (`orientationOf`/`orientationSegment`): a
phone does not rotate the pixels when you turn it — it writes the
picture the way the sensor read it and records which way up the phone
was in EXIF tag `0x0112`, and every browser turns the picture to match.
Deleting the whole block took that with it and portrait photos rendered
on their side. The tag is read out and a **fresh 34-byte block holding
only that one tag** goes back in its place (never any of the original),
so nothing identifying survives: orientation is a number 1–8. Nothing
else in EXIF changes what is on screen — the colour profile that does
is APP2, which is never removed, and the resolution tags only set the
size on paper. A photo already upright (1, or no tag) gets nothing back.
**A photo is stored once and cut as it is served** (`src/photoserve.ts`,
`serveCleanPhoto`). It used to be served from a cleaned second copy at
`<key>.c`, which doubled what every photo cost to store. Now the cut —
which stretches of the original to send, and the orientation block to
put between them — is worked out once and kept in the edge cache at
`/__photo-plan/<STRIP_VERSION>/<key>` for a week, and every answer is
one read of the original through `keepStream` into a
`FixedLengthStream`, so it carries a `content-length`. The cut is
worked out without holding the file: a JPEG's from its first 256KB, or
4MB if its metadata runs longer (`planJpegHead`; everything EXIF can be
is before the picture data), a PNG's by walking its chunk headers as
the file streams past (`pngWalker`, since a PNG may carry text after
its picture data), a GIF's from the file read whole (up to 32MB; a
bigger GIF is not served). The cached cut records the file's size and
etag, and a file replaced under the same key gets a new one rather than
the old cut applied to different bytes. The edge cache is per data
centre, so the first request in each works the cut out again: a 256KB
read for a JPEG, the whole file for a PNG. A file the cutter cannot
read is never sent as it is; the chain falls through to the copies the
sender's browser drew. Bump `STRIP_VERSION` when what comes out of
`stripImage` changes, and every cut is worked out again.
The block that came out lives at `<key>.x`, without a DB row like
`.t`/`.v`. `writeBlock` writes it at upload from the bytes in hand
(submissions, message attachments, quest files, albums, slides, the
drop); `metaBlock` writes it the first time it is asked for when the
upload did not (a direct upload, a file over 32MB, anything from
before). **What goes in it** (`metaBlockOf` in strip.ts) is the photo's
EXIF and then its XMP packet, either or both; `readExif` reads the TIFF
from the start and fills what it left empty from the packet, found
anywhere in the block, so a block of EXIF alone reads as it always
did. **A PNG's EXIF is in its `eXIf` chunk only some of the time**:
ImageMagick and GIMP write it as hex in a text chunk named `Raw profile
type exif` (zTXt, so it is inflated with `DecompressionStream`), and
Apple's screenshots, Photoshop and Lightroom write XMP in an iTXt
chunk named `XML:com.adobe.xmp`. Only the eXIf chunk was read, so an
album showing details said nothing about those PNGs. The cutters keep
a PNG's text chunks (up to 1MB each) and a JPEG's XMP segment as they
take them out. XMP is read with patterns for the few names wanted
(`exif:DateTimeOriginal`, `photoshop:DateCreated`, `xmp:CreateDate`,
`tiff:Make`/`Model`, the GPS pair as `33,52.98S`, ISO in an `rdf:Seq`,
and the rest), as attributes or elements. A PNG's text chunks are also
read for ImageMagick's hex XMP profile (`Raw profile type xmp`, and an
`APP1` profile that turns out to hold XMP rather than EXIF) and for the
PNG standard's `Creation Time` (ISO, the EXIF form or the e-mail form
`Tue, 21 Oct 2026 09:14:02 +1100`), which goes in as an XMP packet of
its own (`xmpOf`) when the picture has no other. **A GIF's XMP** is its
`XMP DataXMP` application block, the packet written straight in with
the 258 bytes after it that make a reader skipping sub-blocks land on
the end; `stripGif` keeps those bytes as it drops the block. **A
video's block is what its own boxes say** (`videoBlock` in
videostrip.ts, from the moov box it already reads to blank them):
Apple's keyed metadata (a `meta` box whose `keys` names each entry and
whose `ilst` holds them by number — the ISO 6709 location
`-33.8688+151.2093+012.000/`, make, model, software and the creation
date with its zone) and the older `udta` boxes (`©xyz`, `©mak`, `©mod`,
`©swr`, `©day`), written as an XMP packet so `readExif` reads it like
a photo's. A time in UTC is left out of it, as the movie header's
always was: the details give a time in the zone it was filmed, and UTC
is not that, so `takenOf` falls back to the movie header for the row.
The album details and the dashboard's details panel read a video's
block the same way they read a photo's. A missing maker note counts as
a sign of re-saving only where there was EXIF to have one (`judge`),
so a video or an XMP-only picture is not called edited for lacking it.
Every block is written with R2 metadata `read` (`BLOCK_READ`, now
`'3'`), and **a block from an earlier reading, empty or not, is read
again once**, the first time it is asked for, since a file that said
little to the old reader may say more now; one that cannot be read
again keeps what it had. The album details record a time found that
way on the row, for the order by time taken. The Settings tab's **Tidy
photo storage** (`POST /api/console/files/reclean`, batches of 12 with
an `after` cursor across submissions, message attachments, quest
files, album uploads, drop files and slides, logged `files-reclean`;
each of those six tables is asked on its own and the answers put in id
order, because D1 refuses a SELECT joined from six UNION terms — "too
many terms in compound SELECT", which is how Tidy failed on the real
database — and `tests/d1-shim.mjs` refuses more than five the same way)
deletes the `.c` copies photos used to be served from — a photo's
only, since a video's `.c` is the encoder's and is what plays — and
reads **when each proof file and album upload was taken** for the ones
from before that was written down (`taken_at` still null) and again
for every proof or album photo that gave no time (`''`), so a PNG or
GIF added before its text chunks or XMP were read gets its time and
its place in the Date taken order. A video that gave no time is not
read again. It answers `removed` and `dated`, and pressing it twice
changes nothing. **What cannot be got back**: a HEIC or WebP the
dashboard turned into a PNG before it kept the EXIF never sent its
EXIF, and the original was not kept, so those photos have none to
read.
**The file endpoints answer `immutable`**, which is true of the bytes
under a key. A device that cached a wrong answer keeps it: renaming
sw.js's `FILE_CACHE` (and deleting the old name in `activate`, since
that cache is otherwise exempt from the version cleanup) is what clears
it; a browser's own HTTP cache needs a hard reload.
**Each data centre keeps them too** (`edgeFileAsk`/`edgeFile` in
index.ts, in front of `route()` for `/api/{submit,albums,slides,
messages,quests}/file`): a gallery screen was fourteen D1 reads and
fourteen R2 reads, and the home page's pictures were read from R2 for
every visitor. A 200 that says `public` and `immutable`, carries a
`content-length` under 10MB and is not a range is put under its address
with `s-maxage=3600` added (taken off again on a hit, so the browser
sees what it saw before). **Never kept or answered from it**: a range
(a video player always asks one), a link preview (`isLinkPreview`, which
gets the full picture or the upright copy under the same address), a
person opening the address (`sec-fetch-dest: document`, or `Accept`
naming HTML with no such header, who gets the file's page; the routes
say `Vary: Sec-Fetch-Dest` and the edge cache ignores Vary), and
`orig`, `picked`, `download` and `uploaded`, which go to some and not
others. **An album upload can be replaced in place or pointed at
another photo** under the same key, so `albumEdgeMark` (albums.ts, one
D1 read) puts its version and its pointer in the key as `__edge`; no
other file route rewrites a key. A file deleted can be served from the
edge for up to the hour, as the browser's own copy can for its year.
**Many thumbnails in one answer** (`GET /api/thumbs?k=<key>&v=<version>&k=…`,
`src/thumbs.ts`, answered at the top of `fetch` ahead of the edge cache,
`THUMBS_MAX` 30 a request, more or none a 400). The album page and the
gallery ask for a screenful of grid thumbnails at once (`website/assets/
CLAUDE.md`, Thumbnails in batches), because one request a tile was what
a fast scroll took into the Cloudflare rate limiting rule. Each part is
asked of the worker's own `fetch` exactly as the page would ask for it
on its own — `/api/albums/file?key=…&v=…&thumb=1` for an `alb/` key,
`/api/submit/file?key=…&thumb=1` for a `sub/` key, anything else
missing — so **a batch opens nothing the single route does not** and
each part is read from and kept at the edge under the same address. A
part that is not a 200 image under 1MB going out `immutable` (a
stand-in, a 404, a failure) is listed as missing and the page asks for
it alone. The answer is a four-byte big-endian length, that much JSON
`{parts: [{key, type, size} | {key, missing}]}` in the order asked,
then the parts' bytes; `public, max-age=31536000, immutable` when
nothing is missing and five minutes otherwise, since a missing part may
be there later. `verify-albums.mjs` holds a batch to the single route.
**A stand-in is kept by nobody** (`STAND_IN_CACHE` in submit.ts,
`private, no-store`): a video's still in place of the video, or a
height other than the one asked for (`renditionFor`'s `exact`, the
largest rendition in place of the clean copy), from either file route.
Those used to go out `immutable` as well, so a browser and the edge kept
a still or a 480 under an address that later served the real copy. Once
the encoder is `done` the set of copies is final and the nearest height
goes out `immutable` again (a 720p video asked for 1080, `/view/`'s
og:video); a still in place of a video never does. The service worker's
file cache leaves out a `no-store` answer too (`keepableImage`).
`verify-submit.mjs` holds what is kept and what is not, stand-ins
included, and `verify-albums.mjs` the replacement with the old answer at
the edge and an album video's nearest height mid-encode.
**The dashboard page** (`/dash`, and the spinner) is built once per
isolate with its tag (`dashPage`) and sent `private, no-cache`: it is
the same for everyone and holds no session, so a reopen is a 304 rather
than 170KB.
**The serving split is the actual boundary**: `serveTeamFile` never
reaches an original as it is. The chain is `.t` (thumb=1) → rendition
→ `.v` → the photo cut, or a video's `.c` → the largest rendition for a
video → `.v`/`.t` at a smaller size → 404. The other public endpoints
share `servePublicCopy`.
**A link preview skips to the full picture.** `isLinkPreview(request)`
(shared.ts — Discord, Slack, Twitter, WhatsApp and the rest by
user-agent) makes the three public picture endpoints ignore `thumb=1`
and `res=`, because the URL people copy out of a page is the one in
its `img` tag: a photo pasted into Discord was embedding at 480px.
Pictures only — bumping a video would have an unfurl pulling a whole
original down the venue connection — and the bumped answer carries
`private, no-store` so a full-size body is never stored under a
thumbnail's URL. A plain URL is unchanged for everyone, unfurlers
included, **except a photo stored on its side** (`uprightPreview` in
submit.ts, `jpegOrientation` in strip.ts). A phone stores a photo taken
upright sideways with an orientation tag, and the cut keeps the
tag so browsers turn it; Discord sizes its preview from the stored
width and height and then turns the picture, so portrait photos in the
team-channel posts came out squeezed into a landscape box. An unfurler
asking for a JPEG whose head says it is turned gets the viewing
copy (`.v`, else `.t`) instead: both were drawn on a canvas the right
way up and carry no tag. `servePublicCopy` does the same for the
message, quest file, drop and slideshow endpoints, and the answer is
`private, no-store`. A photo whose head cannot be read counts as
upright, so a doubt keeps the old answer. A file still `status='uploading'` answers 404
rather than its preview. `/api/console/file` is unchanged and is the
one endpoint that still serves originals; `GET
/api/console/file/meta?key=` parses the `.x` block with `readExif` →
`{has_exif, taken_at, modified_at, gps, make, model, software, lens,
maker_note, signals, verdict}` and the Review preview renders it
(`.preview-meta`, a link to the point on OpenStreetMap). The verdict
is evidence, not proof — anyone who strips a file before uploading
defeats it — but a screenshot of someone else's photo arrives with no
camera data at all, and that is what it catches.
**Video never goes through the stripper at all** — `strippable` is
pictures only, so `writeBlock` writes nothing for one and the tidy
leaves its `.c` alone. It goes the other way, on the encoder: a
fourth output made
with `-c copy -map_metadata -1` repackages the container without
touching a frame (seconds, no quality lost, any size) and uploads as
`height=clean` to `<key>.c`; the 480/720/1080 renditions carry
`-map_metadata -1` too, since ffmpeg copies the source's metadata by
default and every smaller copy was inheriting the phone's GPS. A
clean copy of any size now goes up (in slices when it has to), so
`largestRendition` only stands in when the copy did not come out.
**A video the encoder has not reached is not publicly servable** —
that is the cost of never serving an original.
**Which way up a video is** was checked rather than assumed, since a
photo's orientation was lost once to a step that looked like it only
touched metadata. A phone films in landscape whichever way you hold it
and writes the turn into the track header instead of rotating the
frames. Against ffmpeg 7.0: `-map_metadata -1` clears the tag
dictionaries and leaves the track header alone, so the stream copy
keeps the turn; a rendition re-encodes through autorotate, which bakes
the turn into the frames and needs no header (a 320x240 clip turned 90
comes out 360x480). `probeVideo`/`sameWayUp` in encoder.mjs now
**measure every copy against the source** and refuse one that came out
the wrong shape — a clean copy that lost the turn is not uploaded and a
rendition that did is left out, both with a line in the runner's log,
so a different ffmpeg build cannot quietly hand out sideways video.
`tests/verify-encoder-orientation.mjs` proves all of it against a real
ffmpeg, including that a copy which lost the turn is caught; it skips
where ffmpeg is not installed, so run it on a machine that runs the
encoder.
**Viewing copies**: the submit page also makes each photo a ~1920px
long-edge JPEG at 0.8 (`imageView`/`makeViews`; sent as `view<i>`,
inline files only, sent whenever it fits under 2MB — it used to be
held back unless it was clearly lighter than the original, which meant
a small photo had no copy at all and a request for a smaller one fell
through to the file the camera wrote), stored at
`<key>.v` (no DB row, like thumbs). Serving: on both file
endpoints, after the video-rendition step, any `res` short of
`original` tries `<key>.v` (`wantsSmaller` in submit.ts) and falls
back to the original — so the gallery grid lightbox, slideshow
(photos follow the same quality setting as videos; Original means
the full file for both), the mine table's lightbox and the Review
preview all ask with `&res=` and older uploads keep serving
originals. `?thumb=1` still wins. Covered in `verify-submit.mjs`,
`verify-submit-page.cjs` and `verify-gallery.cjs`.
**Straight to R2** (`src/r2direct.ts`, `tests/verify-direct.mjs`; setup in
README.md, Uploads straight to R2). With `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` set (secrets) and
`R2_BUCKET` (wrangler.toml `[vars]`), `GET /api/submit/upload/mode` and
the public `GET /api/album/upload/mode` answer `direct: true`, and the
submit and album pages send **every** file as a manifest (`whole=1` on
the create or the album upload, `bigfiles` for all of them,
`bigview<k>` for a photo's viewing copy, and the HEIC or WebP it was
picked as named in its entry and sent whole to a signed address of its
own, **The file a photo was picked as** above) with no bytes in the request.
The worker starts an R2 multipart upload over R2's S3 API rather than
the binding, keeps R2's id in `upload_id` behind the mark `r2:`
(`markDirect`/`isDirect`), and answers each upload with `direct: true`.
The page then asks `upload/sign?file=&n=` (albums: `&token=`) for each
20MB slice and sends it to the signed address it gets back, which is
good for `SIGNED_SECONDS` (fifteen minutes) and asked for again on
every try. The slice carries no headers and no content-type, so the
bucket's CORS rule only has to allow PUT. **The worker never sees a
slice**, so at finish it lists what R2 holds (`directLanded`: only
slices at their full size count), joins them (`directJoin`), reads a
photo's first bytes and throws the file and its row away if they are
not what the type said (the check a send through the worker makes
before storing), and writes the photo's metadata block then rather
than on the first read. `upload/status` lists R2's slices too, so a resumed
upload sends only what is missing; `upload/part` refuses a direct file
and `upload/sign` a worker one. Without the secrets the mode is false,
nothing is signed, and a `whole` manifest that arrives anyway goes
through the binding's slices, any size. **The signature** is AWS
signature version 4 on WebCrypto, the same as `sign()` in
scripts/backup.mjs; verify-direct holds it to AWS's "get-vanilla"
vector and the presigned GET in S3's documentation, and its pretend R2
checks every request with the backup script's node:crypto copy and a
presign check of its own, so a mistake shared by the worker's signer
and its test cannot pass. A dashboard delete of an unfinished direct
upload (a team or a submission) aborts it through R2's S3 API
(`directAbort`), since the binding does not know R2's id; one sent
through the worker is aborted through the binding. The dashboard's own uploads and
the encoder go straight to R2 too (the next paragraph, and **The
encoder goes straight to R2 too** under the video renditions).
**The dashboard's uploads straight to R2** (`src/staged.ts`, table
`staged_uploads`, migration `2026-10-staged-uploads.sql`;
`tests/verify-staged.mjs` and `tests/verify-console-direct.cjs`, which
drives the real dashboard page against the real worker and the pretend
R2). Every dashboard save that carries files — a message's
attachments, a quest's files, a slideshow picture, the drop's upload
and replace, the photos on points and Review's Add files — sends each
file first when `upload/mode` says direct. `upload/start {purpose,
name, type, size}` (purpose `msg`, `qst`, `slide`, `drop` or `points`,
which is proof and open to Points, Scores and Review; refused for an
account without that kind's tab, and over its ceiling: 25MB for the
first three, 4GB for the drop and points) opens an R2 multipart upload
under the key the file will keep (`msg/`, `qst/`, `slide/`, `drop/`,
`sub/`). `upload/sign?id=&n=` signs each 20MB slice, `upload/finish`
joins them, checks a picture's first bytes and writes its metadata block,
and `upload/abort` drops it. The save then names the file by id:
`staged<i>` beside `thumb<i>` for messages and quest files, `staged`
for a slide and the drop, and `staged` repeated in the order of
`thumb<j>`/`view<j>` for points and `submissions/files` (a mix with
`files` is refused). The
route still applies its own type rule and, for messages, quests and
slides, its 25MB cap; the drop's 90MB and proof's 48MB and 90MB are
one-request limits and hold only a file sent in the save. **A route
adopts a staged file in three steps**: `readStaged` while reading the
form (finished, sent by this account, for this purpose), `claimStaged`
once every other check has passed and before anything is written (a
conditional update, so two saves cannot take one file; a save that
gets only some gives back the ones it took, read from `RETURNING`, never
one the other save has just claimed), and
`releaseStaged` in the batch that writes its own rows; a write that
fails after the claim gives the files back (`unclaimStaged`). The route
stores nothing and reads nothing, since the file is already under its
key. **A replaced drop file has to keep its key**, so R2 copies the
staged object onto it server side (`directCopy`; a 502 and the file
given back if that fails), and the staged object goes only after the
row is written, so a failed save can be sent again with the same file.
A file is staged under the name typed for it, since the name is fixed
at start. The page's helpers are `uploadMode`, `stageFile` and
`stageFiles` in `src/dash/js/uploads.js`; without the token every save
carries its files as before. The dashboard's album upload needs no staging, since
album uploads have rows of their own: in direct mode it sends `whole=1`
and each slice to `/api/album/upload/sign`'s address, as the site's
album page does. The scheduled run's `stagedSweep` clears what was
started or finished and never saved a day on (logged "N unsaved
uploads cleared"), and leaves the object of a row a save claimed and
never released, since a row of the save's may point at it. Abort and the
sweep delete the row first, and only while it is in the state they
read (`forget`), then its object: a save that claimed the file in
between keeps it. The finish's flip to ready is conditional too, and a
finish aborted while joining deletes what it joined. **A replaced drop
file is copied onto its key before its row is written**, and there is
no order that avoids a mismatch: the copy overwrites the old bytes and
cannot be undone, and writing the row first moves the mismatch to a
failed copy, which is handled cleanly today.
**Past the review cap: queued, not refused** (`promoteQueued`,
`waitingFor`, `MAX_QUEUED` in submit.ts). `submit_max_pending` (12 by
default, the Settings tab's submission limit) is how many of one team's
submissions the reviewers see at once. A send past it used to be a 429,
which stopped a team playing for as long as the reviewers were behind,
and it happened on the day. Now the create stores it with `status =
'queued'` and answers `queued: true` (and `ahead`, how many of the
team's were queued before it); a team with anything queued queues every
new send too, so nothing jumps the line. Which of the two is decided in
the INSERT itself, from the team's rows as they stand then, so two sends
at once with one place left put one in review and queue the other; the
answer reads back what the insert decided. **Queued is not in Review**:
the list's `pending` filter does not show it, nobody can accept or
reject it, and the day board's pending count leaves it out. It becomes
`pending` in the order it came, keeping its own `submitted_at`, as
places free: `promoteQueued(db, teamId?, cap?)` is one UPDATE (a
`ROW_NUMBER()` per team against the team's pending count), so two
callers at once cannot both fill a place. It runs on the team's own
reads (`mine`, `score`, and the create before it decides) and for every
team on the scheduled run each minute (`queue` in schedule.ts, logged
"N queued submissions moved to review"), so an accept or reject
reaches the queue within the minute without the dashboard's code
knowing it exists. Only `MAX_QUEUED` (40) queued is refused, the old
429 and its wording, so a client stuck in a loop cannot fill the
bucket. The public `submissions_pending` (the live tab's "waiting" line),
the recap's pending counts and an aborted big upload's cleanup all
treat queued as not yet reviewed; the score sheet answers `queued`
beside `pending`. `status` is free text, so no migration.
`verify-submit.mjs` covers the queue, the promotion both ways and the
ceiling; `verify-submit-page.cjs` the page's side.
**Team score sheet**: `GET /api/submit/score` (team session Bearer,
no-store) answers `{ok, frozen: false, team, rank, teams, total,
lines, pending}` — `lines` is the team's live lines added up per
code (the view `held`) (`{code, group_key, name, scoring, amount, points, worth}`, worth
descending; a tiered or counted code's amount and points are null and
its `scoring` says so, so the page shows what it came to rather than
reading it as a mystery quest's part mark), `rank`/`teams` count the visible teams that finished (a
hidden team gets `rank: null`, and so does one that did not finish,
with `dnf: true`, which the page's Place reads as "Did not finish"),
`pending` counts its waiting submissions.
While the tab is frozen it answers `{ok: true, frozen: true}` and
nothing else — the score sheet is standings and freezes with them;
401 bare when signed out. The submit page renders it as `#sub-score`
under the form (stat row for place and points via `scs.digits`, a
`table.nice` of lines, a pending line; the frozen answer draws a
note instead; any error hides the section silently), refreshed on
sign-in and after each send.
**Challenges** (`src/tally.ts`, `tests/verify-tally.mjs`): a quest
whose `rules.tally.kind` is set is counted across everything a team has
had accepted for it, on any of its codes, an organiser's entries
included. `picks` is the different entries in its first pick question,
matched without regard to case or surrounding spaces, each kept with the
submission that first brought it in; `sum` adds up the first count
question; `highest` takes the highest number given to it, for a
challenge a team sends again through the day to beat its own best ("the
most people in one photo"), its `waiting` the highest waiting number only
where it would beat that and `tally/team`'s `best` the submission that
first reached it (the dashboard marks it, and the submit page says "Your
highest"); `submissions` counts the accepted rows, leaving out an
organiser's entry that took points off and an adjustment (a credit
carrying `points`, `tookOff`). **The number is often the
reviewer's**: a running total or highest number on a quest that asks no
number question counts the number a reviewer typed, kept in the
submission's answer as an entry of its own (`{kind: 'count', value,
prompt: 'Counted'}`, at the top or under `more`; `answerTo` finds the
first number entry when the quest has no number question). Review's
list carries each row's `tally`, and a pending card for such a
challenge has a number box beside Accept (the quest's own number
question's answer where it asks one, empty otherwise); a number put
right goes in through `submissions/answer` once the accept has gone
through, so a refused accept leaves it as it was (a number that then
fails to save says so, and Change number puts it right). A decided
card has Change number, and the desk's form has a Counted box for
a challenge with no number question (`points/form` carries each quest's
`tally`). `countOf` and `withCount` in the dashboard's `parts.js` are the one reading and
writing of it; `countOf` falls back to the first number in the answer
when the question's slot holds another kind, as `answerTo` does, so the
box beside Accept starts from the number the worker counts. Pending and queued submissions are `waiting`, shown
apart and never counted. Places follow the count,
a tie sharing one (1, 1, 3); a team with nothing counted has no place,
and a hidden team is counted and flagged but never placed. One read of
the quest's submissions does the lot. Console: `GET tally?quest=`
(standings, awards, `settled`) and `GET tally/team?quest=&team_id=`
(counted entries, accepted submissions through `attachMedia`, waiting
ones apart), open to Review, Scores, Points and Quests and scoped by
`scopeCodes`. `POST tally/award {quest}` (Scores) credits each placed
team, as one award on the ledger (kind `challenge`, its `basis` the
counts, places and bands it was worked out from): on a quest with a
counted part, a line on that part worth the band the team's count reached
plus its place's points (the board carries each team's `band` and the
part's `bands`, and the Standings card a Band column and **Award bands
and places**); otherwise `award / points` on the first visible code. The
unique index on a live award makes a second a 409; logged
`tally-award` and purged. **An award has no submission row behind it**,
so it is in the log and on the receipt and not in the team's Already
sent. `POST tally/unaward {quest}` (Scores, logged `tally-unaward`)
voids the award, which voids its lines, once, and the places can be
awarded again. An award the migration carried over from before awards
kept what they gave (token `seed-…`) that never had a line (its points
are balances) answers 409; any other is undone, one whose lines were all
undone one at a time on the ledger included, which would otherwise stay
live with nothing behind it and block a new award (`awardUndoable`).
The board's `settled.undoable` says which, and the desk's Standings card
offers **Undo the award** only then. The wager settle is the same
(an award of kind `wager`, its basis the winner and the stakes;
`quests/group/ask/unsettle {key}`, logged `ask-unsettle`,
and the desk's question card's **Undo the settlement**); the question stays
closed. Both keep what they gave through a change to the code's points
(`setByAward` in ledger.ts). The settle, the unsettle and the answers
list are refused (403) to an account limited to other quests, as
opening the question is (`verify-ask.mjs`). A challenge's desk shows the Standings
card; a team's name opens its part in place (what it counted, when, and
every accepted photo and video in one grid, `reviewMedia`), and Award
points by place names the points before the second press.
`GET /api/submit/tally` (team Bearer, `private, no-store`, 401 bare,
`{ok, frozen}` / `{ok, closed}` like the score sheet) feeds the submit
page's count line. `GET /api/quest/standings` answers only with `public`
on and the quest visible to the reader, hidden teams left out. It is
not in `FROZEN_PATHS`, since the freeze keeps copies of three fixed
payloads and none of these, so it stops itself while frozen or closed.
It is kept at the edge for 10 seconds under its address only when the
answer is everyone's, and `purgeApiCache` adds each public challenge's
address (`standingsPaths`).
**Rejection reasons**: reject in the dashboard takes an optional
reason (≤200 chars, into `submissions.reason` — the column was
already in the schema for this, so no migration), `mine` carries it
back and the submit page shows `Rejected: <reason>` on the card in
`--alert-ink`; the rejection push body becomes `<code> — <reason>`.
**Deleting a submission** (`deleteSubmission`, console
`submissions/delete {id, note}`, logged `submit-delete`): from any
state, usually because the team asked (the submit page's About says to
ask @TabTeam). The row stays with `status = 'deleted'` and the note in
`reason` (≤200), so the team's list shows "Deleted: <note>" in the
muted ink rather than the red a rejection gets; the file rows, the
upload slices and the renditions go in the same batch as the status
change and only if this request is the one that changed it (a stamp in
`claimed_at`, as Accept does), then every object under the file's key
(`.t`, `.v`, `.c`, `.x`, `.p`) and each rendition comes out of the
bucket and an unfinished multipart upload is aborted. **An accepted
one's points come off with it**, in the same batch and under the same
stamp: the first statement takes the row only from the credit it was
read with (`credit IS ?`, credit cleared), its lines are voided
("Deleted: <note>") under the same stamp, and two presses at once take
the points off once. The team's
channel is told as for an undone entry (`verdict: 'adjusted'`), the log
row carries the delta, and the answer carries `total` and `off`, which
the dashboard's second press names ("Delete and take 25 points off").
One accepted before `credit` was kept is refused (`NO_CREDIT`). A
deleted one that gave nothing is listed under Rejected or deleted on the
team's ledger and the quest's desk, and one that gave something shows
there as its voided lines; `gallery` is cleared, though the gallery only
ever lists accepted ones. No push: the team asked for it.
`verify-ops.mjs` covers it, the double press included.
**Changing a decision** (`reviseSubmission`, `rejectAccepted`,
`reopenSubmission` in console.ts; `relineSubmission` in ledger.ts). Two
console actions, all Review's like the rest of `submissions/`, all
through the router's purge (each can move scores), each logged with the
points delta and the totals before and after:
`submissions/revise {id, codes, amount, awarded}` (`submit-revise`, the
codes before → after) and `submissions/reopen {id}`
(`submit-reopen`). **Change** works out the new credit by Accept's rules
(`readCreditFrom`, the part types), voids the submission's
lines ("Changed") and writes a line for each code of the new credit,
so whatever else the team holds on a code stays. The same credit sent again answers `unchanged: true` and moves
nothing. **Reject** on an accepted one takes its whole credit off, sets
`rejected` with the reason and `credit` NULL, and tells the team the way
a rejection does (`tellRejected`: the push and the post); the gallery
flag is left as a normal rejection leaves it, since every gallery read
asks for `accepted`. **Reopen** sends an accepted or rejected one back to
`pending` (reviewer, time, reason and credit cleared, an accepted one's
points off) to be decided again with Accept or Reject; the team is not
told — the decision that follows is. A rejected one is not accepted
directly: Reopen then Accept. **Each batch's first statement takes the
row only from the status and credit it was read with** (`credit IS ?`),
stamping `claimed_at` as Accept does, and every line voided or written lands
only under that stamp: a second press or two reviewers at once move the
score once, and the other is a 409 saying it has changed since it was
loaded. Refused: a submission accepted before `credit` was kept (409,
adjust the team's ledger instead — what it gave is unknown), Change on one whose quest
has gone (409), Change on an adjustment (409: its credit's `points` set
its worth, which Accept's rules would drop; Take back and adjust again,
and the Queue offers no Change on one), an account that does not score the quest and every code
before and after (403), and Reject or Reopen on an organiser's entry
(409 — Take back is that); an organiser's entry can be changed. So
`credit` says what a row has on the tab now: NULL on pending and rejected
rows. **What the team sees needs nothing new**: Already sent reads the
status, the reason and `part` from the row, and the score sheet reads
the lines. The post for a change is `verdict: 'revised'` in
`verdictText`: "changed: now worth 80 of 100 points", or "changed to
part marks: 80 points" on a mystery quest. Review's list carries each
row's `credit`. **A card's buttons are four verbs and a menu**: a
pending card has Accept and Reject; a decided card has Change
(`creditForm`, the boxes Accept draws, filled from the credit, with the
desk form's worth line and "was N" after it) and **Undo**; everything
used once in a while (Change number, Edit answers, Add files, Delete)
is behind **More** (`moreMenu`, a `details.menu` like the Quests tab's
Import and export). Undo is one word whoever made the line, and the
page picks the action: a team's accepted submission goes back to the
queue (`submissions/reopen`, "It goes back to the queue."), a rejected
one too with no points to move, and an organiser's entry, the
dashboard's or a Discord command's, is taken back (`points/undo`,
which Review may send as well as Points and Scores). Where points move
the second press says how many ("Take 25 points off", "Give 50 points
back" for an entry that took them off). Reject on an accepted card is
not offered: Undo, then Reject from the queue, which tells the team as
any rejection does.
One undone has **Put back** (`points/redo`), as its row on the team's
ledger and the quest's desk do. The Standings
card's **Undo the award** and the question card's **Undo the
settlement** are the same word. **Who recorded it reads plainly**: an entry Discord recorded is
stored as `discord:<username>`, and every place the dashboard names a
recorder or reviewer (`byName`: Review's head and stamp, the Recorded
list, the receipt) shows it as "sam (Discord)". `verify-points.mjs`
covers the moves, the once-only and the refusals and a reviewer taking a
Discord entry back, `verify-console-ui.cjs` what Change and Undo
send and that a card shows Change and Undo with the rest under More.
**Editing what a team answered** (`submissions/answer {id, answer}`,
`reviseAnswer` in console.ts, logged `submit-answer` with the answer
before and after in the quest column). Any submission but a deleted one
(409), by an account that scores its quest (403); the answer is the
create's shape and goes through `cleanAnswer`, so a bad one is a 400 and
an empty one clears it. **A pick or codes list over `MAX_PICKS` (60) is
refused** with a 400 saying so, by the create, `points/add` and this
alike (`cleanAnswer`'s `why` carries the words); it used to be cut to
the first 60 without a word, and a picks challenge counted short. Nothing on the tab moves, but a challenge
counted from the answers counts the new one, so it goes through the
router's purge for the public standings. The review list answers
`questions`, each quest's questions by quest id (`questionsByGroup` in
quests.ts), and `places` when a pick question picks from @stations or
@sushi. Review's **Edit answers** (any card whose quest asks something
other than codes) swaps the answer lines for the desk form's boxes
(`answerInput`, shared with it), started from what was sent; a codes
question is kept as sent, since Accept and Change decide the codes.
**A team's ledger** (`GET team/receipt?team_id=`, `teamReceipt` in
console.ts; Review, Points or Scores; the dashboard's **Ledger** tab,
`#view-ledger`, open to any of the three). The answer is the team's lines
on the ledger quest by quest: every line in time order (`lines`: what
made it, who, when, units and points, for a submission's line `sub` —
its status, code, when it was sent and decided, by whom, and an
adjustment's reason — and for a voided one who voided it and why), the
submissions that give each quest something now (`entries`), what the
team holds per code (`held`) and `other`, the live lines no submission
made (Points by place, Wager settled, Expression of interest, a balance
from before the ledger), each with its `label` (a deleted quest's lines
are a block of their own per code they came from, named "SQ12 (deleted)"
with `key` the holder's, `DELETED`, whose desk lists every team's moved
lines; each such line carries `deleted_from` and its `code` reads as the
deleted one); then the team (`team`:
hidden, `dnf`), its place among the visible teams (`place` of `of`),
what is still waiting on review or queued (`waiting`) and the newest
fifty that gave nothing, rejected or deleted before they did (`closed`,
with the reason). `times` is how
many submissions gave a quest something, which is how a quest credited
twice shows. `media` is each submission's files by its id (`lineMedia`,
through `attachMedia`, one query for the lot), so a row shows its photos
and videos small under its words with the Queue's grid (`reviewMedia`,
`.lg-media`), a click opening the same preview; an undone row keeps
them. Codes outside the account's quests are left out. **The tab
draws it as the team's statement**: the name, the total and the place,
the submissions waiting and those rejected or deleted (each opens its
card on the Queue), and a block per quest, its heading opening the
quest's desk, with its total in the points column and one row per thing that
moved it — a submission's lines are one row ("Sent …, accepted by …",
the codes under it when there are several or a count), an award's one,
each balance its own. **Show undone lines** (kept per browser) puts the
voided rows back, struck through, with who undid them and why. A row's
**Open** shows its submission's card alone on the Queue; an organiser's
entry has **Time** (`points/time`); **Undo** asks in a row under it for
a reason and names the points ("Take 100 points off"): on a team's
submission it is the Queue's Undo (`submissions/reopen`, back to the
queue), on an organiser's entry `points/undo`, both taking the reason
as an optional `reason` added to the line's void reason ("Taken back:
…"), and on an award's or a balance's line, or a deleted submission's
that kept its points, `ledger/void {id, reason}` for each line on the
row, where the reason is needed (the next paragraph). A taken-back entry's
voided row has **Put back**. **Adjust** in the head opens the form that
replaced the Scores tab's hand-set table (`score/set` and `GET
team-scores` are gone): a quest or none, the points, positive or below
zero, and why, which the team reads, the button naming what it does
("Take 30 points off"); it posts `ledger/adjust`. The Queue with one team
picked shows a line over the list with the team's points and **Open the
ledger**, and the Teams tab's rows have **Ledger**; the tab keeps the
last team picked (`scs2-dashboard-ledger-team`). **Adjust**
(`ledgerAdjust` in points.ts, Points or Scores, logged `ledger-adjust`)
is an organiser's entry like `points/add`'s, written by `recordPoints`
with the reason in `submissions.reason`, so it is on the team's Already
sent, on the quest's desk and taken back and put back the same way. On
a quest it is that code's units (points ÷ its points); with no quest it
goes on `ADJ` (`ADJUST_CODE` in tab.ts), a loose hidden code worth 1
point labelled Adjustment, made the first time it is needed. A code
worth 0 cannot carry points (400). **Undoing one line**
(`ledgerVoid`, Points or Scores, logged `ledger-void`) voids an award's
line for one team or a balance, needs a reason and tells the team's
channel as an adjustment; a submission's line is refused (409), because
the submission would still say it gave it, unless the submission is
deleted: the ledger migration's "Deleted, points kept" rows have live
lines and no other way to be undone. The ledger and the desk offer Undo
on such a row, with the reason it needs, and void every line on it. Both are behind the second
password's `adjust` switch, and the award, unaward, settle, unsettle
and EOI award are behind `award` (`GUARDS`). **A quest's desk** (the
**Desk** tab, `#view-desk`, which the Points tab became; `GET
desk?quest=`, `questDesk` in console.ts, open to Review, Points and
Scores). One quest at a time, picked at the top (kept per browser,
`scs2-dashboard-desk-quest`; an account with one quest has nothing to
pick). **Record a result** is the form the Points tab had, for that
quest: the team, the parts and the box each one's type takes (a count,
a part mark, the number reached; a counted part says it counts towards
the challenge, and the line under says so too), the answers, a note and
the files, sent as `points/add` (`partInput` in the dashboard's `parts.js`, which the
Queue's Accept and Change draw from as well); it shows only to
Points and Scores. A challenge has its **Standings** under it (the
award and its undo moved here from Review narrowed to the quest), and
a quest that asks a question has **The question**: the answers counted
and, for a wager, the settlement, drawn by `drawAskResults`, under the
switch that opens and closes it and its closing time (`askRunBar`;
`ask/responses` reads for Review, Points and Scores as well as Quests,
`ask/open` is Points and Scores as well, `ask/settle` and `ask/unsettle`
Scores as well). **Teams** is every team with lines on the quest's
codes, best first, each drawn the way a ledger draws a quest, its name
opening the team's ledger, with Open, Undo, Time and Put back on the
rows; over it what waits on review for the quest and what gave nothing.
The answer is `{quest, teams: [{id, name, hidden, worth, lines}],
waiting, closed, media}`, the lines and the files in the ledger's shape; a quest the account
scores none of is a 403. It replaced the Recorded list
(`points/recent`, gone): what was recorded is on the desk of its quest
and the ledger of its team. A quest's editor has **Its desk**; Review
narrowed to a quest no longer shows standings. **Copy as image** in the
head (`copyReceipt` in the dashboard's `share.js`) puts the statement on the clipboard as
a PNG to paste to the team, a code that is gone left out; the select
beside it (Quests only, With codes, Detailed; localStorage
`scs2-dash-receipt-detail`, read from the old `scs2-dash-receipt-compact`
once) says how much it shows under each quest. Every picture the dashboard copies is drawn in the
theme it is showing, which is the device's (`darkNow`). The drawing is the
site's `assets/share-image.js` (`website/assets/CLAUDE.md`), the same
one a team's own page uses after the event, loaded from `SITE` the
first time a picture is wanted (`shareImageLib`); `copyPicture` starts
the clipboard write inside the click with the picture still a promise,
since Safari needs that and the click cannot wait for the script, and
saves the file where the clipboard refuses. Without the site deploy
that carries the script the button says it could not be drawn. **The
standings as a picture**: the Tab view's Public tab card has **Copy the
standings as an image** (`#standings-image`), drawn from `GET
standings` (scores access), which is the board as it is whatever the
freeze says, since the committee wants the real order to announce; a
saved copy under it has its own **Copy as image** (`#copy-image`).
**The tab as a sheet**: the same card's **Export the tab** (`#tab-export`)
downloads `scs2-tab.csv` from `GET tab/export` (scores access;
`tabCsv` in tab.ts), in the shape of the committee's spreadsheet
(`data/quest-tracker.csv`): `Challenge` and then a column per team, in
the order the teams were made, a row per code in the dashboard's code
order, each cell the team's amount and empty where it holds none. It
has only the teams on the public board (hidden teams left out) and only
the codes anyone may see — not hidden, and in no quest that is hidden or
shown to signed-in teams or a team group only — so EOI, a hidden
code, is not in it either. It is the live tab, whatever the
freeze says, with no totals row. `verify-visibility.mjs` covers it.
**The quests everyone sees**: the Quests tab's Import and export menu
has **Export what everyone sees** (CSV and JSON) beside the full export:
`GET quests/export?format=&only=everyone`, the same file the full export
writes (so it imports back the same way, `scs2-quests-everyone.csv`),
cut to the quests the public list would show (`canSee` with no viewer)
and to each one's codes that are not hidden. `verify-visibility.mjs`
covers it.
**The Recap tab** (`ranks` in the code and the address, labelled Recap;
opened with the Scores permission — `TAB_PERM` — so it needs no tick of
its own) holds every leaderboard, and under them the **Recap card**
(moved off the Scores tab, which is looked at all day while this is set
once; its actions are the Scores permission's, so it could not go to
Settings without locking out an account with one and not the other). The
encoders card sits at the foot of Review rather than above the queue.
The boards are
loaded when the tab opens and again on **Count again**, a card each:
**Points** from `GET standings` (the tab as it is now, frozen or not,
with a dash for a team that did not finish), **Quests done** and
**Photo to submission**, then any boards made there. Hidden teams follow
**Hide hidden teams everywhere** on every board but Points, whose read
has none, and level teams share a place (2, 2, 4).
**Quests done** ranks the teams by how many different quests each has
done, from `GET quests-done` (scores access; `questsDone` in tab.ts). A
quest's codes count once between them, so S24-1 and S24-12 are both
S24: the sub codes are the codes a quest was given on the Quests tab,
and a code in no quest is a quest of its own. Only credit counts, an
amount above zero on a code worth points, so a penalty code is not a
quest done; EOI is left out. The worker sends every team with its count
and the quests' keys, hidden ones flagged, and each team on the board
opens to the keys it counted. It counts every quest, whoever could see
it.
**Photo to submission** (`GET ranks/times`, `submitTimes` in tab.ts) is
each team's average time from taking a photo or video to sending it in:
over the accepted submissions the team sent itself (`added_by` empty), each
with at least one file whose `taken_at` is known, the gap from the newest
such file to `submitted_at`. Both are UTC, so they subtract. A gap under
none or over a day (`DAY_SECONDS`) is a phone clock set wrong or a picture
from before the day, and is not counted; a team with nothing counted is
not on the board. The board says the average, how many submissions it is
over, and Fastest first or Slowest first.
**Boards made on the tab** (**Add a board**): a quest picker (every quest,
each quest by key and name, and the loose codes) and what to count:
accepted submissions, points, or **Challenge count**, a challenge's own
count (stations visited, say; `challengeCounts` in tally.ts), from `GET
ranks/custom?quest=&measure=` (`boardTeams` in recap.ts, over
`customBoard` in tab.ts; a count on a quest that is not a challenge is a
400). A submission is matched to its quest the way Review's quest filter
matches, the quest's key or a code in no quest, in any case; points add
up what the quest's codes put on each total. **The boards are kept on
the worker** (`rank_boards` in `site_text`, `GET/POST ranks/boards`,
logged `rank-boards`, at most twelve), so every organiser sees the same
ones; each has a title and an **On the recap page** tick, and the recap
lists the ticked ones (`boards` in its payload, the first five places,
hidden teams out, a blank title read as the quest's name). Boards this
browser kept for itself before (`scs2-dashboard-boards`) are sent up
once when the worker has none. **Remove** takes one off. The pickers are
refilled whenever the quest list arrives (`fillCustomQuests` from
`paintQuestGroups`), keeping what each had picked, and so is the Recap
card's pick of quests to leave out of Most done side quests and Rarely
done. **Quests done and Photo to submission can go on the recap too**:
each card has its own On the recap page tick (`rank_recap` in
`site_text`, JSON `{quests_done, submit_times}`, read back with `GET
ranks/boards` as `builtin`, saved by `POST ranks/recap`, logged
`rank-recap`). Ticked, the recap's `boards` start with **Top 3 Fastest
Submitting Teams** and **Top 3 Slowest Submitting Teams** (`measure:
'time'`, the value the average in seconds; the slowest are counted from
the teams not already among the fastest, so a handful of teams is not
listed twice) and then **Quests Done** (`measure: 'quests'`, the first
five places), hidden teams out, before the boards made here.
`verify-ops.mjs` covers the counting behind all three.
**More of the Recap card** (recap.ts; `verify-recap.mjs` covers each).
**Sections of the organisers' own** (`recap_sections` in `site_text`,
`GET/POST recap/sections`, logged `recap-sections`): at most twelve, each
`{title, text, items: [{title, text, media: [{key, alt}]}]}` (the texts
markdown, through `cleanBody`; twenty entries, six files each), the way
SCS.1's recap had a section per competition with its winners and their
photos. A file is one on the Files tab, named by its `drop/` key; any
other key is dropped at save, and the recap's `sections` gives each file
its address (`filePath`) and type, leaving out one since deleted. The
editor is under the card's Leaderboards: a heading, its words, entries
with a title, words and files picked from the Files tab's pictures and
videos (`GET recap/sections` answers them as `files`), moved up and
down, saved whole. **One quest's page** (`GET /api/recap/quest?key=`,
`questPage`, behind the recap switch and the closed tab like the other
two, open CORS, no-store): the group by key, any case, not hidden;
`teams` the board's; `done_by` the visible teams with credit on its
codes; `submissions` {sent (all but deleted), accepted, rejected,
waiting (pending and queued), teams}; `accepted`, every accepted
submission's team and time in the order sent, then those sent outside
the team pages' Quest times frame with `at` empty, so their times are
never sent.
**Quests shown photo by photo** (`src/visits.ts`, the Recap card's
**Quests shown photo by photo**, `recap_quest_views` in `site_text`,
JSON `{KEY: view}`; `POST recap/views {key, view}`, the Scores
permission like the rest of the card, logged `recap-view`, answering
the card's settings with `quest_views` among them; migration
`2026-12-photo-near.sql`, table `photo_near`; `tests/verify-visits.mjs`).
Every quest shows on its recap page and the replay as each team once,
when it sent its first accepted submission. A quest done at many places,
where one submission often carries photos taken at several of them, can
be set to show each photo instead: `stations`, at the station on the
submit page's list it was taken at, or `places`, at the one of the
quest's own pins it was taken at; `sent` (or nothing) sets it back. No
quest is shown this way unless the card says so. **A photo's place** is
the one nearest where it was taken, within reach (`REACH_KM`: half a
kilometre for a station, one for a quest's place), or the place the
submission picked when that one is within reach too (two stops a street
apart, a location read underground); what a submission picked is its
pick answers that name one of the places, and for a quest's places also
the pin its codes name or the quest's only pin (`placeFor`). The
stations' points are `src/data/stations.ts`, written by
`scripts/station-points.mjs` from the site's transit map (three names
the map lacks are given there by hand; run it again when the list or the
map changes). **Its time** is when it was taken
(`submission_files.taken_at`, read on the way for a file never read),
unless that is more than twelve hours before it was sent or five minutes
after, which is a camera clock set wrong; then when it was sent. **A
place the submission picked that none of its files placed** is a visit
at the time of its earliest file placed by nothing, or when it was sent,
so a photo with no location stands for the place picked and a
submission with no files for each it picked. Per team and quest a place
counts once, at its first visit (`photoVisits`). Only accepted
submissions from visible teams count, and nothing here changes a score.
**The location is never kept**: `photo_near` holds, per file, the
stations within reach and the quest's places within reach, nearest first,
as JSON lists, read from the file's metadata block the first time it is
needed, `FILE_READS` (24) a request; rows for files that have gone are
cleared as new ones are written, and a quest's rows when its setting
changes (`forgetNear`), so a quest whose pins were edited is read again
by setting it again. A file not read yet counts as placed by nothing
until it is. `GET /api/recap/quest` carries `visits: {kind, teams}` for
such a quest (each team's `{place, at}` in order, most first, a time
outside the Quest times frame sent empty), and the replay a ring per
place (`stop`, `spot`, `taken`; `website/tab/CLAUDE.md`). Before the
migration every file counts as placed by nothing.
**A team's own submissions for one quest**: `GET
/api/submit/mine?quest=KEY` narrows the team's list to the codes of that
group. **Times without their date** (`date_rules` in `site_text`, `POST
recap/dates {rules}`, logged `date-rules`; read back with the card's
other settings): at most twelve `{kind: on | from | until, date}`, a date
that cannot be read dropped. The pulse carries them (`date_rules`) and
the site's time formatter applies them (`website/assets/CLAUDE.md`).
**The tab's public reads apply them too, so the date is not in the
answer at all**: `undated(db, body)` walks the leaderboard, the stats
(both through `apiResponse`, live or frozen), `/api/team`, `/api/recap`
and `/api/recap/quest`, and every stamp under `at`, `first_at`,
`last_at`, `checked_in_at`, `frozen_at`, `hour` or `peak_hour` whose day
in Sydney (`EVENT_ZONE`) a rule matches goes out as `HH:MM` on that
clock (`dateHider`). It works on a copy, so a frozen snapshot is never
changed, and the dashboard's own reads are untouched. Saving the rules
purges, since the leaderboard is cached. A new stamp in one of those
answers needs its key in `STAMP_KEYS`; `verify-recap.mjs` fails if any
date is left in the four answers.
**The spinner** (`/dash/spinner`; `spinnerPage` in console-page.js, its
files `src/dash/spinner.html|css|js`, bundled beside the dashboard's
through the same `#dash-files` and the same `[[rules]]` globs) draws a
team at random for prizes, each team's chance its share of the points.
It is a page of its own so it can go on a screen in front of everyone:
it reads `GET spinner`, which is the board's teams (hidden ones left
out) with their names, ids and live points and nothing else, open to
any account signed in, since `GET overview` already gives every account
more than that. It has no sign-in of its own: it reads the session the
dashboard keeps (`scs-console-session` in the browser), and without one
— or on a 401, when it drops the stored one — it links to
`/dash?then=spinner`, and the dashboard goes back to the spinner once
signed in (`show(true)`). The header's **Spinner** link opens it. The
wheel is a canvas: each ticked team with points above zero gets a slice
in proportion to its points; a team at or under zero stays on the list
and gets no slice. **A spin picks a point on the wheel uniformly at
random** (`crypto.getRandomValues`) and the winner is the slice under
it, then the wheel turns five times and more to bring that point under
the pointer, so what lands is what was drawn and each team's chance is
exactly its slice. The list's tick boxes, All and None, and **Take them
off the wheel** after a win, are kept per browser
(`scs2-spinner-off`, the ids taken off, so a team added later starts
on); **Hide the teams** leaves the wheel alone on the page. The points
are the live tab's whatever the freeze says, so while the tab is frozen
the slices show the real standings. `verify-ops.mjs` covers the read,
`verify-console-ui.cjs` the page, `verify-dash-bundle.mjs` the bundle.
**Adding files to a submission** (`addSubmissionFiles` in console.ts;
`dashProofFiles` and `writeDashProof` in points.ts, which `points/add`
goes through too). `submissions/files` is multipart: `id`, then the
files the way `points/add` takes them (`files` with `thumb<j>`,
`view<j>` and `picked<j>` beside each, or `staged` repeated). It puts
proof on a submission already sent, at any status but deleted (409):
what a team sent in Discord or by hand, or a file that failed. The
account must score the quest (403) and the quest's kinds apply, so a
quest that takes no files takes none here either. Its most does not:
the organiser is adding what the team could not. The submission may
still hold no more than `MAX_FILES_LIMIT` (20) rows after the add,
counting a file still arriving in slices like any other. The files go
into the bucket first and the rows in one batch; a batch that fails
takes back what was stored and gives staged files back. The rows are
the ones the create writes (`ready`, `encode_state` '' so the encoder
takes a video), with `taken_at` and `picked_type` written after. No
cached read lists a submission's files, so nothing is purged; an
accepted one in the gallery moves the `albums` counter, because the
gallery albums show it at once. Logged `submit-files-add` with the
code, the count and the names. The `points` staging purpose is open to
Review for this. Review's list carries each row's `files` (`{kinds,
max}`, the defaults for a loose code), and every card but a deleted one
has a button beside Delete: **Add photos** for a quest that takes only
photos, the other kind's name for a quest that takes one other, and
**Add files** for more than one. The picker takes the quest's kinds
(HEIC and WebP become JPEG carrying their EXIF, as on the desk
and in an album; everywhere else on the dashboard they become PNG,
which keeps a transparent picture transparent), the files wait in
rename rows with Add more, and Add to submission sends them through
`appendProof`, the same send the desk uses. `verify-points.mjs`
covers the add, the refusals and a reviewer's staged file,
`verify-console-ui.cjs` what the button sends.
**Video renditions** (migration `2026-10-video-renditions.sql`,
`ENCODER.md` is the guide): encoding runs on organisers' own
computers — `scripts/encoder.mjs` behind double-clickable
`scs-encoder.command` (Mac) / `scs-encoder.cmd` (Windows)
bootstrappers that fetch a portable Node + static ffmpeg into
`~/.scs2-encoder` when the machine has neither; nothing installs
system-wide. **The address and the key are two files in that folder,
one value each, written and read whole** (`<nul set /p` / `printf
'%s'` in, `set /p` / `cat` out; on Windows PowerShell writes the key
file itself so it never crosses a cmd command line). One `KEY=VALUE`
file was the earlier shape and it lost characters both ways — cmd
parses an unquoted `echo` (`& | < > ^`) and `for /f` stops a line at a
`;`, the Mac sourced the file so a `'` broke it — which made a key
with punctuation work in the run that typed it and answer `not
allowed` in every run after. Both launchers now read the values back
off disk in the same run that saved them, and delete an old `config`
and ask again. Any number of machines: each claims ONE video at a
time (pull-based — that is the whole load balancing; the claim is a
conditional UPDATE, losing the race answers 409), a claim expires
after 15 minutes, on launch the runner reports what is waiting and
asks before starting.
`/api/encoder/poll|claim|source|rendition|upload/*|finish`
(Bearer `ENCODER_KEY`, unset = 503, every call carries the
machine's `name`; **`GET source?key=` is the one way to an original
besides a dashboard session** — the public endpoint stopped serving
them, but the encoder is what *makes* the copy everyone else gets, so
it has to read the thing it is copying. It answers `private, no-store`
and 409 while a file's slices are still arriving. Missing this is what
made every video fail to download once; `encoders` table rows drive the Review tab's
per-machine box: online within 45s, state, jobs done, average pace
from `took_ms`). Renditions live in `submission_renditions`
(buckets 480/720/1080, R2 `rnd/` keys, never upscaled — a source
below a bucket is skipped, below 480p gets one copy at its own
height; H.264 CRF 23 veryfast + faststart, over-90MB encoded again at
CRF 28 and sent whatever comes out).
**A copy bigger than one request is not a copy that cannot be sent.**
One Workers request carries ~90MB and a clean copy is the source
repackaged, so it is the source's size — which is why the source
itself arrived in slices. `upload/start|part|finish|abort` is the
submit page's R2 multipart upload for the encoder: `start` names the
destination (`<key>.c`, or a fresh `rnd/` key) and returns the upload
id, `PART_BYTES` and the count, `part` takes one slice and answers
with its tag, `finish` hands the tags back for R2 to stitch. The
runner holds the id and the tags, so **no table backs this** — one
machine sending one file, and a machine that dies leaves an unfinished
multipart upload R2 clears itself. The destination travels in the
query string, so its shape is checked (`isRenditionTarget`) rather
than trusted, and each slice's length is checked against what
`partsOf` says it should be. `recordRendition` is the one place that
says what a landed copy means, whichever way it arrived (it replaces
a height's row only while it still names the copy it read, and the
insert lands only once that row is gone, so two machines sending the
same height delete every copy they replace); the runner
picks by size (`ONE_REQUEST_BYTES`) and retries a slice twice
(`PART_TRIES`) before giving up and aborting.
**The encoder goes straight to R2 too** when `directReady(env)`.
`GET source?key=&signed=1` answers `{ok, url}`, a `directGetUrl`
address good for 15 minutes from when the read starts, after the same
checks (and a `head` for the object), so a long original is not read
through the worker; without `signed=1` it serves the bytes, which is
what an older runner gets. `upload/start` opens the upload with
`directStart` and answers the id behind `r2:` and `direct: true`, and
the runner then sends **every** copy in slices whatever its size:
`GET upload/sign?upload=&stored=&n=&name=` signs one slice's PUT (asked
again on every try), the slice goes to R2 with no key on it, and
`upload/finish` takes the copy's `bytes`, joins with `directJoin`
against `PART_BYTES` and records through `recordRendition`.
`upload/part` refuses a direct id and `upload/sign` a worker one (409
both); `upload/abort` calls `directAbort`. Still no table: the runner
holds the id, and R2 is asked for the tags. The encoder's computer has
to reach `<account id>.r2.cloudflarestorage.com` (ENCODER.md).
`verify-encoder.mjs` runs the routes and the runner against
`tests/pretend-r2.mjs` and checks that no request to R2 carries
`ENCODER_KEY`.
`submission_files.encode_state` ''/encoding/done/skipped puts the
Encoding tag and the size list on Review cards.
**Neither `encoding` nor `skipped` is final, and both used to behave as
if they were.** A claim only expires after `CLAIM_MINUTES`, and
`skipped` — written whenever a run comes back with no heights — was
meant for a video that genuinely cannot be encoded but caught every
passing failure too (a closed laptop, a wrong key, a download that
broke). It was excluded from `FREE_FOR_ENCODING` *and* from
`encoderSummary`, so a failed batch left the queue and every count at
once and looked like videos that had stopped existing — and since
nothing public serves an original, those were videos nobody could see.
`encoderSummary` now counts `skipped`, the Review box shows it in
`--danger` as "N gave up", and **Retry failed videos**
(`POST /api/console/encoder/release` → `retryVideos`, logged
`encoder-retry`) puts both kinds back on the pile at once. A machine
genuinely mid-encode carries on; a second copy just replaces the first.
**Finish matches the claim**: claim answers `claimed_at`, the runner
sends it back with finish, and a finish that made nothing lands only on
a video still claimed with that stamp (a runner that sends none, only
on one still `encoding`), so a machine whose claim ran out cannot turn
another machine's `done`, or its live claim, into `skipped`. A finish
with heights marks any video not already done as done, since its
copies are saved. One that changes nothing answers `kept: true` and
writes no log row. Cards read it as `media[].renditions` ascending,
`media[].encoding` and `media[].skipped` (`attachMedia`); Review's card
tags a skipped video "Gave up", and the site's viewer shows it as its
still with "This video cannot be played here." rather than the
processing line, since nothing will make a copy until Retry failed
videos. Serving: `&res=480|720|1080|original` on the
public and console file endpoints — exact, else largest below,
else smallest above, else the original, `?thumb=1` still wins;
console video previews ask for 720. `tests/verify-encoder.mjs`
covers it.
**Videos the encoder has not reached** — the public endpoints never
serve an original, so until the encoder's copies exist there is nothing
clean to play. A page hands the viewer such an item as `{processing:
true, still}` rather than a video: the lightbox draws the still dimmed
(`.lb-processing`) with "Video is processing. Check back soon." over it
and no player. The submit page does it for a sent video with no
`renditions` (Download and Share were already off for one). It replaced
the browser's "no video with supported format" box, which is what a
phone's HEVC `.mov` showed. **The team gallery and the albums play the
video as it was sent instead** (the organisers' call), from
`/api/submit/file?key=…&uploaded=1` and `/api/albums/file?key=…&uploaded=1` (`serveUploadedVideo` in
`src/videostrip.ts`): the original's bytes with every `udta`, `meta` and
`uuid` box — where the phone writes the location, its model and XMP —
renamed `free` and zeroed as it streams, so nothing moves, every offset
stays right, Range works, and the location is not in what is served at
all. Which boxes those are is read once (each top-level header, then
the moov box whole, at most 32MB) and kept in the edge cache under
`/__video-patches/<key>`. A file it cannot read (WebM, a broken file)
falls through to the ordinary chain and is never served as it is. The
gallery's tile keeps its play mark, the slideshow plays it, and an item
there carries its `still`, so a browser that cannot play the file as
sent (HEVC in Firefox) gets the processing view in its place; the album
page does the same. `verify-submit.mjs` builds a QuickTime file with a
location in two places and checks what comes out, and
`verify-albums.mjs` the album route's.
`scs.lightbox(media, index)` (site-viewer.js + `.lb-*`
in site.css, z1400, back-layer aware) previews proof in place —
photos **zoom in place** (`armZoom` in the lightbox: wheel about the cursor,
double-tap 1 ⇄ 2.5 — a double tap or a wheel step glides there
(`apply(ms)` puts a 280ms/120ms transform transition on the img and
takes it off after, so a pinch or pan is direct again); pointer
events, one pointer map for the pinch; `img.lb-media { touch-action:
none }` so the browser's own gestures stand down — videos keep theirs,
and the backdrop still closes because taps on the media never did).
**It moves the way a phone's own photo viewer does.** A zoomed photo
pans until its edge meets the frame's, and an axis it does not fill
stays in the middle (`limits(s)`, measured against `.lb-frame`, so
the Details sheet's room counts); dragged past an edge it gives on a
rubber band (`banded`, the iOS curve `(1 - 1/(x·0.55/d + 1))·d` with d
the frame's size) and springs back when let go. Let go while moving
(`speed()`, the last tenth of a second of the photo's own positions)
it carries on and slows (`throwPan`: 0.998 of the speed kept each
millisecond), and anything that runs past an edge comes back to it on
a critically damped spring, so it never overshoots inward; a touch on
a photo in flight stops it there and is not a tap. Two fingers hold
the point of the photo between them under them (`pinchQ`), so a pinch
moves it as well as sizing it; past 1× and past 5× the size gives on
the same band in steps of size (a log scale), and let go it settles
back (`settle`), keeping the point between the fingers where it was. A
finger left on the photo after a pinch pans from there, or waits for
the size to settle first. Under reduced motion a throw just lands.
**A first finger down starts the count again** (`e.isPrimary` with
fingers still counted calls `forget()`, and the count is always the
size of the pointer map rather than a running tally): iOS can take a
touch for the home bar or Control Centre without sending its
`pointercancel`, and a count left at one turned every later tap into
half a pinch, so on the black screen — where the photo is the only
thing under a finger — nothing closed the viewer and the app had to be
force-quit. Both copies (site-viewer.js, photo-view.js) carry it. A
closing viewer takes no taps (`pointer-events: none` on
`.is-leaving`), and **a photo or video leaving the screen gives up its
picture at once** (`letGo`: an img's `src` and a video's sources taken
off, the video paused and unloaded, on every move and on the close,
which also destroys the size player and cancels the morph back's
held animation) — a whole photo decoded is tens of megabytes, and a
phone looking through a large album ran out and was left showing the
page's grey ground.
`verify-app-layout.cjs` drags a zoomed photo past its edge and flicks
it, through CDP touches.
`lightbox(media, index, origin)` — pass the tapped thumbnail as
`origin` and the photo **morphs**: it grows out of the thumbnail on
open (measured after the full image loads, skipped past 350ms so an
empty box never morphs; `.lb-morphing` stills the entry animation
while WAAPI drives transform) and shrinks back into it on close
(same slide, un-zoomed, thumbnail still on screen — else the plain
fade). A swipe that closes it leaves the backdrop part faded, and the
close fades it on from there (`overlay.style.opacity` is cleared as
`.is-leaving` goes on; the swipe's inline value used to hold it where
it was until the overlay was taken away, so the dark veil over the grid
vanished in one frame) — in the three copies. Dragging an un-zoomed photo up or down carries the frame
with the finger and thins the backdrop like the quest sheet;
released past 90px it closes, released short it springs back
(`settleSwipe`; a pinch starting mid-swipe settles it first, and a
swiped frame skips the morph back). **Dragging it sideways moves to the
next or the last photo** (`settleSlide`, a finger only, more than one
item): the frame follows the finger, and released past a fifth of the
screen or flicked (under 300ms, over 44px) it carries on off the side
while the next photo comes in from the other (`show(i, dir)` slides the
new media 48px in; the arrows and the arrow keys use the same); short of
that it springs back. The first move decides which of the two drags it
is. `lightbox(media, index, origin, opts)`: `opts.advance` (ms) moves on
by itself — timed from each photo's load, held while zoomed, while a
finger is down or while the page is hidden, restarted by any change by
hand, off under reduced motion; `opts.onShow(i)` hears every change,
`opts.onClose(i)` the close, and `opts.originFor(i)` names what photo i
shrinks back into, so a viewer that moved on can still morph back.
**A photo opens on the small copy the page already shows** (`thumb` on
the item: the album, gallery, submit and messages pages pass the URL
their grid loaded): it is drawn at the frame's size at once, and the
viewing copy goes in once it has loaded and decoded (`viewLater`), so
opening a photo no longer means black until the viewing copy arrives;
a small copy that fails gives way to it at once, and a video shows its
small copy as the poster until it plays. **A zoom brings the whole
picture**: a photo opens as its viewing copy (about 1920px), and an item carrying `full` (the whole photo, cut,
which the album, gallery and submit pages pass for every photo but a
GIF) has that fetched the first time it is zoomed past 1 and swapped in
once loaded and decoded (`sharpen`), so the zoom and the pan stay where
they are and a pinch shows what the camera took rather than a blown-up
copy. `opts.whole` fetches it as soon as each photo opens instead (the
album page, on a computer only: a phone's screen is no bigger than the
viewing copy, and on an iPhone a whole picture for every photo looked
at, beside three hundred thumbnails, ran the page out of memory). `morphIn`'s load listener comes off after it runs, or the swap
would play the opening morph again. `opts.info(i)` puts a Details
button beside Share (`.lb-info-btn`, pressed while open; the I key too)
that opens `.lb-info`, a 360px panel down the right that the photo,
the buttons and the next arrow move over for, or a sheet across the
bottom 48% under 761px with the photo above it. It answers a promise of
rows, `{icon, title, lines, href, link}`; the panel follows the photo
on screen and drops an answer for one already stepped past, and steps
aside with everything else when a tap puts the photo alone on black.
As a sheet it has a pull tab (`scs.pullTab`, in
`website/assets/CLAUDE.md`) and, for a finger, no close cross: dragged
down it closes, and the photo above grows into the room it gives up.
**While the viewer is open the page's own ground is the viewer's
black** (`html.lb-open`, and the sheet's black under the sheet,
`lb-info-on`): a phone browser whose bars leave a strip below a fixed
layer showed the page's light paper there, a white bar under the
sheet.
Escape closes it before it closes the viewer. **A photo or video is
drawn as large as the frame allows, whatever the size of the copy**
(`fitMedia`, `.lb-media.is-fitted`): an `img` or `video` with only a
`max-width` is never drawn larger than its own pixels, so a 1080p
viewing copy or a 480p video sat small in the middle of a big screen,
and photos were also capped at 1100px. Once the shape is known (the
image's load, the video's `loadedmetadata` and `resize`) it goes on as
`--lb-ratio`, and the width is `min(100cqw, 100cqh * ratio)` against
the frame, which is a size container; a browser without container
units keeps the old size. **A list that comes a page at a time** (an
album) passes `opts.total()` and `opts.more()`: the counter says the
whole count rather than what is loaded, the next page is asked for
once the viewer is within four of the last one in, an arrow past the
last one in waits for it and carries on (the album page's `nextPage`
answers the promise and appends to the same `media` array), back from
the first does nothing while the rest is still to come, and it goes
round only once everything is in. Before, the count was the pages
loaded (60 at a time) and the arrows went round inside them.
`verify-gallery.cjs` walks an album of 130 across its first page.
The share pages (`mediaPage`) open a photo on the whole screen
too: a click or a tap on it (or Enter, the photo takes the focus) opens
the site's `assets/photo-view.js` (`SCSPhotoView`, loaded from
`SITE_URL`; written up in `website/assets/CLAUDE.md`), which zooms and
pans the way this viewer does — the same physics, a double tap, a
pinch, a mouse click about the point clicked, one tap for black, a
swipe up or down or back or Escape to close — and carries the page's
own Details, Share and Download. Opening it, or a pinch zoom of the
page (`visualViewport.scale`), loads the whole picture in place of the
viewing copy, swapped into both the page and the full-screen view
(`viewer.swap`), under a loading bar of its own along the top
(`.ph-load`, the viewer's rules: shown after 250ms, the bytes counted
against the content-length, creeping without one, and an img load if
the fetch is refused before an answer). If the script has not loaded, a
tap opens the whole picture on its own. It replaced a click that showed
the photo at its own size with the page scrolling, and nothing at all
for a finger. **Every file's page has Share** (`#ph-share`,
`SHARE_SCRIPT`): this page's own address, through the phone's share
sheet on a handheld and the clipboard with a Link copied note
(`.ph-toast`) elsewhere, as below. **And Details where an album showing
details holds the file** (`#ph-info-open`): `mediaPage` asks
`detailsHolder` (in sharepage.ts, beside `viewedFile`, since albums.ts
already imports submit.ts and the file pages are reached from both)
for a photo or video from an album or the gallery, and the button opens
a sheet like the quest's (`detailsPanel`, `.qs.is-plain`: no region's
line or disc) whose rows are asked for from `/api/albums/info` the
first time it opens and drawn by the site's `assets/photo-details.js`,
the same rows the album viewer shows. The two sheets share one script
(`sheetScript(id)`): another control opens one with a `ph-open` event
naming itself (the full-screen view's Details does, so the sheet comes
up over it and the focus goes back to that button), it says `ph-shown`
each time it opens, and its Escape is taken in the capture phase and
marked used, so the full-screen view under it stays open. On a video's
row, which also holds its size menu, Download is a square at phone
width when Details or the quest is there too (`.ph-save.is-tight`), so
the row does not wrap. `verify-albums.mjs` holds which pages offer
Details and `verify-gallery.cjs` drives a page with the site's two files
on a phone.
`opts.shareUrl(i)` puts a Share button (`.lb-share`) beside Close for
any photo it answers a link for: the phone's own share sheet on a
handheld, the clipboard and a "Link copied" toast elsewhere, and
`opts.downloadUrl(i)` a Download link (`.lb-download`, an `<a>`, so
`.lb-top a` takes pointer events as its buttons do). **A choice of
file**: `downloadUrl(i)` may answer a list of `{url, label}` instead of
one address, and with two or more the button opens `.lb-save-menu`, a
list of those links under the buttons against the right edge, the button
drawn pressed (`aria-expanded`) while it is open. A link, Escape, the
next photo or a press anywhere else closes it, and that press does
nothing more: a capture-phase `pointerdown` on the overlay takes it
ahead of the photo's gestures and eats the click that follows. A page
that answers one address gets the plain link as before. The album page
answers two — Download JPEG and Download original (HEIC, HEIF or WebP)
— for a photo listed with `picked` (**The file a photo was picked as**,
above), which only an album showing details lists. The album page
passes both; the submit page passes both for a team's own sent files,
a share there being the file's named public path for a photo and its
`/view/` page for a video (below), and never offers the picked file,
since what it hands a team of its own proof is the cut copy. **Saving a
file**
is `download=1` on the file routes (`asDownload` in shared.ts, which
sets `content-disposition: attachment` with the name the file was sent
under and the extension of the copy served): `/api/submit/file` and
`/api/albums/file` hand over the whole file as the public sees it — never the original,
the same rule as the rest of those routes — and refuse a video the
encoder has not reached rather than hand over its still, so the submit
page leaves Download and Share off such a video. Those two serve the
file by calling themselves again without `download`, and **that inner
call carries `raw=1`**: Safari asks for a download link the way it
opens a page (`Sec-Fetch-Dest: document`), so at a file's named address
the inner call was answered with the file's page, and the share page's
Download saved that HTML under the photo's name. `/api/console/file`
hands an organiser the original. The dashboard's full-screen preview
(`openPreview`'s `actions`, from `fileActions(key, name, heights,
picked)`) has Download (the original for proof, the cut photo for an
album upload), or Download JPEG and Download original (HEIC) where the
photo was picked as one (Review's photos, and the album grid's where the
album shows details or for a gallery photo), and Copy link on
`PUBLIC_API` — `consolePage` takes it and writes it on the body as
`data-files` — a photo's named public path, which shows as
the picture when pasted into Discord, or a video's `/view/` page.
**Which copy of a video plays** is `website/assets/video-sizes.js`
(`window.scsVideo`), one file loaded by the three site pages that play
video, by the dashboard from `SITE` when a preview opens a video, and by
the worker's share pages from `SITE_URL`, so there is one copy of it. A
video item carries `sizes` (`scsVideo.sizes(heights, url)`: each height
the encoder made, largest first, then Original), and every player — the
lightbox's `.lb-size` menu, the dashboard preview's `.preview-size`,
the share page's `.ph-size` and the gallery slideshow's Video quality —
offers **Auto**, each size and Original. Auto is the default: it starts
at the largest copy, or lower when the browser reports Data Saver or a
2G/3G connection, or at the size the last video this visit settled on
(sessionStorage `scs2-video-auto`); it moves down a copy when nothing
has shown six seconds after being asked to play or playback keeps
stopping to load (one wait over 2.5s, or 3.5s of waiting in 30s), and
up one when the download has stayed 20 seconds and three times real
time ahead, or the file is down whole, with no wait for 12 seconds; a
step up that stalls within 15 seconds is stepped back and not tried
again for that video. A change of copy keeps the place and carries on
playing. These are whole MP4 copies, so a change reloads from that
point rather than switching seamlessly as segmented streaming would;
that would need the encoder to cut every video into segments. A pick
from the menu is kept on the device (localStorage `scs2-video-size`,
which reads the gallery's old `scs2-gallery-res` once), and Original
that the browser cannot play (some phones film in HEVC) falls back to
Auto with a toast. `res` only knows 480, 720 and 1080, so a copy under
480 is asked for as 480 and served as the largest below it. A list
carries the heights: `media[].renditions` (`attachMedia`) for proof
and `heights` on an album listing's videos (`heightsFor`, one
`json_each` query). **A shared video opens on a page with the player**
(`GET /view/<key>/<name>`, `viewPage` in albums.ts): any proof or album
file opened by its key, which is the same capability as the file
routes, once it has all arrived and, for a video, once the encoder has
finished; 404 otherwise. It draws what `/photo/` draws (`mediaPage`,
shared by both): the photo, or the video in the player with Auto and
the menu (the largest copy without the script), the credit, a Download
link and Open Graph tags with `og:video` at the largest copy, under a
header carrying the logo (from the site, on a white square as the dark
theme's bar draws it) and "SCS.2 Legends of the City". The page is
always dark, and set in the site's stack with the stand-in for
Helvetica fetched from `SITE_URL` (`fontFaces`; written up in
`website/assets/CLAUDE.md`). **The picture's width comes from the screen's height**
(`.ph-fig`, the `--ar` the file reports), so a tall video on a phone can
be narrower than the row of buttons under it; the figure takes
`min-width: min-content` so it is never narrower than that row, and
`.ph` has one `minmax(0, 1fr)` column so the figure is centred on the
page's width whatever is in it. Without them the row widened the
picture out of its box on the right while the box stayed centred, which
on an iPhone put the video off to one side. A file sent for a quest gets a button (the quest list's
pin) opening the
quest as the quest list's sheet draws it, in the dark theme and without
its actions: the region's line along the top, the black head with the
region's disc and the name, the description, the flavour line, Where,
and its codes and points; on a phone it rises from the foot with a grab
bar that drags it away and no cross, and the rest of it drags too when
pulled down from its top. **A swipe on it never reaches the page
behind**: Safari hands a swipe on a sheet with nothing to scroll to the
scroller underneath, so the page scrolled under an open sheet. Each
touch decides on its first move — drag the sheet, let the sheet scroll
itself, or hold the move back — and `body.qs-open` takes `.ph`'s
scrolling away while it is open; 931px and wider it is the quest
list's centred box, a stop larger, with no slide; with a mouse the cross
shows at any width; a tap on the dim or Escape closes it anywhere (`questPanel`; `publicQuest` carries the region's colour) —
**only while the public quest list shows the quest**:
`publicQuest` in quests.ts is built from `questListPayload(db, null)`,
so a quest kept from the public, a hidden code and a mystery quest's
points (???) stay kept here too. `verify-albums.mjs` holds it.
**Who sent it** is the name under the picture with an icon before it (`.ph-by`, read
out as "Sent by" or "Sent by team"): one person for a name typed into an
open album (`by: 'person'`, an upload with no team), two for a team, so a
typed name is not taken for the photo's title.
**Every public file address answers a person with that page** (all of
it is `src/sharepage.ts` now: the shell, the quest sheet, `mediaPage`,
`viewedFile`, `heightsFor`). `wantsPage(request, url)` says when: a
browser navigating there (`Sec-Fetch-Dest: document`, or an `Accept`
asking for HTML where a browser sends no `Sec-Fetch-Dest`). A link
preview (`isLinkPreview`), an `<img>` or `<video>` on a page, a fetch, a
Range, `download=1` and `raw=1` all get the file as before, so a link
pasted into Discord still embeds as the picture while the same link
opened in a browser shows the page. Both answers carry `Vary:
Sec-Fetch-Dest` (`VARY`), or a browser that had cached the picture
would hand it back for the page. **A photo or a video is a page only at
its named address** (`wantsPage(request, url, {named, media})`: the
path ending in the file's name, which is what Copy link, Share and the
Discord posts hand out). The `?key=` addresses the site's viewers show
always answer the file. A browser saving a picture it has on screen —
"Save image as", "Download image" — asks for it again with the headers
it opens a page with, and the Vary above stops it reusing the copy it
has, so every photo saved from a viewer came down as the page's HTML
under a `.jpg` name. For the same reason the page's own picture, its
full-size copy and its video are asked for with `raw=1`. A PDF or any
other file is still a page at either address, since that is how a quest
or message attachment opens from the site. The routes: a drop file and a short
link to one (`serveDropFile`), a message's attachment, a quest's file
(with the quest's code and its sheet while the public can see the
quest; quest files also answer at `/api/quests/file/qst/<key>/<name>`
now, since the page names every file by a path ending in its name),
and proof and album files (the `/view/` page, through `viewedFile`).
Such a file is shown as that address serves it, `item.base` being the
path: a photo whole, a video as sent, **a PDF drawn page by page** with
the site's copy of PDF.js (`website/assets/pdfjs/`, 4.10.38, the ES
module build with its worker, loaded from `SITE_URL` as a module, so
Netlify sends it with an open CORS header and a JavaScript type —
`netlify.toml`; the worker is started from a blob that imports it, as
a worker cannot be started from another origin; `isEvalSupported:
false`). **Nothing waits on anything else to start downloading**: the
page's head preconnects to the site, module-preloads `pdf.min.mjs` and
preloads the PDF itself (`as="fetch"`, `crossorigin="anonymous"`, the
same request PDF.js then makes, so it is taken from the preload), and the
script starts the worker before it imports the library. They used to
run one after another: the library, then the worker, then the file.
Netlify keeps `assets/pdfjs/` in the browser for a year, so a new
version goes up under a new folder name. **A download that fails is tried
again** (`boot`/`again` in the page's script): the library, the worker
or the file failing starts the load over after 0.4s, then 0.8, 1.6, 3.2,
6.4 and 8, the note reading "Trying again…"; after seven tries the page
says it could not be shown, with a Try again button, and starts over by
itself when the phone comes back online. What has arrived is kept (the
library is not imported twice), and a module that failed is asked for
with `?r=N`, since a browser may keep a module's failure. The worker's
`error` event is what says its script did not arrive: without a listener
PDF.js waited on it for ever, so one failed request left the page on
"Loading…". A page that fails to draw (a range request dropped part way
through the file) is drawn again on the same delays while it is near the
screen (`h.near`, `h.tries`); it used to stay blank until scrolled away
and back. **The other file pages do the same** (`LOAD_SCRIPT`, first
in every file page): `phNeed(src, then)` loads a script from the site and
asks again on the same delays when it does not arrive, under `?r=N`, and
`phKeep(el)` does it for the page's picture or a video with no player of
its own. The photo viewer, the video player and the details rows are
loaded through `phNeed` rather than a script tag, which was tried once;
a video plays from its own address until the player's script arrives and
then carries on from where it was. The whole picture behind a photo's
viewing copy and the details sheet's rows are each asked for again four
times. **It reads like a PDF viewer**: one bar across the top
(`.ph-bar`, 61px) with the site's mark, the file's name (one line with
an ellipsis, two on a phone, where "PDF · size" is left out), Open (the
file with `raw=1` in the browser's own viewer, which can search the
whole file), Download and Share, icons alone on a phone. **It is the
only chrome above the pages**: a PDF is a tall page and the site's own
header row over a two-row caption pushed the first page down by about
185px on a phone, so the PDF page has no `.ph-top` and its bar carries
the mark. The bar lies over the pages (`--bar-h`, measured, is the
view's top padding), and on a phone or a tablet (`(max-width: 760px),
(pointer: coarse)`) it slides away after 24px of scrolling down and
back after 24px up, at the top, or when something in it takes the
focus; a page jumped to sits at the top with the bar away, page 1 under
the bar. The pages scroll in a box of their own (`.ph-view`, both ways
once zoomed past the screen); and floating over the foot of the pages
(`.ph-tools`, the toast's black with a hard shadow, since it is off the
page) the page box ("Page [3] / 26": it follows the scroll, and a
number typed and Enter goes there), zoom out, the zoom menu (Fit width,
Fit page, 25% to 400%, where 100% is the page at 96 pixels an inch) and
zoom in, and full screen. A page opens at 100%, or fitted to the width
where that is narrower (`auto`, which follows a resize); Ctrl or Cmd
with + - 0 step through the menu's scales. **A pinch zooms the pages,
not the page**, to any scale from 25% to 400%: two fingers on the pages,
or a trackpad,
which sends the wheel with Ctrl held, as Ctrl and a mouse wheel do a
notch at a time. While it lasts `.ph-pdf` is only scaled with a
transform about the point between the fingers and moved with them;
on letting go (or 200ms after the last wheel event) the pages are laid
out at that scale and the point of the page that was between the
fingers is put back under them. A scale between the menu's own shows
as an option of its own at the top of the menu ("106%",
`[data-pinch]`), gone again when a menu scale is picked. **The
browser's own zoom is off the whole PDF page**, the bar and the
controls as well as the pages: `html.is-reader` (`sharePageHtml`'s
class, the PDF page only) is `touch-action: pan-x pan-y`, after
`manipulation` for a browser that knows only that, and Safari's
`gesturestart` is refused anywhere on it. Quick taps on zoom in had
been read as the browser's double tap and zoomed the page itself. A
**double tap on the pages** is the PDF's instead: twice the fitted size
about the tap (90% on a phone), and back to fitted from there or any
closer, in 250ms through the pinch's own transform; on a link it is a
tap on the link. The photo and video pages keep the browser's zoom,
which a photo's page reads to fetch the whole picture. The page being
read, a third of the way down the view, stays in place through any
other zoom. **Full screen is the
whole document**, not the reader, so the quest's and details' sheets
and the toast still show over it. It is offered only where the browser has full screen for a page, which
an iPhone does not. Each page is a white sheet holding a canvas, drawn
when it comes within 1200px of the view at the device's pixel ratio
(at most ten million pixels a canvas, however far it is zoomed) and let
go again when it leaves, so a long file does not hold every page in
memory; after a zoom the canvases drawn at the old size are drawn again
150ms after it settles, the old picture stretched over the gap. **The
text can be selected and copied**: PDF.js's `TextLayer` lays each page's
text over its canvas as transparent spans (the `.textLayer` rules are
PDF.js's own, copied into the page, since its viewer's stylesheet is
not vendored). The spans are sized by `--scale-factor`, the page's width
on screen over its width in points, set on the page, so a zoom moves
the text with no new layout. **A PDF's links work**: each page's `Link`
annotations (`page.getAnnotations`) become real `<a>`s in `.ph-links`
over the text layer, placed in shares of the page so a zoom carries
them. A web address is taken only from PDF.js's own checked `url`
(never `unsafeUrl`) and only as http, https, mailto or tel; http and
https open in a new tab with `noopener noreferrer`, since this page's
address holds the file's key and a Referer would hand it to the other
site. A place in the document (a named destination or `[page, how,
…]`, read through `getDestination` and `getPageIndex`) scrolls there,
16px below the bar, or below the top where the bar tucks; XYZ and FitH
say how far down the page. The page box is 16px on a touch screen,
or a phone's browser zooms in to type in it. If PDF.js cannot load or
read the file the page says so and the bar's buttons are still there.
`verify-gallery.cjs` draws a made-up PDF through the site's copy of
PDF.js, selects a page's text, follows a page link, types a page
number and zooms, and checks the web link is on top of its words. Anything else (a GPX, a document) is a card with its name,
its kind and size, and Download. `verify-drop.mjs` holds which
requests get which. The
home page's slideshow opens its photos this way (`website/assets/CLAUDE.md`). Layers, bottom up: `.lb-frame` (2),
then `.lb-bar` and `.lb-top` (4). **There is no bar across the top and
nothing beside the photo**, as in Discord's viewer:
`.lb-bar` is the file name and "2 / 4" floating top left in white, and
`.lb-top` the close button floating top right — a square in the sign's
black, laid over everything so a zoomed photo never covers it. **The
viewer carries no message**: it used to hang the message (or a
gallery tile's note) under the photo as a draggable sheet, and down the
side as a panel on a computer; the text is on the page behind it. The backdrop is an opaque
near-black (`#0b0d0f`), so the page does not show through at the top.
**The photo's area is `.lb-frame`**: fixed, the whole screen, padding
`--lb-bar-h` (64px, 60 + the safe area in the app layout) top and
bottom so the photo clears the controls; `pointer-events: none` on the
area, `auto` on the media, so a tap beside the photo reaches the
backdrop and closes. `.is-dragging` turns its transition off while a
finger has it. The name and the button slide in from above on open
(`lb-bar-in`) and off on close (`.is-leaving`), and **follow a swipe
on the photo** (`pullChrome`: they lift 0.6× the drag and come back
with the frame on a short release; `.is-chrome-dragging` kills their
transitions meanwhile). A zoomed photo fades the name out (`setZoomed`,
`is-zoomed` on the overlay from `apply()`). **One tap on the photo**
(`setImmersive`, fired 330ms after a tap that no second tap followed —
a double tap clears the timer) adds `.is-immersive`: the backdrop goes
solid black, the name, button and arrows leave, the frame takes the
whole screen with no padding and the media is `width/height: 100%;
object-fit: contain`, edge to edge; another tap brings it all back,
and a swipe still dismisses the lot (no morph back from there).
Backdrop taps close, taps on the button do not.
**What the reader points with decides the gestures** (`mouse =
!handheld()`, class `is-mouse`): a mouse gets no tap-for-a-black-screen
and no swipe to dismiss — one click zooms in where it landed and the
next zooms back out, with no wait to find out whether a second click is
coming, and dragging a photo that is not zoomed does nothing (dragging
a zoomed one still pans). `+`/`-`/`0` zoom from the keyboard on any
device (`zoomApi`, re-armed per slide by `armZoom`, null on a video).
The dashboard has its own `openPreview`. Grids load `thumbUrl`; taps open
the full file in the lightbox, never a new tab. `attachMedia` (exported) is the one query that
hangs `media: [{key, type, bytes, name}]` on a list of submissions —
**the ids go in as one JSON list** (`IN (SELECT value FROM
json_each(?1))`), as do the message attachments and the review list's
quest codes: D1 takes at most 100 bound parameters a statement, the
review list asks for 200 rows and the gallery for 300, and a parameter
per row answered 500 past a hundred submissions. `tests/d1-shim.mjs`
refuses more than 100 the same way, since plain sqlite takes thousands;
the console Review tab, `mine` and the gallery all use it. Console
previews are media tags, which cannot send the session header — the
page mirrors the session into an `scs_console` cookie scoped to
`/api/console/file` and the worker accepts it for the file action
only. Files serve session-free at `GET /api/submit/file?key=` — the
96-bit random half of the R2 key is the capability, keys must exist in
`submission_files`, responses immutable-cached. Gallery flag
(`gallery`) plus *accepted* status puts proof on `/gallery/` via
`GET /api/submit/gallery` — **signed in only** (a team's submit
session or a dashboard session, `organiserSession`), `private,
no-store`, since the listing is what hands out the file keys; the
files stay open on their keys so a shared link still works.
Half-uploaded files are filtered out, and so is a submission left with
no photo or video to show (it used to be listed empty, and a gallery of
nothing but those said it could not load). **It is the newest 300
submissions** (`GALLERY_MOST`) and answers `more: true` when there are
older ones; the page's line then ends "Showing the newest N
submissions." `mine` is the same at 100 (`MINE_MOST`, "Showing the
newest 100." under Already sent). Signed out the page says
`#gal-gate` ("Teams only…") over the submit page's own sign-in card
(`#gal-login`; `.sub-signin` and `.sub-bar-btn` are in site.css for
the two of them). It posts to the same `/api/submit/login` and keeps
the session under the submit page's keys, so signing in on either page
signs in on both, and the gallery loads where you are rather than
sending you to the submit page and back. **The page is the day in hours** (`.gal-hour`, a rule
over the hour and the count): every photo and video is one square tile
(`.gal-tile`), sorted by `submitted_at` read into the device's zone,
four to a row on a wide page and two at phone width. A tile is the
picture with a black plate in its corner carrying the code
(`.gal-quest`, mono) — plus the play glyph on a video, which is the
only way a video differs from a still — over the quest's name and
`HH:MM · team`. An hour shows its first four; its count
(`.gal-all`) opens the rest in place, and an hour with four or fewer
shows no count, because the figure is already in the column under it.
A tap opens `scs.lightbox` on that submission's media. There is no route palette on the
page: a gallery item is a code, a name, a team and a time, so the
stripe cannot be read as a key. **Slideshow**
(`assets/slideshow.js` and `slideshow.css`, `window.scsSlideshow.start(slides)`,
shared by the gallery and the album page; each slide is `{type, alt,
photo(), video(), sizes(), plate()}`, the plate `{code, name, right}`,
so the slideshow knows nothing of where a slide came from; the three glyph buttons
carry `.ss-square` — play and pause are different widths as glyphs, so
a button sized to its content changed width on every press and shoved
the bar sideways): every photo and video
one per screen in a paper frame (`.ss-mat` picture well at
a constant size so slides do not jump, `.ss-plate` black sign with
the code in mono, the quest name and, on the right, the team — the
tile's caption at the size of a projector). The room is `--sign-bg`
rather than a colour of its own and the controls are outlined squares
on it; the settings stay on paper, since paper is what the site reads
and operates on. **No stripe in the overlay** — it is the site's mark
on the nav and the footer and nowhere between, and this layer has
neither. The well's width is what the stage has left after the mat and
the room's margins (`--ss-side`/`--ss-mat` on `.ss-overlay`): sized in
`vw` alone it was wider than the stage and a phone lost the right edge
of the frame. Settings in `scs2-slideshow`:
photo hold, seconds of video shown (counted in played time, not wall
clock), playback speed, sound, and a **Random order** rocker
(`settings.random`, default on; off plays the gallery's listing
order; flipping it mid-show keeps the slide on screen and re-places
it in the new order); Video quality (Auto, 1080p, 720p, 480p,
Original: video-sizes.js's choice, shared with every other player on
the device) rides the same panel; the slide on screen runs through
`scsVideo.play`, so Auto moves down there too, and a photo is its
viewing copy unless the choice is Original. The **next three slides are prepared ahead** (`primeAhead`:
bare `<img>`/`<video preload=auto>` elements built and downloading
while the current slide shows, pooled by slide index so an order
change keeps what is down; `drawSlide` takes the pooled element and
wires listeners/sound/speed at show time, checking `node.error` /
a failed `img.complete` since a file that broke in the pool fires
no second error event; leaving the coming-up window releases a
video's src — buffered video is real memory; a quality change
re-fetches the pooled videos at the new size; `endShow` clears the
pool). Arrows/space/Escape, wake lock (asked for again when the page
comes back into view, since the browser lets it go when hidden),
back-layer aware, unplayable files skip. Only the slide on the stage
moves the show on (`show.node`): a video taken off the stage pauses,
which reports its time once more, and that used to skip the next slide.
`tests/verify-gallery.cjs` covers the pool and the rocker.
**Albums** (`src/albums.ts`, `website/albums/`; tables `albums`,
`album_photos`, `album_skips` and `album_teams`, migration `2026-10-albums.sql`):
photo albums anyone can look at on `/albums/`, made on the dashboard's
Files tab. Each album says who may add to it (`adding`): `teams`, a
team signed in with its submit code (the page shares the submit page's
session, as the gallery does); `anyone`, no sign-in, with the Turnstile
check when its keys are set, a name if they want one, and
so many photos and videos from one address an hour — 40
(`ANYONE_PER_HOUR`) until the Settings tab's Albums card sets
`album_anyone_per_hour`, and one number for every album — counted on a
hash of the address kept in `album_photos.ip`, so everybody behind one
Wi-Fi connection shares it. **A team signed in with its submit code
skips the check and the count** (the page sends its session with every
upload): its rows keep no address, so it uses up none of the number
for the people around it, and it is still handed the pass, so the page
sends its pick side by side and an upload whose sign-in runs out part
way carries on. It used to be counted like anyone else, which turned
signed-in teams away with the rest of the room; or `closed`, organisers
only, from the dashboard. Photos and videos: JPEG, PNG and GIF checked
by their bytes, and any `video/*`; the page and the dashboard turn
HEIC and WebP into JPEG first, keeping their EXIF. The worker takes up to ten to a request and 25MB each sent
whole; **anything over 25MB (to 4GB, as for proof) is named in the
upload's `bigfiles` and its bytes follow in slices**, a photo sent that way checked by its
first bytes when its last slice lands and dropped if they are not a
photo's. A photo over the 32MB the worker will read whole has its
metadata block read the first time it is asked for (above). The upload answers `uploads: [{file, token,
part_size}]`, and `PUT /api/album/upload/part?file=&token=&n=`, `POST
/api/album/upload/finish` and `/abort` take that token as their whole
credential (`album_photos.upload_token`, slices in
`album_upload_parts`), so an open album's slices need no session and
the dashboard sends its own the same way. As with proof files, the flip
to ready and the abort each land only on a row still uploading, a late
slice is refused, and a finish replacing a photo takes the token before
its swap, so a second finish of the same upload answers done rather
than swapping again. **The page and the dashboard
send one file to a request**, each with a row of its own (its small
copy, its name, Waiting / Preparing / Sending n% / Added or what went
wrong with Try again, and a bar driven by the request's upload
progress, slices included): two at a time on the page, one at a time on
the dashboard, a photo decoded only when its turn comes. Batches of ten
and 60MB were how it started, and on a phone a pick of a dozen 12MP
photos decoded all of them at once and sent them as one request that
either all went in or all failed, with one line of status for the lot.
A failed file is left in the list and the rest carry on. **The person
check covers a pick, not a file**: a Turnstile token is good for one
request, so the upload that passes it is answered a `pass`
(`<expiry>.<HMAC-SHA256 with TURNSTILE_SECRET over the album id, the
address hash and the expiry>`, `PASS_MINUTES` 30), which the page sends
in place of the token for the rest; it is good for that album from that
address only, and the hourly limit still counts every file. Until it
has one the page sends one file at a time. An upload from a hidden team
is answered `hidden_team: true` and the page says what it adds is for
organisers only, since the public album leaves it out. Uploads go in the proof bucket under `alb/` the way
proof does under `sub/`: the original and its metadata block (`.x`), the
file a photo was picked as (`.p`, above), and the small and viewing copies the browser makes
(`.t`, `.v`), sent as `thumb<j>` and `view<j>` like the submit page's,
with the width and height it measured (`w<j>`, `h<j>`; `album_photos.
width`/`height`), which is what lets the page lay a tile out before it
has loaded. **An organiser can replace a photo in place**: the
dashboard's "Replace photos with the same name" tick box sends `replace=1`
with every file (organisers only: `organiserUpload` passes it to
`storePhotos`, a team's or anyone's upload never does). `replaceTarget`
looks for a photo in that album with the same name, ignoring case;
failing that, a JPEG looks for a PNG with its name but for the ending.
**Names may repeat**, so more than one photo can answer: then nothing is
stored and the upload is answered 409 with them (`choose`, each with its
key, who added it and when, when it was taken, its size in pixels and
bytes; `candidates`), settled for every file in the request before any
is stored. The dashboard's upload row shows them as tiles (Replace this
one), with Add it as a new photo and Skip it, and the queue carries on
with the next file meanwhile; a pick sends the file again with
`replace_key`, which names the photo outright (404 when it is no longer
in the album, 400 with more than one file in the request). A photo sent
whole goes in under the old key at once (`replaceInPlace`). **One sent
in slices** (over 25MB, or every photo when uploads go straight to R2)
arrives the way any large upload does, under a key and row of its own,
the row's `replaces` holding the photo's id, and **only at finish, once
its first bytes have been checked, is it copied onto the photo's key**
(`swapIn`): a file that is not a photo is refused and dropped with the
photo untouched, and until then the old photo is what is served. The
copy is `copyStored`: R2's own CopyObject (`directCopy`) where the
worker has the R2 secrets, else the object streamed through the worker.
The upload's small and viewing copies follow it, then its row and key
go. A photo deleted while its replacement was arriving leaves the
upload as a photo of its own. Either way the share id and every link
keep working; `.x`, `.t`, `.v` and `.c` go and are made again from the
new file, and the row takes the new type, size, name, width, height and
`taken_at`, so the details and the Date taken order follow the new
file. **A JPEG replacing a PNG keeps the PNG**: it is copied to `.p`
first and `picked_type` says `image/png`, so it is downloaded raw as it
was sent, beside the JPEG, under the album's details rule like a HEIC
(the album page and the dashboard say Download JPEG and Download PNG); a
same-name replacement keeps whatever `.p` the photo had.
`album_photos.version` and `replaces` (migration
`2026-10-album-replace.sql`): the version counts the replacements, the
listing, `/photo/` and `/view/` carry it as `ver`, and the album page
and the dashboard put `&v=<ver>` on every address of the file and the
share page names it `photo-<ver>.jpg`, because every copy is served
`immutable` and a browser or the service worker holding the old one
would otherwise keep showing it. A link copied before the replacement
still opens the photo; a browser that already holds that exact address
keeps its old copy, and the share page is cached for five minutes.
`verify-albums.mjs` covers both ways in through the worker, the details
and the links after a replacement with the old cut kept at the edge,
and the pick; `verify-direct.mjs` the copies inside R2.
**A photo pointed at another** (`album_photos.points_to`, migration
`2026-10-album-point.sql`): a duplicate an organiser has pointed at
another of the album's own uploads. The public listing leaves it out
(`itemsSql`; every fallback tier is tried with the column and then
without it, so a database missing some other table still leaves it
out), and every address it had answers a 302 to the photo it points to,
not kept and with open CORS: the share link `/photo/<id>`, the file by
key and by name with every copy and `download`/`orig`/`picked` asked
for (`pointedFile`: the key swapped and the target's `v`, and a share
page's `photo-<ver>.jpg` renamed for the target's version), `/view/`
and `/api/albums/info`. So a link already posted lands on the photo that
stays; a browser or a chat app that already holds the old picture keeps
it, since the file was served `immutable`. The file route reads the row
and where it points in one query (`ownRow`). **One hop**: console
`album/photo/point {id, key, to}` (logged `album-photo-point`) moves
anything already pointing at the photo to where it now points, and a
target that itself points elsewhere passes on where it points, so
following one redirect always ends on a photo in the album. The write
asks again that the photo pointed at points nowhere itself, so two
photos pointed at each other at the same moment cannot both land and
hide each other; the second is a 409. Refused:
pointing a photo at itself (400), into a loop (409), or at anything but
an upload in the same album (404); a gallery file cannot point or be
pointed at. `to: ''` undoes it (`album-photo-unpoint`), and deleting
the photo pointed to clears every pointer to it (`dropPhoto`), so what
pointed there comes back into the album. On the dashboard each upload
has Point to; it marks the photo, a bar says to click the photo it
should point to (Cancel), and a click on another upload sets it. A
pointing photo is dimmed with "Points to <name>" and Undo. Covered in
`verify-albums.mjs` (every address, one hop, the refusals, Undo and
delete) and `verify-console-direct.cjs` (the dashboard against the real
worker). **Whose photos** (`whoFilter`, `filterOf`, `albumPeople`): a
photo's person is what the page credits it to, the team or else the name
typed (`WHO`, '' for neither), matched in any case through SQLite's
`LOWER`, both sides, so a name with letters it does not fold still
matches as typed. `GET /api/album` takes `by` and `not`, each repeated,
up to 50 names: only those people's photos, everyone's but theirs, or
both. The filter sits in the outer query of the page and of the count,
so `count`, `videos` and `next` are of what it lets through, and the
edge cache keys the read by the whole query as before. The first page
also answers `people`, everyone the album credits whatever the filter,
most photos first, with how many each; one name typed in different
cases is one person under its newest spelling (a window function, at
most 200 names); `filter` echoes the names when one is in effect. The
page (`website/albums/albums.js`) shows a people button in the tools
row once an album credits two people or more, opening a drawer like the
add drawer (the two share `.alb-drawer`, one open at a time): Show only /
Leave out, a chip per person with their count (a picked chip in the sign
black), a Find a name box past twelve people, Share link (the phone's
share sheet, else the clipboard) and Clear. Each tap reads the album
again after a quarter second, the grid dimmed meanwhile, and the
address follows by `replaceState`, so the link shared is the filter;
the address is read at load (`by` wins when both are there). The names
in effect also show under the counts, each with a cross that takes it
off. On a phone the tools row goes to two rows, the two switches above
and the buttons under them on the right. The slideshow takes the
filter too. **Who added them, several at once** (console
`album/photos/author {id, keys, team_id | name}`, `setAuthor`, logged
`album-author` with the count and the name): a team sets `team_id` and
clears `added_by`, a name (60 characters, empty for none) clears
`team_id`. The album's own uploads only, at most 500, all or none: a
gallery file is refused (400, it is its team's), one not in the album
is a 409, a team that is not there a 404. The Files tab's album grid has
**Change who added them**: a click then picks one of the album's own
uploads, Pick all picks the lot, and the bar's select (the teams, then
A name with the names already in the album offered, or No name) and Set
send it; Done goes back. `verify-albums.mjs` covers the filter, the
people and the author refusals, `verify-gallery.cjs` that the page and
the worker agree on the parameters, and `verify-console-direct.cjs` the
grid's pick and Set against the real worker. **Album videos go through the proof videos' encoder**: the
queue covers `album_photos` as well as `submission_files` (proof first;
the key's prefix says which table a file is in, and both carry the same
`status` and `encode_*` columns), its copies land in
`submission_renditions` keyed by the `alb/` key, and the clean copy at
`<key>.c` like any other. Until the encoder has finished one, gallery
videos included, the public read lists it as `processing` with no
`share` id (`stillProcessing`), and **the page plays it as it was sent**
(`uploaded=1`, the team gallery's way, **Videos the encoder has not
reached**, below): the tile keeps its play mark, the viewer plays it
with no size menu, Share or Download, the slideshow takes it, and the
still stands in where the browser cannot play the file (HEVC in
Firefox), with "Video is processing. Check back soon." With no still
yet, the tile draws its frame from the file as sent (`frameFor`). A
file still arriving in slices is left out. The dashboard shows each one's state (still
uploading, waiting for the encoder, encoding, or what the encoder could
not use). `GET /api/albums/file?key=alb/…` serves a video as it was
sent, its metadata boxes blanked, for `uploaded=1` (a file
`serveUploadedVideo` cannot read falls through); `.t` for `thumb=1`;
for `res`, a video's copy at that height (falling back the way the
proof endpoint does) or a photo's `.v`; and otherwise the photo cut as it is served, or a video's clean copy —
never the original, except `orig=1` in an album that shows details
(below). Deleting an upload deletes its copies and its
renditions. **The page is a waterfall or rows**, by a two-icon switch
on the right of the order's (kept per device, localStorage
`scs2-album-view`). **The head of an album** reads top down: the
album's own words, what it holds as
an icon, a figure and its word in the label voice (`#alb-counts`, as a
stat card pairs them; the status line only speaks while loading or
failing), then the two switches and the add button. (A back link to every
album, `#alb-back`, is in the markup and never shown, at the
organisers' asking.) Each switch is one hairline box
(`.alb-seg`) with a block of the sign's black under the choice in use
that travels to the new one on the O/I switch's clock (`placeSeg` sets
`--seg-x` and `--seg-w` from the button; the first placing has no
travel); the order keeps its words, with a clock and a calendar beside
them above 560px, and the layout is a waterfall and a rows drawing with
their names as labels. **Adding sits behind one button**: a photo-add
mark at the right of the switches (`#alb-add-btn`, the switches'
height, solid black while open, `aria-expanded`), which opens
`#alb-add` under it — the row grows from nothing on `grid-template-rows`
and the card drops into place, under the button on a wide screen and
the width of the page on a phone; Escape closes it and `inert` keeps a
closed one out of the tab order. An empty album opens it from the
start, since there is nothing else to look at. Inside is one card
(`.alb-picker.card`): the name where the album asks for one, the green
button with an add-photo icon, and with a mouse "or drop them here" —
files dragged anywhere over an album open it and warm the card with
`--glow-fill`/`--glow-edge` (`is-dropping`), and dropping them anywhere
adds them. A team album's sign-in card sits in the same place. Turnstile
renders with `appearance: 'interaction-only'` when the album loads,
whether or not the drawer is open, so its token is ready by the time
anyone presses Add and the check takes no room unless it needs a
click. The waterfall is columns, two to five by the width,
each picture at its own shape going into the shortest column, newest
first. Rows are Google Photos' layout: every picture in a row is one
height and keeps its shape, and a row ends where it fills the width
nearest the height rows aim for (a third of the width, between 110 and
220px); the CSS grows each picture by its width over its height
(`--wide`), so a full row is exactly the page's width with no
measuring, and the row still being filled sits at the aim
(`--row-h`) unstretched. A resize regroups the rows, as it rebuilds the
columns. A shape the list does not carry (a gallery photo) is read
off the small copy before the tile is placed, so nothing moves once it
is on screen, and tiles are laid out 24 at a time as the end of them
comes near. **A tile holds its picture only while it is near the
screen** (`scs.keepPicture(img, url, { letGo: true })`, the site's
pictures-that-come-back helper in website/assets/CLAUDE.md), so a long
album holds a few screens of pictures rather than all of them, and a
picture that fails is asked for again rather than taken out of the tile
for good, which on an iPhone coming back to Safari left the album grey
until it was reloaded. The tiles no longer ask for `decoding: async`. **No shape is waited on for more than three seconds**
(`SHAPE_WAIT`; the tile is then square): a batch is laid out only once
every shape in it is known, and a small copy that never answered held
the whole album back with nothing on screen — on an iPhone set to Date
taken, where the photos the list gives no size for came first, the
album looked empty until the order was switched back. **The album comes a page at a time**: `GET
/api/album?a=&order=added|taken&from=&n=` (n up to 200; without it,
every item up to `LIST_MAX`) answers that page with `count`, `videos`
and `next`, where the next page starts or null. Both sources — the
album's own uploads and the gallery — are one `UNION ALL` (`itemsSql`)
that the database filters, orders and pages, so a read costs the page
rather than the album; the page asks for 60 at a time as the laid-out
tiles run out, skipping a key it already has, since an upload while it
reads moves the pages along by one. **The foot of the album**
(`.alb-more`, `paintFoot`) says which: a thin bar running while a page
is on its way or tiles are still to be laid out (`role="progressbar"`),
and once everything has come, how many photos and videos the album
holds, in the words the line under its name uses; a page that could not
be fetched says so with Try again. **Until the first answer** grey
shapes stand where the albums or the pictures will land (`#alb-skel`,
in the markup so they show before any script runs: album cards on the
list, columns or rows on an album as this device shows them, which the
inline script under it picks), pulsing one after another. The line
reads Still loading after six seconds, and a read that failed offers
Try again (`#alb-retry`) and is tried again by itself when the phone is
back online or the page is shown again (`online`, `visibilitychange`,
`pageshow`); the reads themselves give up on a try with no answer and
ask again (`scs.fetch`, `website/assets/CLAUDE.md`). `verify-gallery.cjs`
scrolls an album to its foot. `/api/albums` takes each album's
count and cover from the same union with a `COUNT` and a `LIMIT 1`, and
the dashboard's list its counts the same way. **Both public reads are
kept at the edge for a minute** (`keptRead`) under
`/__albums/<n>/<path>?<query>`, where `n` is the `albums` counter:
an album saved, deleted or edited on the dashboard, an upload, a
finished slice upload, a video the encoder finished and a time read by
the tidy all move it on (`albumsMoved`), so those show at once. The
gallery's own changes — a submission accepted or a team hidden — show
when the minute runs out. The answer to the browser is still
`no-store`. The counter is read on its own and is not one of the
pulse's `COUNTERS`. **An album can show
the gallery** (`albums.gallery`): accepted submissions whose team
ticked the gallery box, read live by the union, so
one accepted later appears with nothing copied, its files going out on
the proof endpoint's own keys. That makes those photos public, which
the team-only `/gallery/` never did, and the submit page's gallery
switch does not say so. **Or some teams' part of it** (`album_teams`,
migration `2026-10-album-teams.sql`): with the whole gallery off, an
album shows the gallery submissions of the teams picked for it, read
live the same way, so one a picked team gets accepted later appears with
nothing copied. `itemsSql`, `detailsHolder` and `sharedPhoto` ask the
same question (`teamPicked`, `showsGallery`), so the album's list, its
count and cover, the dashboard's count, the original where the album
shows details and `/photo/` all agree on what is in it. The album form
lists every team under "Gallery photos from these teams" while "Include
the whole gallery" is off, the ones with photos in the gallery first
with how many (`teams` on `GET albums`, one grouped query, a hidden team
marked), and the albums list says "with gallery photos from" the team or
how many. `albums/save` takes `teams`, a list of team ids, and replaces
the album's list with it; an edit that does not send it keeps what the
album had, as `details` does. Deleting an album or a team deletes its
rows (`forgetTeam`, called from `deleteTeam`).
**A merged album** (`albums.merges`, a JSON list of album ids, '' for
none, migration `2026-10-album-merges.sql`; "Merge in these albums" on
the album form) shows the albums ticked as well as its own: their
uploads, and their part of the gallery — all of it where one of them
shows the whole gallery, the teams they picked otherwise, a hidden
team's where one of them shows those. It is how the committee puts every
photo in one slideshow. `itemsSql` takes the list as `?5` and asks it in
the same union, so nothing is copied and an upload to a source album
shows at once; a gallery file taken out of the merged album or of any
source is left out. **One level**: the form lists only albums with no
merges of their own, and `setMerges` keeps only albums that exist, are
not the album itself and merge nothing, so a merged album cannot be
merged into another; and an album already merged into another merges
nothing itself, so it cannot become a merged album under one either.
Both are asked in the one UPDATE that writes the list, so two saves at
once cannot nest them. **It takes any visibility**, on the list, at its
link or organisers only, like any album. `sharedPhoto` and
`detailsHolder` know nothing of merges and ask for the photo's own
album: a photo from a hidden source album is listed with no share id,
since `/photo/` would not show it, and its original goes out only where
its own album shows details. On the dashboard an upload from a
source carries `via` (the source's name), shows "From <name>" and has no
buttons there, since it is the source's to change, and the worker
refuses a remove or a point for a photo not in the album anyway.
Deleting an album takes it out of every list it was in. **Opening a hidden album on the site** (`GET
/api/console/album/pass?id=`, Files tab, `albumPass`): a hidden album's
link cell has **Open**, which asks for a pass and opens
`/albums/?pass=<id>.<expiry>.<signature>`, an HMAC-SHA256 of
`album-view:<id>:<expiry>` under `CONSOLE_PASSWORD`, good for a day
(`VIEW_HOURS`); a new password ends every pass. `GET /api/album?pass=`
answers that album whoever can see it, with `adding` closed, no
Turnstile and no share ids, so nothing is added or shared through it.
**The album page's Slideshow** (`#alb-show`, beside the add button, on
any album with something in it) reads the whole album in the order on
screen, page by page from `next`, leaves out a video still being
encoded, and starts the shared slideshow: a gallery photo's plate is its
code and quest name, an upload's the album it came from (`via`) or the
album's own name, and the team or the name of whoever added it on the
right. `verify-albums.mjs` covers the merges, the one level, the pass
and its refusals.
**The whole album as a ZIP** (`src/zip.ts`; `albumZipLinks`,
`serveAlbumZip` and `zipItems` in albums.ts; the album row's
**Download**, Files tab). `GET /api/console/album/zip?id=` (Files, logged
`album-zip`) splits what the album shows (the public read's items, a
video the encoder has not finished included, anything still uploading
not) into parts of at most `ZIP_FILES` (300) files and about `ZIP_BYTES`
(2GB) by the rows' `bytes`, the oldest first so a later upload lands in
the last part, and answers a link to each:
`/api/albums/zip/<slug>[-part-N-of-M].zip?pass=<id>.<expiry>.<sig>&part=N`,
an HMAC-SHA256 of `album-zip:<id>:<expiry>` under `CONSOLE_PASSWORD`,
good for `ZIP_HOURS` (6). A download is an address the browser fetches,
so it cannot carry the session; the link is made on the request's own
origin so the page's `<a download>` is same-origin. The route works the
parts out again, heads each file of its part eight at a time for the
real size (a file gone since is left out), and streams a STORE archive
(`zipStream`): each file read from R2 once and passed straight on, its
CRC-32 worked out as it passes (slicing by eight, about 1GB a second, so
CPU is about a second a gigabyte), a data descriptor after it, ZIP64 only
where a size or an offset needs it, UTF-8 names (`zipNames`: no folders
or characters a file system refuses, " (2)" for a second of a name, the
type's extension added by `fileNameFor`), and the DOS time in Sydney with
the exact moment in the 0x5455 field, from when it was taken or else
added. The length is known before the first byte, so the answer goes
through a `FixedLengthStream` with a `content-length`, and a file that
fails or changes size mid-stream errors the stream, which the browser
shows as a failed download rather than a short archive. The files are
the originals as stored, location and all, which is why the link is the
dashboard's and short-lived. One part is about 600 subrequests (a head
and a get a file) and one request, against a few hundred requests for
the same files one at a time. On the dashboard one part starts at once
and stays as a link; several are a link each, since a browser holds back
a run of automatic downloads. `verify-albums.mjs` reads the archive back
with node's own CRC, and checks the refusals and the parts.
An organiser takes a photo out from the album's
grid on the dashboard: an upload is deleted with its R2 objects, and a
gallery photo goes into `album_skips` for that album alone and can be
put back. A hidden team's photos are left out of the public reads and
shown, marked, on the dashboard, unless the album is set to **show
photos and videos from hidden teams** (`albums.show_hidden`, migration
`2026-10-albums3.sql`, a box on the album form): then that album shows
what such a team uploads and, when it includes the gallery or picks the
team, its gallery submissions, they can be shared from `/photo/`, the
upload is not answered `hidden_team`, and the dashboard counts them as
on the site.
Off is the default. **An album can show photo details**
(`albums.details`, migration `2026-10-album-details.sql`, the box "Show
photo details and location" on the album form, ticked for a new album;
albums made before it are off until an organiser ticks it; an edit that
does not send it keeps what the album had). In such an album the photo
is the original, metadata and all, and so is the HEIC or WebP it was
picked as (`picked=1`, above): `orig=1` on `/api/albums/file`
answers the file as it was sent while `detailsHolder` finds an album
showing details that holds it — the upload's own album, or for a
gallery photo (`sub/` keys, taken on this route only with `orig=1`) an
album with details on that shows the whole gallery or picks the photo's
team and has not skipped it, the album not
hidden and a hidden team's only where the album shows them — and
JPEG, PNG and GIF only, cached `private, max-age=3600` since the switch
can be turned off; anything else asked for that way gets its clean
copy, and a gallery key with no such album is 404. The page loads it
for the full view and the Download button. `GET /api/albums/info?key=`
answers what the photo says about itself under the same rule (404
otherwise): its name, size and dimensions, when it was taken and the
zone the phone wrote (`offset`, left out when it is UTC: software that
saves a PNG or re-saves a photo writes UTC, which says when and not
where, and shown as GMT+00:00 it read eleven hours out beside the
photos around it, so the page shows that time on the device's clock as
it does one with no zone — `localZone`), the camera (make and model, the make
dropped where the model already starts with it), lens, exposure,
aperture, ISO and focal length, the location with its height above sea
level, who added it, when, and a gallery photo's quest — `readExif` on
the `.x` block, the same reader the dashboard's proof panel uses.
**When each photo was taken** is kept for every album upload and proof
file (`taken_at`, UTC; '' when the file does not say, null when nothing
has looked yet): a photo's from its EXIF, the camera's clock moved by
the zone the phone wrote beside it or by Sydney's when it wrote none
(`takenUtc` in strip.ts), and a video's from its movie header's creation
time, which phones write in UTC (`videoTakenAt` in videostrip.ts). It is
written when the file arrives — with the create for a file sent whole
(`recordTaken` after the batch), at finish for slices (`settleArrived`,
`noteTaken`) — and the dashboard's tidy fills in the rest. Where the
album shows details the public listing comes in either order,
`order=taken` putting the newest taken first (one with no time goes by
when it was added), and carries the time itself (`taken`). **An album
not showing details is in the order photos were added whatever is
asked**, and says `order: 'added'`: the order photos were taken in is
one of the details, and a switch that did nothing read as broken.
**Each album opens in an order of its own** (`albums.photo_order`,
migration `2026-10-album-order.sql`; the album form's **Opens in**,
Recently added or Date taken, greyed out while the album does not show
details): a read
that asks for neither order gets it, and the album carries it as
`default_order`. A save that does not send `order` keeps it
(`setPhotoOrder`).
**The page** has an order switch over the grid, Recently added and Date
taken (`#alb-order`, hidden for fewer than two and where the album does
not show details). It asks for no order until this device has picked
one for that album, and takes the one the answer says; a pick is kept
per album (localStorage `scs2-album-order`, `{a=<slug> or k=<key>:
order}`), so one album switched to Date taken does not open every other
album that way. A change of order reads the album again from the first page, and opens every photo
with `whole: true`, so the whole picture replaces the viewing copy as
soon as it has loaded rather than on a zoom; where the album shows
details it passes `info`, and the viewer's Details button
(`.lb-info-btn`, also the I key) opens a panel beside the photo — below
it under 761px — with the date and time, the camera and its settings,
the file, the place with Open in Maps (a Google Maps search for the
coordinates) and who added it. A hidden album is off the list and its
address answers 404, uploads included. The slug is made once from the
first name and kept, so a link already shared survives a rename. **Who
can see an album** is one of three: anyone, from the list; anyone with
the link (`albums.unlisted`), which is `/albums/?k=<link_key>` — a
random key made with the album, because a slug made from a name can be
guessed — so such an album is off the list and its `?a=` address
answers 404, and the page tells search engines not to index it; or
organisers only (`albums.hidden`), not found at either address. The
upload takes `k` in place of `a` the same way.
Deleting an album that has uploads takes its name typed back (428
otherwise). The public routes are `handleAlbumsApi`; the dashboard's
(`GET albums`, `GET album`, `POST albums/save`, `albums/delete`,
`album/photo/remove`, `album/upload`) need the Files tab. Before the
migration the site reads no albums and the dashboard answers 503 saying
to run it. Nothing on the site links to `/albums/`; the dashboard gives
each album's address. **One photo can be shared on its own**: the
public listing gives each photo a `share` id (an upload's random part,
or `g/` and a gallery file's), the viewer's Share button sends
`<PUBLIC_API>/photo/<share>`, and that is a page the worker draws with
the photo and its credit and nothing of the album — no name, no link to
it — so sharing a photo from a link-only album gives nobody the album.
The page carries Open Graph tags (`og:image` at a path ending in its
extension, `/api/albums/file/<key>/photo.jpg?res=1080` for an upload
and the proof endpoint's named path for a gallery file; `og:video` and
a still for a video; `twitter:card summary_large_image`), which is what
makes the link show as the picture when pasted into Discord or another
chat app; Discord runs no scripts, so the tags are written by the
worker rather than the static site. A video there plays in the same
player as a `/view/` page (above). It answers only while the photo can
be seen: a hidden album, a hidden team, a gallery file taken out of
every album that showed it, or a video the encoder has not finished is
404 ("This photo is not shared any more."). Cached five minutes.
`tests/verify-albums.mjs`.
Push (`src/webpush.ts` VAPID ES256 + RFC 8291 aes128gcm on WebCrypto;
`src/push.ts` open subscribe/unsubscribe + `GET /api/push/vapid`,
`pushConfigured`, `pruneSubs`): subs in `push_subs`, deduped by
endpoint, linked to a team when the subscribe carries a team session.
`POST /api/push/unlink {endpoint}` takes the team off a device and keeps
it subscribed: the site sends it when a team signs out (`scs.pushSub.unlink`),
since a subscribe without a session leaves the link alone. Like
unsubscribe it asks only for the endpoint, which is the device's own.
Sending is console-only, needs the Push tab, and asks for the second
password unless an admin has turned that off (the `x-second-password`
header, checked against PUSH_PASSWORD by the router; wrong = 403 not
401 — see Signing in to the dashboard), aimed at everyone, one
team or one device, batched with a cursor and sent in groups (see
**Three numbers** above), dead endpoints pruned, logged as
`push-send` with the target in the team column. Tiers:
announce (urgency high, buzzes) or quiet update (low, replaces
silently). A rejected submission pushes "Submission rejected" to just
that team; acceptances stay quiet. **Switched off after the event**
(`site_flags.push_off`, the Settings tab's After the event card,
`flags/set` like the two switches beside it, and not on the pulse):
`pushesOff` is asked in `pushMany`, which every send goes through, so
nothing reaches a phone while it is on. The Push tab's send answers 409
saying where the switch is, a message save answers `push.off` and the
composer's toast says no push went out, a rejection is decided as ever
without one, and the outbox is emptied on its next tick rather than
sending the rest of an announcement whenever pushes come back on.
`tests/verify-push.mjs` decrypts a
captured push with node:crypto — keep it passing. sw.js always shows a
visible notification and resolves pushed links against its own scope.
A tap moves an open window of the site to the link; a window the worker
does not control refuses `navigate()`, and then the link opens in a new
window rather than nothing happening (`verify-sw-push.cjs`).
Team registration (`/rego` → `POST /api/rego/create`, `src/rego.ts`):
**the sign-up guard** — `site_flags` rows `rego_closed` (the by-hand
switch), `rego_cap` (the form closes itself once `peopleSignedUp` —
participants on visible teams — reaches it; 0 = none; a signup is
checked against it on the way in and again inside `registerTeam`'s
batch, every statement of which carries the cap, so two signups at once
cannot both take the last places) and
`rego_alerted` (epoch seconds, the once-an-hour alert gate); a read
that fails falls back to open.
`GET /api/rego/status` (open CORS, no-store) answers `{ok, open,
message, turnstile}` — the page hides the form behind `#rg-closed`
when closed, and `turnstile` is the Turnstile site key while BOTH
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are set (secrets like
everything else; unset = the check stands down entirely). The page
mounts the widget into `#rg-turnstile` (explicit render, script
loaded only when a key arrives), sends the token as `turnstile`,
and resets the widget on any failed send (tokens are single-use).
**No UNSW addresses on the public form**: the email field says so
("no UNSW emails, e.g. z1234567@ad.unsw.edu.au"), the page refuses one
before sending, and `cleanMember` refuses `unsw.edu.au` and any
subdomain of it when the public create passes `noUnsw`. The dashboard's
own adds and edits do not, so an organiser can still save someone who
signed up with one before the rule. `verify-rego.mjs` covers it.
The worker re-checks everything on create, in order: honeypot →
closed/full 403 → per-IP (4/h) and global (**15/h now**) 429 →
`turnstileOk` (siteverify; a missing or rejected token is 403, a
siteverify network failure lets the signup through so a Cloudflare
hiccup cannot lock the form) → **three to five people**, the event's
rule, which the page held and the worker did not (`MAX_MEMBERS`; the
dashboard's own paths go to `MAX_TEAM`, 10, below); a sixth filled-in
person is a 400 rather than dropped, and so is an eleventh on the Rego
tab's create → **the whole team
has to fit under the cap** (403 saying how many places are left): the
cap counts people, and checking only that it had not been reached let
a team of five through with one place left. A zID already signed up
is refused **without saying which team has it** (`quiet`) — the public
form would otherwise tell anyone who typed a student number where that
student signed up; the dashboard's own edits still name the team. Confirmation emails are capped on the
public path only (`registerTeam` `opts.guarded`): 3 per address per
day and 60 per hour overall — over either, the email is recorded
`skipped` (resendable from the Rego tab), never refused. Discord
alerts (`alertOrganisers`: every enabled guild's announce channel,
at most one an hour whatever fires it) go out when the hourly cap
trips, when signups reach 10 in an hour, and when a signup fills
the cap and closes the form. Console: `GET rego/settings` `{closed,
cap, people, turnstile}` + `POST rego/settings/set` (logged
`rego-settings`); the Settings tab's **Sign-ups** card (`#rego-open`,
`#rego-cap`, `#rego-settings-save`, standing line + note) drives
them. `tests/verify-rego-guard.mjs` covers the worker side,
`tests/verify-rego-guard.cjs` the page's side of the guard
(`verify-rego-page.cjs` stays the form suite itself); the card
rides `verify-console-ui.cjs`.
**Signing up without a team** (`body.solo`, the form's "How are you
signing up?" choice). One or two people (`MAX_SOLO`; three or more are
told to sign up as a team), no team name, and **no new column**: the
registration is stored with `team_id NULL` and `team_name ''`, and
`isSolo(reg)` is that test. Everywhere a person is shown under a team —
check-in, the ticket, the QR request, the Google Sheet, the CSV, the
terms page — `teamLabel()` reads `''` as `NO_TEAM` ("No team yet"), so
check-in has a name to file them under. **Their email is the ordinary
confirmation with nothing added to say so** — no team row, no line about
being placed (the organisers' call); the ticket's plate near the bottom
reads No team yet, and that is where they see it. The Rego tab's summary counts teams from team registrations only
and adds a Without a team stat; the **Without a team** box lists every
such signup with a tick box, and the bar under it puts the ticked
people into a new team (named there, 409 if the name is taken) or an
existing one with room (the select only offers teams that stay at
`MAX_TEAM` or under; the worker re-checks) — `rego/place` (`regoPlace`,
logged). **A team can be bigger than the form allows** when it asks:
the public form holds three to five, and the dashboard's three ways in —
Add a person on a team's card (`rego/person/save`), New team
(`rego/team/create`) and placing — take a team up to `MAX_TEAM` (10 in
rego.ts). The Rego tab's own limits come from the worker
(`max_team` on `GET rego`), so the number is written down once.
One batch moves the people into the team's registration (positions
after the people already there), merges the answers (societies
together, photo permission only if everyone gave it, questions joined)
and deletes the emptied registrations; then check-in is told the new
team name (`was_team: 'No team yet'`), each person is emailed
`regoEmail(..., {placed: true})` unless the box is unticked, and the
sheet is resynced. Discord's `/verify` answers someone found but not
yet placed with a line saying so rather than a role, and announcements
to everyone reach them. `verify-rego.mjs` covers the worker side,
`verify-discord.mjs` the /verify line, `verify-rego-page.cjs` the
form's payload and `verify-console-ui.cjs` the box.
**Moving someone already in a team** (`rego/person/move`,
`regoPersonMove`, logged `rego-person-move`; **Move** on a person in a
team's editor on the Rego tab), for someone put in the wrong team or a
team that changes: to another team on the tab with room (`MAX_TEAM`),
or out to no team (`team_id` 0). They join the new team's registration
after its people (a team on the tab with no registration gets one) and
keep their code, their terms and their answers; out to no team is a
signup of their own carrying the old team's societies and photo answer,
hidden if that team was. The team they leave keeps its name and its
points even with nobody left on it (`left` in the answer says so).
Check-in is told the new team, `moveMemberTeam` in discord.ts moves the
role in every server where they are recorded (the new team's role on,
the team set up there first if it has none, or Unknown Team; the old
role off either way, so the old channel closes to them), the sheet is
rewritten, and unless `email` is false they get `regoEmail(..., {moved:
true})`, "You have been moved to team X." Somebody without a team is
refused and pointed at the Without a team box. It needs the Rego tab
like every rego action, and an admin can make it ask for the second
password (`move-signup` in `GUARDS`, off by default).
`verify-rego.mjs` covers the move, the refusals and the three locks
(signed out, no Rego tab, the second password), `verify-discord.mjs`
the role and `verify-console-ui.cjs` the control. On the form, each
person's card is titled with the name typed into it, and the societies
question has a None of the above that sends no society. A society the
worker's `SOCIETIES` does not hold is a 400 naming it (`pickSocieties`,
on the form, the Rego tab's create and its save) rather than dropped:
the page, the dashboard (`SOCIETY_LIST`) and the worker each keep a
copy of the list, and one that drifts is found out instead of losing
people's answers.
one signup creates the team, `registrations` + `participants` rows
**in one batch, before anything leaves the worker** — written the
other way round, a failure part way left the name taken with nobody on
it and emails sent for people never stored, and the retry was refused
for the name; now a failed write leaves nothing and a QR or email that
does not come off afterwards is the sweep's (and each person has their
`participants.id` before check-in is asked, so it is stored there
from the start) —
per-person QR via the check-in worker (CHECKIN_API var + CHECKIN_KEY
secret = its REGISTRATION_KEY; z0000000 never dedupes), a confirmation
email per member (`src/email.ts`: Cloudflare Email Service `EMAIL`
binding first with `from` as `{name, email}` (`fromParts` splits
EMAIL_FROM; a plain string made inboxes show the bare address), then
without `reply_to`, then the string form; Resend via EMAIL_API_KEY as
fallback; else `skipped`), and rows appended to a
private Google Sheet via an Apps Script webhook (SHEETS_WEBHOOK_URL
incl. `?token=`; only a body of `ok` counts as sent). **`sheetPush`
asks for the script's answer itself**: Apps Script runs the script on
the POST and hands the answer back behind a 302, so the POST goes with
`redirect: 'manual'` and the Location is fetched with a GET, rather
than leaving a POST's redirect to the runtime. A push that fails says
why (`sheetTrouble`: wrong token, a Google sign-in page, the script's
own `error: …` or Google's crash page, 404, or 50 seconds without an
answer), and the Resync button's 502 carries that sentence; it used to
say only that the webhook did not answer ok, which left an organiser
nothing to fix. The README's script writes every row with one
`setValues` instead of an `appendRow` each, makes the tab if it is
missing and takes a lock. `verify-rego.mjs` covers the redirect and
the crash page. Honeypot +
per-IP/global hourly rate limits (one query). Skipped emails/QRs are
retryable from the console's Rego tab (also CSV export and full-sheet
resync).
**No code, no email**: a confirmation with no ticket in it promises one
that is not coming, so `regoPersonSave` holds the email when `fetchQr`
comes back empty — `email_status` is `'skipped'` and the answer carries
`email_held: true`. The Rego tab then raises an inline panel on that
person's row (`.rg-ask`, kept in `state.regoAsk` so a reload does not
drop the question): what went wrong, then **Send the email anyway** or
**Leave it unsent**. A person with no code gets **Create QR code**
(`rego/person/qr`, logged `rego-qr`) beside **Send email**
(`rego/email`), and Send email mints first and only sends if that
works, answering `needs_qr` and raising the same panel if it does not.
One email without a code per person, enforced in the worker rather than
the page: a conditional `UPDATE … WHERE qr_url IS NULL AND
COALESCE(email_status,'') != 'sent'` claims the right to send and a
second tap gets 409 (logged `rego-email-no-qr`). Every person with a
code also gets an **Open ticket** link, built worker-side by
`ticketFor`/`ticketUrl` from `SITE_URL` and handed over as
`ticket_url` ('' without a code), so organisers can pass a ticket on
without the email. `fetchQr` refuses up front when there is no email
address on file — check-in registers people by address, so the
dashboard's optional email means no code for that person until one is
added. `tests/verify-rego-qr.mjs` covers the worker side and
`verify-console-ui.cjs` the panel and the buttons.
**The terms and waiver are accepted by each person, not on the form**
(`participants.terms_key`/`terms_at`, migration `2026-10-terms.sql`).
The form used to carry an "agrees to the terms" switch on every member's
card, which the one person filling it in ticked for everybody, so it
recorded nothing about whether anyone else had agreed. Now each person
gets a random key at insert (`cleanMember`, 18 bytes base64url; the
migration gave every earlier row a hex one, and `ensureTermsKey` fills
in any row still without one before an email goes to it), and their
confirmation email carries `SITE_URL/terms/?k=<key>` as the first thing
to do, above the code — or a line saying they have accepted, on a
resend after they have. Nobody else's key is in anybody's email. The
site's `/terms/` page is the terms; with a key it says who the link is
for and puts an accept button at the end. `GET /api/rego/terms?k=`
(open CORS, no-store) answers `{ok, name, team, accepted_at}` and `POST
{k}` accepts — a conditional `UPDATE … WHERE terms_at IS NULL`, so a
second press keeps the first time and logs one `rego-terms` row; an
unknown key is 404, a malformed one 400. The key is the capability,
like a ticket's. The public create hands the signer their own link back
as `terms_url` (they are member one), and the page's finished screen
offers it beside a line telling them to remind their teammates. The
dashboard's test sends link to the bare `/terms/` (`regoEmail` opts
`demo`), since there is nobody behind them to accept. Dashboard: the
summary's "Accepted the terms" stat and chart, each team's head says how
many of its people have, each person in the tree is marked, and the
person editor shows when and has **Copy terms link** for someone whose
email went missing — copied, not opened, because opening it puts the
accept button in front of the organiser. The overview hands over
`terms_url`, never the bare key. The CSV export has a "Terms accepted
(UTC)" column; the Google Sheet does not, because acceptance arrives
after the rows were appended and nothing rewrites them for it.
`verify-rego.mjs` covers the worker side and `verify-rego-page.cjs` the
form's payload, the finished screen and the terms page.
**The photo question is answered there too** (`participants.photo_ok`,
migration `2026-10-photo.sql`: 1 yes, 0 no, NULL not answered). The
form still asks it once, of whoever fills it in, for everybody on it —
which says nothing about what anyone else wants — so the terms page
asks each person under the terms, and Accept will not go without an
answer. The answer rides the accepting POST as `photo`; after accepting,
changing it posts `{k, photo, accept: false}`, which records the answer
and accepts nothing, so a change before accepting can never count as
accepting. Logged `rego-photo-yes`/`rego-photo-no`. GET answers `photo`
(true, false or null). The dashboard counts photo permission by person
from these answers (the summary's stat and chart, a mark on each person,
the person editor's line); the team editor's select is the form's
answer and is labelled so. The CSV has an "Own photo answer" column.
**What the confirmation email looks like** (`src/email-html.ts`): the
site's signage, rebuilt in the subset of HTML email clients render.
Tables rather than flex or grid (Outlook lays out through Word),
inline styles rather than classes (Gmail strips `<style>` from a
forwarded message; the one `<style>` block holds a width media query
and nothing load-bearing; the centring of the buttons and the ticket is
inline, `align="center"` for Outlook and auto margins for the rest), literal hex rather than `var()`, no
background image, and `color-scheme: light only` — Apple Mail and iOS
otherwise invert the whole message, and an inverted page is a
grey nobody chose. `border-radius` and `box-shadow` are ignored
by Outlook, so the 2px corners square off and the hard offset shadow
goes; both fail to something the design already uses. `INK` is the
light theme's tokens copied as literals, which is the one copy of the
palette outside site.css — `tests/verify-email.mjs` fails if the two
disagree. The message itself: the five-route stripe top and bottom, the
header picture, then label-over-value rows for team, date and time
(`EVENT_WHEN`, check-in opening) and location (`EVENT_PLACE`, Keith
Burrows Theatre, the same as the ticket page), each with its icon
beside it, then the parts of the
message, set in the middle of the column, with a hairline (`E.rule`)
between each and the same 24px (`E.gap`) either side of it, so the
spacing is one number: the terms on
a black button with the sentence that says nobody takes part without
them; the QR code in a paper frame with a name plate under it and the
green Open your ticket button directly under the frame at its width,
and under that the ticket page's note (`E.note`, a grey box with the
phone icon saying to have it open at check-in), so the three read as
one column; then one sentence for the Discord invite
(`DISCORD_INVITE` in rego.ts, the same link every page's footer uses)
and the site, and SCS.2 Discord and SCS.2 Website as keyline
buttons side by side, carrying Discord's mark and a globe
(`E.buttonRow`, one width each so they stack evenly on a phone), then
the club's address for questions. They were a sentence and a black
button each, stacked, which with the ticket's button made four buttons
down the end of the message on uneven gaps. **Only the sheet carries a
shadow**; the buttons and the ticket frame are flat. The subject is
"You're In! Team X is registered for SCS.2" (and the solo and placed
versions of it), and the HTML `<title>` is the same string. Replies
still reach the club through `reply_to`; the message no longer says
so. **The icons are pictures** (`E.icon`, `E.ICONS`): mail clients do
not draw SVG, so `scripts/email-icons.cjs` draws the ticket page's
outlines and Discord's mark into `website/assets/email/icon-<name>.png`
at three times their 24px, in the ink and on nothing, and the site
serves them. A file named in a sent email stays named there, so
redraw one by saving over it and give a new icon a new name;
`verify-email.mjs` checks every icon the email names is on the site.
**Each icon carries an outline in the colour of its own ground**
(white, or the note's grey for the phone; `HALO_UNITS` either side of
the stroke, the filled Discord mark drawn at 0.86 to leave it room).
The Gmail apps darken a message whatever its `color-scheme` says and
tell it nothing, so no style can swap a picture there; the ground goes
dark, the pictures do not, and a dark icon with no outline vanished.
On its own ground the outline cannot be seen.
`regoEmail(member, lead,
teamName, opts)` in rego.ts says what it says; email-html.ts says what
it looks like.
**The header is a picture**: the title animation's map with its sign
and the S C S 2 discs as a 3:1 banner at 1200x400 (200 tall on the
sheet), served by the site from `website/assets/email/header-banner.png`
and named by
`HEADER` in email-html.ts, with a `height` attribute so a client that
holds pictures back keeps the space, and alt text set in the sign's face
in ink. It was drawn in table cells, which needed nothing hosted and
drew with pictures held back, but could not carry the 45 degree doglegs
and never looked like the map. **Its ground is the original cream**
(242,239,232) on a white message — the organisers' choice; a white
version was tried and taken back. Moving or renaming the file breaks every
email already sent, and `verify-email.mjs` checks it is there at that
size. The same picture can be saved over the file; **a different shape
is a new file**, since an email already sent carries the old height in
its `img` and Outlook would stretch a new shape to it — the taller 16:9
frame it replaced is still at `header.png` for the emails that name it.
Every email takes it: the confirmation, the placing email, the test
sends and the announcements. **The code image is fluid** (`width:100%;
max-width:220px` with 220 in the attributes for Outlook): fixed at
220px the frame could not shrink below 326 and a 320px phone scrolled
sideways, which every string check passed. `tests/verify-email.cjs`
renders it in Chromium at 320, 380 and 700 and is the guard.
**The dashboard's test sends** (`rego/email/test`, `kind`):
`plain` is the old bare message about the sender shape; `ticket`
builds the real confirmation through `regoEmail` — so what lands is
what a team gets and not a copy that can drift — with the name and
team typed on the card; `banner` is the same with another picture in
the header's place rather than above it. The banner has
to be `https://` (an `http://` one is blocked as mixed content and
shows as a broken box, which reads as our fault) and no team ever gets
one: an email cannot run an animation any other way than a GIF, and
that is a try-out. The test's code is `demoQrUrl(env)` — the check-in
worker's `/qr/demo.png`, drawn on the spot from a fixed string with
nothing stored, so a test send does not put a person on the check-in
board that nobody can take off again.
**Which way the confirmation email went out**: the binding is tried in
three shapes and only the first two carry the sender's name, so an
inbox showing the bare address means the send fell through to the
third — and every refusal used to be swallowed, with all three
reporting the same `sent`. `trySendEmail` (email.ts) now answers
`{status, via, shape, name_kept, from, refused}`; `sendEmail` is that
answer's `status`, so no existing caller changes. The Settings tab's
**Test the confirmation email** card sends one message to a typed
address (`rego/email/test`, logged `email-test`) and prints which way
it went out, which shape was accepted, whether the name survived and
what each refused shape said.
**The shared id, and pushing renames across**: the check-in worker
keeps its own row per person, and names get edited. `participants.id`
is what the two sides match on — `fetchQr` sends it as
`participant_id` and check-in stores it (its
`migrations/2026-09-discord.sql`). A person being registered
for the first time has none: `fetchQr` runs before the INSERT in both
`registerTeam` and `regoPersonSave`, so their check-in row is written
without one and the next call fills it in — Create QR code, Send
email and a rename all work from the stored row. `pushRename` POSTs
`/api/rename` with the new name, the new team and the old ones, in
`fetchQr`'s defensive shape (never throws, a failure comes back as a
note); `renameLater` runs it in `ctx.waitUntil` like the sheet
resync, so a slow or unreachable check-in worker cannot hold up or
fail a save, and `renameCheckinTeam` sends one entry per person on a
team. Three paths call it: the person edit in `regoPersonSave` (when
the name changed), the team rename in `rego/team/save`, and the Teams
tab's `teams/rename`. `regoOverview` then matches `checked_in_at` on
`participant_id` when both sides have one and on team + name
otherwise. Without the push a renamed person's check-in mark vanished
from the Rego tab, and a z0000000 person — matched on name and team,
since the marker cannot tell two people apart — was minted a second
code the next time they were registered while the first one still
worked.
**Test people at the door** (`syncCheckinHidden` in rego.ts). A person
the tab counts as a test (`PERSON_SHOWN`: their team is hidden, or their
signup with no team is) is kept off the check-in board, out of the
scanner's list and out of its counts, and their code checks nobody in
(`checkin/CLAUDE.md`). The check-in worker holds a `hidden` flag per
person; this reads its roster, works out who should be hidden from the
tab's own tables, and sends only the flags that differ to its
`/api/hide`, each keyed by the row's own id, name and team.
**A roster row is found four ways**: the shared id, the name and team
check-in has, the zID (not z0000000) and the email, a key two people
share matching neither. The last two are for a row written before
either side kept the id and left under an old team name by a rename
from before renames were sent across, which matched nothing else: the
team was renamed, then hidden, and stayed on the board. Such a row is
also renamed to the tab's names with the id filled in (after the
flags, through `pushRename`), unless another row already holds that
person's id. Names are compared the way check-in stores them
(`checkinText`: its `cleanText` also drops `<>&"'` and the backtick),
or a team called Sam's Crew would be renamed on every read. It runs in the background after `teams/hide` and
`rego/hide`, and every time the Rego tab or the day board reads the
roster, so a hide made while the check-in worker was away is put right
the next time it answers; nothing has to be pushed by hand. A check-in
worker from before the flag sends rows without it and is left alone.
The day board's checked-in figures and the check-in worker's own counts
leave test people out. `tests/verify-rego-qr.mjs` runs both workers
together for it.
**Signing in to the dashboard** (`src/console.ts` `login()`,
`src/totp.ts`, `src/dash-access.ts`, migrations
`2026-10-console-2fa.sql` and `2026-10-console-accounts.sql`). **Every
account is made by an admin** on the Accounts tab: a name, a password of
its own (PBKDF2-SHA256 through WebCrypto, 100,000 rounds — the most
Workers will run — stored as `pbkdf2$rounds$salt$hash`, so the count can
change without anybody's password having to), the tabs it may use or
**admin** (every tab and the Accounts tab), and whether it needs a
six-digit code from the organiser's own authenticator app. The code is
what a password cannot be — per-person, and worth nothing a minute
later — and this worker holds every score on the day, so an account
that can change scores should have one; one that only reads the review
queue may not. `console_users` is name → base32 secret, `confirmed_at`,
`last_step`, `password_hash`, `admin`, `perms` (a comma list of the tab
keys in `PERMS`), `require_2fa` and `created_by`;
`console_backup_codes` is ten SHA-256 hashes per person, one use each;
`console_attempts` is every try, which the throttle counts and the
Accounts tab prints. A name is looked up in any capitals (a phone puts
one on the first letter) and the session is opened under the name as
stored, which is the actor on every log row.
**The shared CONSOLE_PASSWORD does two things now and nothing else.**
The very first sign-in on an empty database makes an admin out of it
(no `console_users` row at all: `noAccounts`, asked again in the
INSERT, so two first sign-ins at once make one admin and the other is
a 409), which is how the first admin exists to make everybody else.
Once that row is there, even before its code is set up, the shared
password makes nobody else; the first admin finishes setting up under
the same name, which `nobodyYet` (nobody has a `confirmed_at` or a
`last_seen`) still lets through. And an account
from before admins made them (`password_hash` NULL) still signs in with
it until an admin gives it one of its own. The migration made every
organiser who had already set up a code an admin, once, behind a
`console_accounts_seeded` marker so a later run cannot make an admin of
somebody an admin has since taken it away from. A name nobody has made
is refused, never enrolled: self-enrolment and `CONSOLE_ENROL_PASSWORD`
are gone. **An older account with no code set up and no password of its
own is refused too** (`no-setup`), because the shared password would be
all that stands in front of its secret and the whole committee holds
it — the old enrolment guard existed for exactly that, after a
half-set-up name handed its secret to anyone who typed it. An admin
gives it a password, and it sets its code up behind that.
**TOTP is RFC 6238 on WebCrypto** — HMAC-SHA1 over 30-second steps,
truncated to six digits, one step either side accepted — and the step a
code belonged to is stored, so the same code cannot be used twice
inside its own window (the store is an UPDATE that lands only on a
newer step, so the same code sent twice at once opens one session, and
the step never goes back; confirming a setup is conditional the same
way, so two first codes at once print the backup codes once). The QR is drawn in the worker
(`qrDataUri`, `src/vendor/qrcode.js`, a copy of the check-in worker's)
and handed over as an SVG data URI, because a secret must not travel to
another service to be made into a picture. It is drawn in the worker
rather than the page because the page used to be one template literal,
where a two-thousand-line encoder would have needed every backslash
doubled; since the page became plain files (`src/dash/`) that is no
longer a reason.
**Setting a code up is the first sign-in that needs one.** An account
made with the code required (or switched to it later, or reset) gets a
secret and no session when its password is right; the secret was made
with the row, so a refresh mid-setup hands back the same one rather
than giving the app a second. The first right code confirms it, opens
the session and prints the ten backup codes once. The page shows the
code box only when the worker asks for it (`needs_code`) or hands over
a secret, so an account without a code signs in with a name and a
password and never sees one.
**Cloudflare's human check is on the sign-in too**, behind the same
`TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET` the rego form uses
(`turnstileOk`/`turnstileSiteKey`, exported from rego.ts), and the site
key rides to the page on `body[data-turnstile]` rather than costing an
unauthenticated endpoint — it is public by definition, and an attribute
keeps it out of the page's script, which is served as the file is
(`body[data-turnstile]` and `body[data-files]` are all the worker fills
into the page).
**It is only insisted on once this address has been refused
something.** The way it fails for an organiser is a venue that cannot
reach challenges.cloudflare.com, so a first, correct sign-in must never
depend on it; guessing meets it on the second try, which is what it is
for. A failed check is recorded as `bad-human` but does not add to the
wait, for the same reason. Siteverify being unreachable lets a real
sign-in through, as it does on the rego form. The token is single use
and the code step is a second request, so the page resets the widget
after every answer.
**The throttle is per address, never worker-wide**: a lock everybody
shares is a lock any stranger who finds the dashboard can put on the
committee on the morning of the event. Three failures are free, then
the wait doubles from five seconds to a quarter of an hour. Only real
guesses count — a wrong name or password, a wrong code; a request that
was itself turned away does not, or pressing Sign in twice while
reading the wait would extend it — and nothing before this address last
got in does. A sign-in still being checked counts as well: each writes
a `trying` row before anything is looked at and takes it away when it
answers, and counts only the rows before its own, so guesses sent in
parallel each see the ones ahead of them.
**What an account may do is checked on every request**
(`dash-access.ts`). `sessionByToken` reads the session and the account
together, so a change an admin makes holds from the next request, and a
session whose account has gone is no session. `allowed(session, verb,
action)` looks the action up in `EXACT`, then by prefix in `PREFIX`, for
the tabs any one of which opens it; `overview`, `me`, `GET quests`
(reviewers read a quest's answers) and `auth/backup` are open to any
account. **An action in neither table is admin only**, so a new
endpoint is closed until somebody says which tab it belongs to — add
it there when you add it to the router. A refusal is 403 with
`no_access`, never 401, which the page treats as signed out. The page
asks `GET me` (`{name, admin, perms, code}`) before it draws anything
and leaves out every tab the account cannot use, rather than greying
them, and loads only what those tabs show; a `me` that does not answer
with a `perms` list (a worker from before) leaves everything shown, and
the worker refuses whatever it would have anyway. A `me` that fails (an
error, or no answer) is never read as admin: the page draws the tabs it
last knew for that account on this device (`scs-console-session-access`),
or none, and asks again until the worker answers. A message with a push
on it also needs the Push tab (`can(session, 'push')` in messages.ts),
and the composer's push box is not drawn without it.
**The second password** (`GUARDS` in dash-access.ts) is a password
apart from the sign-in, held by the worker as `PUSH_PASSWORD` (it began
as the lock on push alone). An admin ticks which actions ask for it on
the Accounts tab — sending a push (on unless turned off), sending an
email announcement, freezing the tab, opening every quest, retiring
every quest, deleting a quest, a team, a submission or a person from
the sign-ups, moving a person to another team, adjusting a team's
points or undoing an award or balance line (`adjust`), awarding or
undoing a challenge, a wager or the EOI (`award`), deleting Discord
roles and channels, sending submit codes in Discord, exporting
everything, and changing an account — kept in `site_flags` as
`guard_<key>`. The router checks it after the account
(`guardFor`/`guardRefusal`), from the **`x-second-password` header**,
so it never sits in a request body beside the thing being changed (an
account's own new password is `body.password`). Missing or wrong is 403
`{second_password, wrong, what}`; the page's `api()` puts up a prompt
naming `what`, sends the same request again with the header, asks again
on a wrong one and gives up on Cancel. `opts.hold` keeps what was typed
for the rest of a run of requests — a push to everyone is one request
per batch — and **every guarded action the page sends as a loop passes
it** (the Submit codes, deleting leftover roles and channels, deleting
original videos, a ledger row's lines): without it the prompt came back
for every batch, and Cancel part way left a delete half done.
`verify-console-ui.cjs` runs the originals delete behind the password. A ticked action with no `PUSH_PASSWORD` on the worker is
locked, and one cannot be ticked until there is one. Changing the
switches (`POST guards/set {key, on}`) asks for the second password
itself whenever the worker has one, or the switch would be the easy way
round the lock.
Console: `GET me`; `GET accounts` (every account with its tabs, whether
it has its own password, its code and backup codes left, last seen; the
switches; the last 60 attempts and failures in the last hour);
`POST accounts/save {create?, name, password?, admin, perms[],
require_2fa}` (a new one needs a password of ten characters or more; a
changed password signs that account out everywhere but the session
making the change; the last admin cannot stop being one);
`POST accounts/delete {name}` (never your own, never the last admin;
its sessions and codes go with it); `POST auth/reset {name}` (a phone
that is gone: a new secret, unconfirmed, codes cleared, signed out —
never your own, which only loses your codes); `POST auth/backup` (ten
new ones for yourself, replacing the old); `POST guards/set`. Logged
`account-add`/`account-edit`/`account-edit-password`/`account-delete`/
`guard-on`/`guard-off`/`auth-enrol-start`/`auth-enrolled`/
`auth-backup-used`/`auth-backup-new`/`auth-reset`. The Accounts tab
(admins only) carries them: the accounts table, an editor with the
tabs as tick boxes under an Admin box that ticks them all and gives
back the ones picked before when it is unticked, the second-password
switches and the attempts; Reset code and Delete account there ask for
the name typed back.
`tests/verify-console-auth.mjs` covers the worker
side — starting from the published RFC 6238 vector, with the codes
worked out from node:crypto rather than from totp.ts, so the two
implementations are pinned to the standard rather than to each other —
and `tests/console-signin.mjs` is what every other suite signs in
through. A suite that needs a second organiser has the first make it
with `accounts/save`.

The dashboard (user-facing name; served at `/dash` — `/console` 302s
there for bookmarks; API
`/api/console/*`; `src/console.ts` API, the page in `src/dash/`,
put together by `src/console-page.js`): an 18h session in `console_sessions`; every
sign-in attempt is logged (`login`/`login-failed`, actor
`console:<typed name>`, quest_code `ip:<8 hex>`) as well as recorded in
`console_attempts`; tabs
Scores / Recap / Queue / Desk / Ledger / Map / Quests / Teams / Messages /
Push / Email / Rego / Files / Discord / Settings / Accounts / Log
(Scores carries the day board and **Freeze the tab**, two taps to arm
and fire; setting a score moved to Points, which became the Desk; the
permission keys in `PERMS` keep the older names, `review` for the Queue
and `points` for the Desk, with Recap opened by `scores` and the Ledger
by any of `review`, `points` or `scores`) (the
paste importer is gone — quests come in by file, teams by Add team).
**The page is plain files in `src/dash/`**: `dash.css`, `dash.html`
(everything inside `<body>`) and the script, a part to a file in
`src/dash/js/` (classic scripts, not modules). `consolePage()` in
`src/console-page.js` puts them into one document — the head, the
styles in a `<style>`, the markup, the parts joined into one script in
a `<script>` — so the browser gets one response
with everything inline. The worker fills in two values and both are
`body` attributes written there, `data-turnstile` and `data-files`; a
new one goes the same way, never into the files, which are served as
they are on disk. They are ordinary CSS, HTML and JavaScript: a
backslash is one backslash. Until October 2026 they were three template
literals inside console-page.js, where every backslash had to be
doubled, a backtick ended the string and `${` started a substitution.
**The script's parts** (until November 2026 it was one 11,600-line
`dash.js`). The shared files load first: `core.js` (the session,
`api`/`post`, `toast`/`done`/`busy`, `el`/`h`/`btn`, times and
`timeBox`, hidden teams, `can`/`canTab`, `state`, and the small pieces
several tabs draw: `chip`, `textInput`, `armed`, `statCard`, `byName`,
a form kept through a redraw (`holdOpen`, `heldIn`, `letGo`) and a
switch that saves at once (`savesAtOnce`)),
`markdown.js`, `uploads.js` (straight to R2, a name typed over a file,
HEIC and WebP redrawn, EXIF, the small and viewing copies, the kinds of
proof file), `preview.js` (a proof file's address and tile,
`reviewMedia`, the full-size preview), `share.js` (the pictures to
paste), `parts.js` (the answer boxes, the count a challenge reads,
`partInput`, `creditForm`) and `tabs.js` (`show`, `loadMe` and
`applyAccess`, the tab bar, `openTab`/`restoreTab`, the menus,
`refresh`). Then `signin.js`, a file per tab in the tab bar's order —
`scores`, `recap`, `queue`, `desk`, `ledger`, `map`, `quests` with
`quest-order`, `quest-editor` and `asks`, `teams`, `messages`, `push`,
`email`, `rego`, `drop` and `albums` (the Files tab), `discord` and
`rolemenus`, `settings` with `storage` and `slides`, `accounts`, `log` —
and `start.js` last, which opens the page signed in or at the sign-in
form. A tab's code goes in its file; something two tabs draw goes in a
shared file. **Each part is a standalone script that parses on its
own**: one function, `(function (dash) { … })(window.dash)`, with
`core.js` making `window.dash = {}`, and nothing else of the page's on
`window`: in the browser's console a function another part uses is
`dash.loadReview()`, and one no other part uses is out of reach. What
other parts use, a part puts on `dash`: a function at the part's top
(`dash.loadDesk = loadDesk;`, hoisted, so it is there before the part's
own code runs), a value where it is declared (`var state = dash.state
= …`, or `dash.SITE = …` alone when its own part never reads it). A part takes
what it uses from the shared files in a `var` at its top, one for each
file under a comment naming it (`var el = dash.el, h = dash.h, …`), and
writes `dash.name` where it uses anything from a tab's file
(`dash.openLedger(t.id)`), looked up when the call runs — so the tab
files may load in any order, as long as nothing they run while the
script loads reaches a part loaded after them. A value that is set
again after it is declared and read in another part lives on `dash`
alone and is written `dash.name` everywhere, its own file included:
`dash.access`, which `loadMe` replaces. Every name on `dash`, and every
field of `dash.state`, is declared in `types/dash.d.ts`, which `npm run
typecheck` holds the parts to, so a new one goes there as well.
**The order is written twice**,
as `JS` in `files.js` (static imports, which wrangler needs) and in
`files-node.js`; `verify-console.mjs` checks the two agree with each
other and with the folder, parses every part alone, scans every part for
the newer APIs below and checks the page runs them joined in that
order, and `verify-dash-bundle.mjs` compares the deploy's page byte for
byte. A new part needs an import and a place in `JS` in both loaders,
and nothing in wrangler.toml.
**How the worker gets them**: console-page.js imports `#dash-files`,
an entry in package.json's `"imports"` with one target per runtime.
wrangler bundles with the `workerd` condition and gets
`src/dash/files.js`, which imports them as Text modules — a
standard wrangler module type, turned on for these names by the
`[[rules]]` block in wrangler.toml. Its globs match the import as
written (`./dash.css`), not the path on disk — the parts' one glob is
`./js/*.js`, which nothing else the worker imports is written as — and `fallthrough = true`
keeps wrangler's default Text rule as well. Node, where every suite
runs, gets `src/dash/files-node.js`, which reads the same files
with `readFileSync` when the worker is imported, so `node
tests/verify-*.mjs` needs no flag and nothing is built. The other ways
were worse. Workers static assets would serve the files at addresses of
their own, on every hostname the worker answers, including the short
link one, and the page is put together per request with two values and
`no-store`, which assets cannot do without the worker reading them back.
Text imports alone fail under Node (`ERR_UNKNOWN_FILE_EXTENSION`), and a
loader hook needs `--import` on every `node tests/…` command or a line
at the top of every suite before it imports the worker. A checked-in
generator would make two copies of the page, which drift as soon as one
is edited without the generator being run, and the generated one cannot
be merged. **What this costs is that no Node suite runs `files.js` or
the rule**, and a glob that stops matching does not always fail the
deploy: an unmatched `.css` is bundled by esbuild as a stylesheet, the
import is `{}`, and the page goes out with `[object Object]` where its
styles were. `tests/verify-dash-bundle.mjs` covers it: it builds the
bundle with `wrangler deploy --dry-run --outdir`, runs it in workerd
(both are in node_modules with wrangler) and compares `/dash` with the
Node worker's, byte for byte. A new file in `src/dash/` other than a
part needs a glob, an import in both loaders and a place in `consolePage()`.
`tab/.gitattributes` keeps the page's files LF on every checkout: a
template literal turned CRLF into LF, a file is served as it is on
disk, and a deploy from a Windows checkout would otherwise send CRLF.
**Where things go, so it does not drift back into a mess.** A tab is
the job done there on the day, with that job at the top: Scores is the
day board, the freeze and setting a score, Review is the queue, Rego is
the sign-ups. **Anything set once and left goes on Settings**, in the
card for what it is about — sign-ups and their rate limits, the
submission limit, the home page (countdown and slideshow), the
after-the-event switches, the email test, organisers and their codes,
and the tools (Export everything, Rebuild photo copies, the version
counters). It used to be spread over five tabs, mostly on Scores, under
the score form it was in the way of. A tab that depends on a setting
says where it stands and links to it (`data-goto` + `data-anchor`, the
Rego tab's standing line); the Settings tab's contents line uses the
same attributes. The look is the site's: a card is a hairline and no
shadow (`.card`), named by `.card-head` > `h2.card-title` with what
acts on the whole card at its right, `.card-sub` for the one line a
card needs, `.set-row` for a setting (name and hint on the left, the
control on the right), `h3.sub-title` for a second thing inside a card.
A button has no shadow at rest; actions on a table row are words
(`td.actions button.small`, `.row-links`); buttons used once in a while
go behind a `details.menu` (the Quests tab's Import and export).
**Adding a quest** is a button under each region's list ("Add a quest
to Clubs Region"; a region with no quests yet still shows its heading
and the button, and there is no add button at the top). It opens the
editor in place with the region set, the code suggested by `newQuest`
(the region's most common letters and the next free number, CQ4 after
CQ3, checked against every key and code) and the order at the end of
the region. **The editor leads with what a quest is**: name, code,
region and points, the description, the questions on the submit form
and who can see it. Location, map pins, flavour text, order, tier and
bonus codes and mystery points are under More options (`.qg-more`).
A quest whose one code is its own key has a Points field and no codes
table, and the code follows the key as it is typed; Add a tier or
bonus code (under More options) brings the table back, and a quest
with several codes, or one code under another name, always shows it.
A new quest's button says Add quest and needs its points.
**Putting a region's quests in order** (`POST quests/order {region,
ids}`, `orderRegionQuests` in quests.ts, logged `quest-order`). A region
heading holding two quests or more has Reorder at its right, except while
the list is filtered or seen as one viewer. It turns the region's cards
into one card of rows: a handle, the place, the code and the name, and
up and down arrows. A row is dragged by its handle (a mouse can take it
anywhere but the arrows); `touch-action: none` is on the handle alone,
so on a phone the rest of a row still scrolls the page. The row follows
the pointer, a row steps aside once the dragged row's leading edge passes
its middle, and the page scrolls when the row is held near the top or
bottom of the window. The arrows move a row one place and keep the focus
on it, for the keyboard. Save order sends the ids and paints the answer,
which is what GET quests answers; Cancel puts the order back. The worker
refuses an id from another region (409) or one sent twice (400), writes
the ids sent as 1..n and puts the region's quests left out after them in
the order they had. The dashboard leaves out quests under a tag it is
hiding, so one request still numbers the whole region. Moving a quest to
another region stays in the editor; its Order in its region field is the
same number. It is a `quests/*` write: the Quests tab may send it (the
`POST quests/` prefix in dash-access.ts), the counter moves and the
public reads are purged. `verify-quests.mjs` and
`verify-console-ui.cjs` cover it. **A
hint says the consequence of the one thing picked**, not all of them
at once — the message composer's urgency and publish time rewrite their
own line as they change — and a card gets no paragraph explaining how
the worker does it.
Teams tab has **Hide hidden teams everywhere** (`state.hideHidden`,
localStorage `scs2-dashboard-hide-hidden`, default on) which filters
the teams table, score picker, the submit codes list (matched on team
name, kept in `state.codes` so flipping the switch redraws an open
table), Review, Rego and Discord client-side. `teams/hide` takes
`ids` as well as `id`, which is what a team group's Hide these teams
sends. **A signup with nobody in a team yet can be a test too**:
`registrations.hidden` (`migrations/2026-10-signup-hidden.sql`), set
by `rego/hide` (`regoHide`, `ids`; refused for a signup in a team,
whose team is hidden instead) from the Without a team box — a Hide or
Show on each signup's own row, and the bar under the box for the ticked
ones. It counts
only while nobody on it is in a team: placing deletes the solo
registration, and the team's flag takes over. `PERSON_SHOWN` in
shared.ts is the one condition for "not a test" over participants p
with teams t and registrations r left-joined, used by the public
sign-up count (`peopleSignedUp`) and the announcement audience and
counts; each of those reads falls back to the old query on `no such
column` (`noSuchColumn`), so a worker deployed before db:migrate keeps
the sign-up page counting.
**A team that did not finish** (`teams.dnf`, migration
`2026-10-team-dnf.sql`; console `teams/dnf {id, dnf}` or `{ids, dnf}`,
logged `team-dnf` / `team-finish`, purged; DNF and Finished on each row
of the Teams table, which shows a dash for the place and "(DNF)" after
the name; the Teams permission through the `POST teams/` prefix). It
stays on every board where its points put it, with no place, and the
teams under it are ranked as if it were not there: 100, 90 (DNF) and 80
are 1, –, 2. `standings` in tab.ts works that out once and every reader
takes `rank` and `dnf` from its rows: `/api/leaderboard` (`rank: null,
dnf: true`, so a frozen or saved copy keeps it), Discord's `/leaderboard`
and `/score` (a dash for the place and a `*` after the points, with
"\* Did not finish." under the board; a place asked for counts the teams
that finished, so `/leaderboard 3` is third among them and a range shows
the teams that did not finish between its places), the score sheet and
`/api/team` (`rank: null`, `dnf: true`, `teams` the number of places),
the recap's top five and a saved copy's top three (teams that finished
only), and the dashboard's table and copies. A copy's digest takes the
mark in, so marking a team is a change the hourly copy saves. Level
teams still take places in name order: places have never been shared.
Hidden teams are left out of everything as before. `verify-ops.mjs`
covers it on a board of its own.
**The Queue** (the Review tab, renamed in the third phase of the
scoring redesign; its permission is still `review`) shows what waits on
review and nothing else, oldest first (`submissions?status=pending`
answers in `submitted_at` order, every other status newest first).
There is no status to pick: a decided submission is reached from the
line it made on a team's ledger or a quest's desk, and one that gave
nothing from the ledger's and the desk's **Rejected or deleted** list.
**One submission** (`submissions?id=`, whatever its status, quest and
team ignored) is how those open it: the Queue shows that card alone, the
quest and team pickers give way to "One submission" and **Back to the
queue**, and the Queue's own tab button always opens the queue.
**By quest**: `submissions?quest=<key>` narrows the list to one
quest (its group key, or a code that has no quest), matched in SQL so
the 200-row limit applies after it, and every answer carries `counts`:
`[{key, name, n, hidden}]` for the whole status, not just the rows
sent, with `hidden` the share from hidden teams so the page can leave
them out the way it leaves out their rows. The picker lists the quests
that have any, in code order with their counts, "Every quest (N)"
first. The pending badge is the list's `pending` (`{n, hidden}`, the
whole queue the account reviews), so it stays the whole queue while one
quest or one team is picked. A quest's editor has **Its desk**.
**By team**: `submissions?team_id=<id>` narrows the list to one team the
same way, in SQL and alongside `quest`, and every answer carries
`team_counts`: `[{id, name, n, hidden}]`, with `hidden` the team's own
flag. An account limited to some quests has them matched in that
query, so its counts are only of its quests. The second picker lists
the teams that have any by name, "Every team (N)" first, a hidden
team's count left out while **Hide hidden teams everywhere** is on; one
team picked puts a line over the list with its points and **Open the
ledger**, and each row of the Teams table has **Ledger**. **The two
picks are kept on the device** (localStorage `scs2-dashboard-review`,
written on every load of the list and put back before the first), so a
reload opens on the same quest and team; a team deleted since is
dropped. `verify-quests.mjs`, `verify-points.mjs` (the limited account) and `verify-console-ui.cjs` cover it.
**The Map tab** (`GET /api/console/map`, `src/team-map.ts`; the `map`
permission, so an account sees it only once an admin ticks it) is where
each team was last known to be and when it last sent anything. Nothing
tracks a phone: a team's place is the pin (`quest_groups.coords`) of
its newest submission on a quest that has one, deleted ones left out,
an organiser's entry counting too since an organiser scoring a team at
a checkpoint is standing beside it. `last_sent` is the newest
submission the team sent itself (`added_by = ''`, any status).
**A quest with several pins** is resolved by `placeFor`: the ticked
codes (`answer.kind === 'codes'`) or an organiser entry's
`credit.codes` are matched to the pins by name (one squashed label
starting with the other: Hurstville / Hurstville Plaza), then by
position when the quest has as many codes as pins; with nothing to
choose (SQ23, The Star or Crown) it is placed between them when every
pin is within 3km of the middle (`NEAR_KM`), and otherwise that
submission is passed over and the one before it is tried (`LOOK_BACK`
of them per team, newest first, through a `ROW_NUMBER()` window). The
answer is `{teams: [{id, name, hidden, last_sent, seen: {lat, lng,
place, quest, quest_name, status, at, organiser} | null}]}`; on a
database without `added_by` it falls back to counting every
submission as sent. **The page** loads MapLibre, the base style, its
fonts and `transit.geojson` from the site (`SITE`), the way the HEIC
decoder is loaded, so it carries no copy of its own; the tiles come
from the site's tile server (probed in the quest page's order), and
when none answers or the style cannot be read it draws OpenStreetMap's
raster tiles instead. One piece of configuration makes the first path
work, and without it the map still draws on the fallback:
`netlify.toml` sends `Access-Control-Allow-Origin: *` on
`/assets/maplibre/*` and `/assets/transit.geojson`. One disc per place
(teams on the same pin share it and it shows how many), green when the
newest of them is under 30 minutes old, yellow under 90, grey after;
names sit to the right and the older of two overlapping labels is
hidden until hovered (`declutter`, on every `moveend`). The list under
it is quietest first: nothing sent at all, then the oldest last send.
A row with a pin flies the map there and opens the place's popup. The
tab reloads itself every minute while it is open, the page is visible
and someone is signed in, honours **Hide hidden teams everywhere**, and fits the map to
the pins once, so a refresh never moves what an organiser is looking
at. A button inside the map has the page's button rule taken back
(`.tm-pin`, `.maplibregl-popup-close-button`): a transition on a
marker's transform makes every pin trail the map as it pans.
`tests/verify-team-map.mjs` covers the placing and the permission.
**The Routes tab** (`src/tracks.ts`, migration `2026-12-tracks.sql`,
table `team_tracks`, one row a team; the `routes` permission;
`src/dash/js/tracks.js`; `verify-tracks.mjs` and the Routes check in
`verify-console-ui.cjs`) keeps the route each team recorded for the GPS
quest, which the replay draws. **The cleaning happens in the page**: the
tab loads the site's cleaner (`website/tab/replay/track-clean.js`,
the file `tracks/clean.mjs` runs) and `assets/transit.geojson` from
`SITE`, cleans the GPX file in the browser, draws it over the file as
recorded on the Map tab's map (`dash.loadMapLib`, `dash.teamMapStyle`,
`dash.addTransit`; it still cleans when the map cannot load) and sends
the replay's copy. Files come from the computer (**Add GPX files**,
several at once, one at a time through the editor, each with its team
guessed from a team name inside the file's name or the track's own
name) or from **GPX files teams sent** (a team's proof files of type
GPX, **Clean**), and a saved route is cleaned again with **Edit**. Before
cleaning, the editor can keep the day from and to a time and leave out
stretches, in Sydney's clock (`edits`, `{from, to, cut: [[a, b]]}`, kept
with the route so Edit starts where it left off; `cleanEdits` keeps only
what is a clock time). **Recorded trips** are string-line files of TfNSW Open Data, saved by
TransportSeek, loaded from the computer for the session, as `--times` is for the
command (where to get them: `tracks/CLAUDE.md`, Recorded trips). **Download cleaned GPX** writes what is on screen. Console: `GET
tracks` (the routes without their points, `sent` the GPX proof files), `GET
tracks/gpx?team_id=` or `?key=sub/…` (the file's words, 25MB at most;
only a GPX proof file, never another kind), `POST tracks/save`
(multipart: `team_id`, `route`, `source`, `edits`, `notes`, and the GPX
file as `gpx`, kept at `trk/<key>`, or `gpx_key`, one of that team's own
proof files; with neither the route keeps the file it had, and a `trk/`
file it no longer points at is deleted), `POST tracks/delete {team_id}`;
logged `track-save`/`track-delete`, no purge (nothing cached reads them).
**`checkRoute` is the line the page has to meet**: version 1, 2 to 20,000
points, whole numbers, times going forwards within one day, every point
inside Greater Sydney, legs of train, metro or tram; the route is
rebuilt from those fields alone and the team's name put on it. **No foreign key on
`team_id`**: deleting a team removes its route and its `trk/` file after
the batch that removes the team (`forgetTrack`). The table rides the full
export and the Storage card counts `trk/` as Routes tab. What the replay
reads is in `website/tab/CLAUDE.md`.
**Day board**: `GET /api/console/board` (named that because
`overview` was taken) → `{pending, oldest_pending_at, per_hour (12
UTC hours oldest-first, zero-filled so the last entry is always the
current hour), teams: {total, hidden}, checkin: {registered,
checked_in, live}, push_subs, encoder: {waiting, encoding, done,
online}, frozen}`; the check-in numbers ride `checkinStatus`
(exported from rego.ts) and answer zeros with `live: false` when
that worker is unreachable. The Scores tab renders it as a card row
above the score form, refreshed with the tab. **The recap's numbers are on the
dashboard too** (the Recap tab's Recap card, **Show the numbers**; `GET
/api/console/recap`, the Scores tab's permission): `recapPayload(db,
{always: true})`, so they answer whatever the site's recap switch says
and while the tab is closed, plus `public`, which the card's line uses
to say whether the page is on the site. Counted when asked rather than
with the day board, since the recap is a dozen queries.
**Review claiming**: opening a submission's card (pointerdown or
focus) posts `review/claim {id}` — a fresh claim by someone else
answers 409 `{error, claimed_by}` and the card shows a "<name> is
reviewing this one" chip; a claim goes stale after 10 minutes
(`CLAIM_FRESH` in the list SELECT, so stale names never render) and
accept/reject clear it. Advice, not a lock — nothing is refused.
**The decision itself is made once.** Accept's batch starts by moving
the submission from pending with a stamp of its own in `claimed_at`
(cleared at the end of the same batch), and each credit only lands if
that stamp is there; Reject only moves it from pending. Two reviewers
pressing Accept together, a request sent twice, or an Accept racing a
Reject: one wins, the other is a 409, and the points match the verdict.
A refused write looks the submission up again (`submissions?id=`), and
a card whose submission has moved on shows it as it is now.
Both used to read the status first and write regardless, which credited
a submission twice. `verify-ops.mjs` fires them at once.
The list also hangs `credited: {code: amount}` on each row (the
team holds on that group's codes (`held`), one 2-param join —
D1 caps binds at 100) and the card warns in `--alert-ink` when a
ticked code is already credited, against double-crediting a
resubmission. Both columns ride migration `2026-10-day-ops.sql`.
**Export everything**: `GET /api/console/export/all` (no-store,
logged `export-all`) → `{ok, exported_at, push_subs_count, tables}`
— every table in `EXPORT_TABLES` in one JSON; `push_subs` rows are
deliberately left out (endpoints + keys let a holder send pushes)
and so are the session tables. The Settings tab's Export everything
button downloads it as `scs2-export-<date>.json`.
**Personal data** (`src/privacy.ts`, the Settings tab's card for admins,
`src/dash/js/privacy.js`; `tests/verify-privacy.mjs`). The sign-ups'
`participants.email`, `zid` and `dietary`, the `eoi_people` list and the
addresses in `email_queue`, and the check-in worker's own emails and zIDs
(its `/api/personal/*`, `checkin/CLAUDE.md`), taken off both databases
into a file the organiser keeps, and put back from it. `GET privacy`
counts what is stored on both sides and says whether it is off (the
`personal_removed` row of `site_text`, `{at, by, people}`). `GET
privacy/export` answers the file as `copy` (`kind: scs2-personal-data`,
`version` 1, the rows by id with each person's name and team to read
by, and `checkin` the door's rows, null when check-in is not connected
or did not answer, with a `checkin_note`). **`POST privacy/remove`
takes that copy back** and removes nothing unless it holds every value
stored now, here and at the door, exactly (`changedSince`; a change made
since the download is a 409 saying how many rows), so nothing goes that
the organiser does not have in hand; nor while an announcement is still
sending, since its queue rows are what goes. The door's copy is cleared
first and a refusal there stops the lot; then one batch sets `zid` to
'' and `email` and `dietary` to NULL, deletes the EOI rows and the queue
rows (the Sent list keeps its counts, which `email_sends` holds) and
writes the mark. A copy made without the door's rows is refused while
the door answers holding some. **`POST privacy/restore`** writes each
field back only where it is empty now, so anything typed in since stays;
the EOI list only into an empty table, the queue rows only for sends
still there, the door's through its restore, and the mark comes off.
**While the mark is on**, `eoi/award` (which matches on zIDs and emails,
and would read everybody as nobody), editing someone already signed
up (`rego/person/save` with an id) and retrying an announcement's
failed addresses (`announce/retry`, which would count the send again
from an empty queue) answer 409 saying to put the data back first. The ticket sweep and the announcements already pass over a
person with no address. All four actions are admin only (in neither
table in dash-access.ts), and the second password can be asked for the
three that read or write the data (`privacy` in `GUARDS`). **What it
does not reach**: the Google Sheet the sign-ups were copied to (a Rego
tab resync would rewrite it from the emptied rows), `npm run backup`
files, the full export someone downloaded before, and D1's own
point-in-time recovery, which keeps the last 30 days.
**Original videos** (`src/originals.ts`, the same card part; migration
`2026-12-video-originals.sql`, table `video_originals` keyed by
`r2_key`: `bytes`, `saved_at`, `gone_at`, `gone_by`;
`tests/verify-privacy.mjs`). A proof video as the team's phone wrote it,
location and all, which nothing public serves. `GET originals` counts
those kept, saved, deletable and not yet encoded. `GET originals/zip`
answers the album download's kind of links (`ZIP_FILES`, `ZIP_BYTES`,
`ZIP_HOURS`, signed `video-originals:<expiry>` under
`CONSOLE_PASSWORD`) to `/api/originals/zip/scs2-original-videos[-part-N-
of-M].zip?pass=&part=`, every original still kept in id order, each named
`<team> - <quest> - <its name>`. **A video counts as saved only when its
part has gone out whole**: the archive stream is wrapped (`whenRead`) so
the rows are written once the last byte has been taken, and a download
stopped part way writes nothing. `POST originals/delete {after}` takes
up to `DELETE_BATCH` (40) a request and the page carries on until
`done`: only a video saved, encoded (`encode_state` done with a
rendition row) and not already deleted, and only while the bucket
really holds a copy to play in its place (`<key>.c`, else the largest
rendition, headed rather than taken from the rows); it deletes the
original and its `.x` block, where the location is written, and keeps
the still, the copies and the row. An encoded video is never claimed by
the encoder again (`retryVideos` resets only encoding and skipped), so
nothing asks for the original after. The dashboard's own file read
(`serveFile`) and an album's ZIP fall back to the clean copy where the
original has gone (`standIn`, `serveAlbumZip`). Admin only; the delete
can ask for the second password (`originals` in `GUARDS`).
Rego tab: **a sign-up summary first** (`#rego-summary`, drawn by
`renderRegoSummary` from `renderRego` so it follows the text-filterless
list, hidden teams left out via `hiddenTeamIds`): `statCard`s for
teams, people, checked in (only while the check-in worker answers)
and photo permission, then `regoBarChart` cards (`.rg-chart`,
`.rg-bar-row` = label | track | "n unit (pct%)", fill scaled to the
biggest bar) for societies (every `SOCIETY_LIST` entry even at zero,
descending, plus any typed-in extra and "None picked"; multi-pick, so
counts sum past the team total), team size, Arc yes/no, photo
permission yes/no, dietary (split on `;` per person, top 10 + "N
other answers" + "None given") and checked in. All counted
client-side from the same registrations the cards draw — the Google
Sheet is written FROM these rows (signup append + edit resync +
the Resync button), so the summary is the sheet's data; nothing
reads the sheet back. `verify-console-ui.cjs` covers it.
Rego tab = one `.rg` card per registration: team head + `.rg-tree`
of people with check-in marks (regoOverview merges
`checked_in_at` from the check-in worker's `/api/status`, which now
also accepts `Bearer REGISTRATION_KEY`; matched on the shared
`participant_id`, or team name + person name when a roster row has
none; `checkin_live` says whether it answered); **Edit** opens the
editor (`rego/team/save` renames the tab team + registration + Discord
role/channel, `rego/person/save` edits or adds (new people get a QR
and email through the shared `registerTeam`/`cleanMember` path in
rego.ts), `rego/person/delete`, `rego/team/create` = a signup without
the public form's honeypot and rate limit; every edit resyncs the
sheet in `ctx.waitUntil`). Times: the worker stores UTC; the page's
`fmtTime` and the site's `scs.fmtTime` render them in the device's
zone. Phones (≤700px): the tabs fold behind `#menu-btn` (`.tabs.is-open`,
name + sign-out in `.menu-who`), no sliding pill.
**Tablets and touch.** Organisers run the day on iPads, upright
(744–834px) and on their side (1024–1194px), with no mouse. The phone
layout stops at 700px so an iPad mini held upright (744) keeps the tabs.
Tabs that do not fit wrap onto a second row rather than scrolling off
the side, and `placePill` moves the pill down as well as along
(`translate(x, y)` plus height); at ≤1100px the tabs are narrower, so a
1024px iPad on its side holds all of them on one row. A table cell
breaks a long word (`td { overflow-wrap: anywhere }`; `td.num` and
`td.actions` keep `nowrap`), so a long team name or address squeezes its
column instead of pushing the table past its card. Under `(pointer:
coarse)` every button, select, text box and menu summary is at least
44px, a tick box's label is its target, links in a line of text get a
44px target from padding cancelled by negative margins, a map pin is a
44px button round its 22px disc, and MapLibre's zoom and popup close are
44px (`.team-map` in front of their selectors, since MapLibre's sheet
loads after this one). `.tabs button` takes back `min-width: auto`,
because a fixed 44px minimum let `flex: 1` tabs shrink under their words.
The Map tab turns on `cooperativeGestures` on a touch screen, so one
finger scrolls the page past the map and two move it. The second
password box sits in the top half under a coarse pointer, clear of the
keyboard. `(hover: none)` lets a bar chart's cut-off label wrap, since
its `title` is never seen. **Drag on a touch screen**: the quest reorder
drags by its grip alone (`touch-action: none` on the grip). A slide tile
is `touch-action: manipulation`: a finger that moves first is scrolling
the page; one held still for 300ms (`HOLD_MS`) lifts the tile, a
non-passive `touchmove` then holds the page still, and the page scrolls
under a tile held near the top or bottom of the window. The board's hint
says "Hold and drag" on a coarse pointer. A tap outside an open
`details.menu` closes it through `pointerdown`, because iOS Safari sends
no `click` for a tap on something with no handler of its own. A menu
that would open off the left edge (its button wrapped to the left on a
narrow screen) opens rightward (`.menu-pop.is-rightward`, set on
`toggle`). The photo preview's picture is a shrinkable flex item, so a
tall photo gives up height to the details panel, and to Safari's bars,
where `100vh` is taller than what shows. `[hidden] { display: none
!important }` because the `hidden` attribute lost to `.row-form` and
`.rg-place-mail` display rules, which left the slide editor's rows and
the Rego move form's Email line showing when they were meant to be gone.
`verify-console-ui.cjs` drives the slide board with real touches (CDP
`Input.dispatchTouchEvent`): a swipe scrolls and moves nothing, a hold
then a drag saves the new order.
**Browsers from September 2021.** The page has to run on Chrome 93,
Edge 93, Firefox 92, Safari 15.0 (iPadOS 15) and Samsung Internet 15
(Chromium 90). The script is ES5-style (`var`, no `.at()`, no
`Object.hasOwn`, `structuredClone`, `findLast`, `randomUUID`, regex
lookbehind or `<dialog>`); `ClipboardItem` and `createImageBitmap` are
used only behind a check, with saving the file as the fallback. In CSS:
no `:has()`, `color-mix()`, `dvh`/`svh`, container queries or nesting;
`:focus-visible` only in a rule of its own, since a selector list holding
it is dropped whole before Safari 15.4; `word-break: break-word` beside
every `overflow-wrap: anywhere` (Safari 15.4 again); `-webkit-user-select`
beside `user-select`. Firefox 92 has no `datetime-local` box and shows a
text box: every one goes through `timeBox(input)` (the static ones at
boot, before any other change listener), which in that case adds a
`YYYY-MM-DD HH:MM` placeholder, tidies what is typed when the box is
left, and empties the box with a toast when it is not a time, rather
than letting the save read it as no time at all. `toLocalInput` writes a
space there instead of the `T`, and `fromLocalInput` reads either.
MapLibre itself (loaded from the site) calls `Object.hasOwn` and
`.at()`; the vendored `website/assets/maplibre/maplibre-gl.js` carries
`scsCompat()` for both, in the page and in its workers.
`verify-console.mjs` holds the page to that list by name, so a newer API
added to any part of the script or to dash.css fails `npm test` rather than an organiser's
iPad.
**Which tab is open survives a reload** — the day is spent reloading
this page (a flaky venue connection, a phone waking up, a stale
session) and landing on Scores each time means finding your place again
every time. `openTab(name, opts)` is the one path in, called by a click
and by `restoreTab()` on boot; `rememberTab` writes `scs2-dashboard-tab`
**and** the address (`/dash#rego`), so the tab is also a link an
organiser can send. On boot the address wins over the stored name and a
name that is not a tab falls through to the first, so nothing can leave
the page showing no view at all. `opts.boot` skips the pill's slide
(there is nothing to slide from) and swaps the tab's loader for
`TAB_BOOT`'s, because `refresh()` is about to fetch the day board and
the review list anyway — Review's entry there loads the encoder boxes
only, which `refresh()` does not. `replaceState`, not an assignment to
`location.hash`: the latter fills the back button with tab changes. A
`hashchange` listener answers a link followed while the page is already
open, since a browser does not reload for a fragment. Page
conventions: no kickers, one `#toast` for every outcome (`done(r,
text)` — **pass a function when the success text reads response
fields**: it is only called on success, since an error response
lacks those fields and the crash used to be swallowed, hiding the
error toast entirely), sliding-pill tabs, `busy(button, promise)`
(disables + `.is-busy`, a ticking-ellipsis ::after; the same class
and CSS live in site.css for the site's own submit buttons — rego
sign-up, submit send and sign-in, the ask box's Send, which also
says "Sending…" on its line), inline
type-the-name confirms, two-step armed push send, digit pop-in on
totals, row stagger on refresh, `#main.is-ready` fade on first data.
**A redraw keeps what is half typed**: every tab loads again when it is
opened, and a list drawn again puts back the node holding an open form
(`holdOpen` marks it, `heldIn` hands it back, `letGo` once it is saved or
cancelled) — a Queue card, a Rego editor and the new team form, a Files
row, the open quest editor, a Discord server card while a run goes on
it; the countdown rows are left alone while they differ from what was
last drawn, and the desk's form while its quest's parts are the same. A 401 shows the sign-in over the page
as it is; `api()` sends nothing without a session, so the Map poll, the
album queue and the runs of requests stop, and signing in again loads
the tab that was open.
Per-team Hide/Show (`teams.hidden` scrubs a team from every public
read; the test-team switch). Quest renames re-key through
insert-move-delete in one batch (the old `completions` rows FK the code), and the same
batch renames the code wherever stored JSON names it
(`renameStatements`): every submission's `credit` (its codes and the keys
of its counts and part marks, which Take back, Change, Reject and the
receipt read), the codes a team ticked in a `codes` answer and nothing
else it typed, and the code an award by place or a wager settlement
paid on. Inside JSON a code is a quoted string, so renaming CQ1 cannot
touch CQ11. Every write
is logged as `console:<name>` and cache-purged. Tests live IN THE REPO
at `tab/tests/` (`npm test`, `npm run test:ui`, plus the
verify-*.mjs/.cjs suites; `verify-quests.mjs` covers the quest list,
`verify-discord.mjs` the Discord side and the Rego edits,
`verify-countdown.cjs` the split-flap board and the home slideshow's
swipe,
`verify-map-desktop.cjs` the map's wheel and pinch zoom and the
panel's mouse drag, `verify-freeze.mjs` the tab freeze,
`verify-questlist.cjs` the tick marks and the codes-box cue,
`verify-anywhere.cjs` the linked rockers, sort and map chip for quests
with no pin,
`verify-switch.cjs` the rocker's travelling block, the theme view
transition and the iOS tap switches,
`verify-app-layout.cjs` the web app layout and its switch,
`verify-messages.mjs` the messages + pulse worker side,
`verify-bell.cjs` the bell, dot, messages page, urgent pop-up and
version-driven banner, `verify-sheet-gestures.cjs` the sheet's
hand-scroll, pinned grab bar and the pull arrow after a reversed
gesture, `verify-ask.mjs` + `verify-ask.cjs` the live-quest files
and questions worker- and page-side, `verify-encoder.mjs` the video
rendition pipeline, `verify-ops.mjs` the score sheet, a team that did
not finish, rejection reasons, claiming, credited map, scheduled
publishing, ask deadlines and the full export, `verify-offline.cjs` the tile cache
and its rocker, `verify-submit-page.cjs` the submit page's score
section and rejection line, `verify-compress.cjs` the submit page's
compress view walked through all five of its states (nothing chosen, a
file chosen, running, done, failed) against a stub engine, since
everything it is for sits behind a file picker and
`verify-redesign.cjs` never opens the view at all — plus the bar the
composer's segment carries while a run is on and the finished video
handed straight over to it, `verify-console-ui.cjs` the day board,
claim UI and Publish at field, `verify-dash-bundle.mjs` the dashboard
page as the deploy bundles it, run in workerd, against the page the
suites see, `verify-gallery.cjs` the slideshow's
prepared-ahead slides and random-order rocker,
`verify-tab-cache.cjs` the last-good copies the tab and teams line
paint from, `verify-retry.cjs` a dropped request asked again (sw.js and
`scs.fetch`) and a ticket link opening with no signal, `verify-recap.mjs` + `verify-recap.cjs` the
after-the-event switches, team pages and recap,
`verify-rego-guard.mjs` + `verify-rego-guard.cjs` the sign-up guard
(closed switch, cap, Turnstile, email caps, alerts) worker- and
page-side, `verify-rego-page.cjs` the rego form itself,
`verify-email.mjs` the confirmation email's markup, its colours
against site.css and the three test sends, and `verify-email.cjs` the
same message rendered in a browser at 320/380/700 (nothing off the
side, the stripe, the code's size, the whole button being the link,
4.5:1 on every piece of type), `verify-full-list.cjs` the full quest list page, the
lightbox zoom, open/close morph, swipe-to-close, the name and the
close over the photo, the swipe lifting them, the one-tap black
screen, the mouse's click-to-zoom, and the messages page's wide
photos and time stamps) —
scratchpad suites keep being lost to container resets. **The
dashboard's script is the parts in `src/dash/js/`, which Node only reads
as text**, so a syntax error in one is one the browser sees and no suite
runs into; `npm test` (verify-console.mjs) parses each part on its own
to catch this. README.md in that folder is the install/update
guide — keep it true.

## Migrations

`tab/migrations/*.sql`, applied oldest first by `npm run
db:migrate` (`scripts/migrate.mjs`). It writes `wrangler.deploy.toml`
first through `writeConfig()` in deploy.mjs, because plain `wrangler d1
execute` reads the committed wrangler.toml's placeholder `database_id`
and fails saying it is not a uuid — which reads like a missing
database. A fresh `schema.sql` database needs none of the files.
**It applies only what the database has not had** (`pending`): each
file applied is recorded in the database's own `_migrations` table
(name, when), made by the runner if it is not there, so a run after the
first sends only the new files. A database from before the table has
nothing recorded and is offered every file once, recording each.
`npm run db:migrate -- --all` offers every file again whatever is
recorded. A file recorded and then edited is not offered again, so a
change to a migration is a new file. If the table cannot be read the
run offers everything, as it did before. `verify-migrate.mjs` drives
both against a pretend wrangler.
**Rerunning a file is safe.** SQLite has no `ADD COLUMN
IF NOT EXISTS`, so an ALTER that has already been applied is an error
("duplicate column name"); the runner counts that and carries on, and
stops only on something else. A file is tried whole first because one
wrangler call is far faster than one per statement, and only a file
that comes back already-applied is retried a statement at a time — D1
stops at the failing statement, so everything after it in that file
would otherwise be skipped. `statements()` strips `--` comments before
splitting on `;`, which matters: `2026-10-push-devices.sql` has a
semicolon inside a comment.
**What this replaced**, because it cost a day: a one-line shell loop
with `|| exit 1`. It stopped at the first already-applied ALTER, so a
database part-way through the list never reached the newest
migrations — the exact failure the command existed to prevent — and
being a POSIX loop it did not run on Windows at all. The same Windows
lesson as the encoder launcher applies to `wrangler()` in deploy.mjs:
a shell is needed to run npx.cmd, a shell re-parses the line, so every
argument is quoted (`quoteArg`) or a repo under a path with a space in
it is split in half.
`tests/verify-migrate.mjs` covers the splitter, the error reading and
the runner end to end against a pretend wrangler (`WRANGLER_BIN`).
README.md's "Updating the bot once it's live" is the catch-up runbook.

**The runner sends SQL with `--command`, never `--file`.** With
`--remote`, `--file` is D1's import API: the database stops answering
queries while it runs ("your D1 database will be unavailable to serve
queries"), and a file that fails is undone by resetting the whole
database to where it was. An ALTER that is already applied is a failure,
so a run over a database that was up to date reset it once for each of
the 26 files holding one and again for each of their 49 ALTERs, sent on
its own — 75 resets a run — and a reset can come back as
`✘ [ERROR] {"D1_RESET_DO":true}` instead of the SQLite error behind it.
That is not an already-applied message, so the run stopped there, with
nothing from that file applied. `--command` goes to D1's ordinary query
endpoint: the site keeps working through a run and a failure comes back
in SQLite's own words. It is one argument, and on Windows it goes
through cmd.exe, where a newline ends the command, so `oneLine()` puts
it on one line (whitespace inside a quoted string is left alone). The
longest migration is about 1,500 characters on one line; cmd.exe stops
at 8,191. `db:schema` and `db:seed` still go through the import API
(`d1-run.mjs`, `--file`), which is right for a seed and harmless for a
schema made of `IF NOT EXISTS`, but both take the database offline
while they run.

**D1 splits what it is sent itself.** Locally wrangler splits the SQL
and drops empty statements; with `--remote` D1 splits it server side,
and *that* parser rejects an empty statement with `SQL code did not
contain a statement`. Which is not one of the two already-applied
messages, so the runner treated it as a real failure and stopped. The
payload used to be built as `sql.endsWith(';') ? sql : sql + ';\n'`, and
every file in migrations/ ends with `;` **followed by a newline** — so
endsWith was false for all of them, a second semicolon went on, and the
run died on the first file every time while every local test passed.
`payload()` now rebuilds from `statements()` instead of patching the end
of the string, so comments are gone and neither an empty nor a
comment-only statement can survive; a file of nothing but comments sends
nothing rather than a lone semicolon. `tests/verify-migrations.mjs`
checks what the runner would send for every real migration, and
`tests/verify-migrate.mjs`'s pretend wrangler answers `--file` the way
the import API did, so going back to it fails the suite.

**A column added to an existing table can only reach a live database
through `migrations/`.** `schema.sql` is all `CREATE TABLE IF NOT
EXISTS`, so `npm run db:schema` creates tables that are not there and
does nothing whatever to a table that is — it does not compare columns.
Three columns were added with a comment in schema.sql telling whoever
ran the database to do a one-off ALTER by hand and no file here:
`teams.hidden`, `submissions.gallery` and `push_subs.team_id`. Nothing
caught it, because every other suite builds its database from
schema.sql and so always had them; a live database had no way to get
them, and `npm run db:migrate` — the command the worker's own error
message names — ran clean and changed nothing. The symptoms were the
leaderboard, stats, gallery, recap and Discord team lookups all
answering "no such column: hidden", and every upload failing on the way
in, because the submit create inserts into `submissions.gallery`.
`tests/verify-migrations.mjs` is the guard: it builds a database the way
a real one was built — the oldest `schema.sql` in the history, then
`db:schema`, then every migration — and fails if the result does not
match `schema.sql`, or if schema.sql asks anyone to run an ALTER by
hand. `npm run db:check` (`scripts/db-check.mjs`) is the same question
asked of the live database: it reads the schema, prints what is missing
and the SQL that would add it, and alters nothing.

**Four things, not two, and the last two fail silently.** db:check and
verify-migrations both compare tables, columns, **indexes** and the
**column-level UNIQUE constraints**. A missing index breaks nothing —
every query still answers, a plain one just reads the whole table, and a
UNIQUE one has stopped refusing the duplicate it was put there to
refuse — and a constraint the schema has since dropped is the reverse:
the live table is still refusing rows the code expects to insert, and
the only symptom is a 500 on an insert that looks fine. `db:schema` is
the fix for a missing index (`CREATE INDEX IF NOT EXISTS` on a live
table does real work, unlike `CREATE TABLE IF NOT EXISTS`); a
constraint needs the table rebuilt.

**`migrations/*.once.sql` is listed by `db:migrate`, never run by it.**
A rebuild — copy the rows out, drop the table, create it again, copy
them back — is the only way to change a constraint, cannot say in SQL
that it has already been done, and would redo the whole thing on every
run. `split()` in migrate.mjs makes the division; verify-migrations
fails if a file containing `DROP TABLE` is not named that way. There
are none in this worker; the check-in worker has the one.

**`npm run secrets:check`** (`scripts/secrets-check.mjs`) is the same
question asked of the secrets: it lists what `secrets.example.json`
names against what `wrangler secret list` answers, plus any secret on
the worker the repo does not name, plus any name that is in both the
example and `[vars]` (a deploy refuses that and does not say which one
is the duplicate). Names only — no value is read, printed or uploaded.
It exists because an unset secret fails nothing: `configured()` reads
it as unset and the thing it guards stays off, so the symptom is a
feature that is missing rather than an error anybody sees.

**`npm run backup`** (`scripts/backup.mjs`): the database through
`wrangler d1 export` into a dated SQL file in `backups/`, and with
`--photos` the worker's R2 bucket mirrored into `backups/files/<bucket>/`,
skipping what is already there at the same size and writing each file
beside its name before moving it into place, so a run cut off leaves
nothing half written. Wrangler cannot list a bucket, so the photos go
through R2's S3 API with a read-only token from `backup.json` (or the
environment) — signed by hand with AWS signature version 4 rather than
through the AWS SDK, and `tests/verify-backup.mjs` holds the signing to
AWS's published example and runs the whole command against a pretend
wrangler and a pretend R2 that re-checks every signature. `backups/` and
`backup.json` are git-ignored at the root: they hold the sign-up form's
answers.

**`scripts/deploy.mjs`, `migrate.mjs`, `db-check.mjs`, `d1-run.mjs`,
`secrets-check.mjs`, `backup.mjs` and `tests/verify-migrations.mjs` are
byte-identical copies in `checkin/`.**
That worker is a separate package and cannot import from here, which is
the same reason it has its own copies of the small helpers. `dbName()`
in deploy.mjs reads the database name out of each worker's own
`wrangler.toml`, which is what lets the files be the same; the last
check in verify-migrations compares them and fails in both if one is
edited alone. So driving db:check end to end once —
`tests/verify-migrate.mjs` does, against a real sqlite file behind a
pretend wrangler, with `WRANGLER_BIN` answering `--command` out of it —
covers both workers.
