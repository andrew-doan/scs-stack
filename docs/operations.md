# Running the event

What to do before the day, on the day and after it, and the errors that
have come up before with their fixes. The commands run in `tab/` unless
it says otherwise; the check-in worker has the same ones in `checkin/`.

## Before the day

### Secrets, database, deploy

Always in this order, so new code never runs against a database or
secrets that are behind it:

1. `npm run secrets` uploads `secrets.json` (copied from
   `secrets.example.json` and filled in). `npm run secrets:check` lists
   what the live worker has against what the repo names. A secret that
   was never uploaded breaks nothing visibly: the feature it guards just
   stays off.
2. `npm run backup`, then `npm run db:migrate`. `npm run db:check`
   should then report nothing missing.
3. `npm run deploy`. Never `npx wrangler deploy` directly: only the
   script fills in the database id and the link page's backup store.
   The first time on an account, make that store with
   `npx wrangler kv namespace create scs-link-page`; until then the
   deploy goes ahead without it and says so.

The website deploys itself: Netlify publishes `website/` from the
production branch and builds a preview for each pull request.

Secrets that matter on the day:

| Secret | Without it |
|---|---|
| `PUSH_PASSWORD` | no push, and every action behind the second password is locked |
| `TAB_SYNC_KEY` (same value on both workers) | check-ins never reach the tab |
| `CHECKIN_KEY` (the check-in worker's `REGISTRATION_KEY`) and `CHECKIN_API` | no check-in codes for new sign-ups |
| `ENCODER_KEY` | the encoder cannot connect |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | uploads go through the worker in slices instead of straight to R2 |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | no human check on sign-up or dashboard sign-in |
| `DISCORD_BOT_TOKEN` | the bot cannot post, set up channels or run `/verify` |

### Checks

- `npm run test:all` before a release ([testing.md](testing.md)).
- `security/probe.sh` against the live hosts, before the event and
  after any worker deploy ([`security/README.md`](../security/README.md#when-to-run-it)).
- By hand after a deploy:
  - `GET /api/pulse` on the worker answers with `quests`, `messages`
    and `urgent`.
  - Post a test message from the dashboard; the bell on the site shows
    its dot, and the message appears at `/messages/`.
  - Open a question on a quest; its LIVE tag appears on the quest list
    and teams can answer from the sheet. Close it again;
    `GET /api/questlist` no longer mentions it.
  - Sign in on `/submit/` with a team code; the score section renders
    under the form.
  - The Scores tab shows the day board row; the Review tab shows the
    encoder box once a machine has checked in.
- Settings → Email → Test the confirmation email sends a plain test, or
  the ticket email, to one address.

### Setting up the dashboard

- An admin makes an account for each organiser, with only the tabs they
  need. Anyone who can change scores should have the authenticator
  code required. An account for a main quest gets the Desk and that one
  quest.
- On the Accounts tab, choose which actions ask for the second password.
- Teams tab: generate submit codes. Discord tab: set up each server's
  organiser role, set up team roles and channels, and send the submit
  codes.
- Quests tab: the quests, their opening times and who can see them.
  Settings: the countdown, the slideshow, the sign-up limits, the review
  limit per team.
- Shrink slideshow pictures before uploading them, to about 1920 pixels
  on the long side and under 1MB. The home page sends each picture at
  the size it was uploaded, to every visitor: four phone photos at 4MB
  each are 16MB on the first visit, over the venue's connection. The
  same goes for pictures attached to a message.
- Hide test teams (Teams tab) so they are off every public read and the
  check-in board.

### The encoder and the door

- Give each organiser running the encoder `scs-encoder.command` (Mac)
  or `scs-encoder.cmd` (Windows), and send `ENCODER_KEY` separately. Any
  number of computers can run it. [`tab/ENCODER.md`](../tab/ENCODER.md).
- Door crew open the check-in worker's `/scan` and type the scan
  password once per device. The wall screen opens `/board` with the
  board password. [`checkin/README.md`](../checkin/README.md#on-the-day).

## On the day

### What to watch

- **Scores tab**: the day board, the ledger check (red only when a
  line's points differ from its code's), and what the scheduled run
  still has waiting (pushes, ticket emails, announcement emails).
- **Queue tab**: the count on its button, and the video encoders card at
  the foot. **Retry failed videos** offers skipped videos again.
- **The worker's logs**: the worker's Observability tab in the
  Cloudflare dashboard keeps every request and error for a few days.
  `npx wrangler tail` streams them live.
- **The check-in board** on the wall.

### Freezing and closing the tab

- **Scores → Freeze the tab**, two taps: the first arms it, the second
  fires. The leaderboard, the quest counts and the stats are served
  exactly as they stood, to the site and to Discord's `/leaderboard`
  and `/score`; `/quest` and `/list` wait. Organisers keep scoring and
  the dashboard shows the real tab; their own Discord reads answer live
  and only to them, and their `channel:` is refused until the thaw.
  Team pages, the recap and the replay are shut whatever their switches
  say. Messages, the pulse, the countdown and the slideshow keep
  answering live. The live tab page ices over.
- **Unfreezing** publishes everything scored during the freeze at once.
- **A thaw by mistake**: under Saved standings, pick the copy taken at
  the freeze and press **Freeze the tab with this**.
- **Close the tab** (also two taps) goes further: the standings answer
  only that the tab is closed, the team pages and recap stay shut, the
  score sheet says scores are hidden, and team channel posts leave out
  the total. Opening it again shows the frozen copy, or the live tab.
- **Copy the standings as an image** draws the real order whatever the
  freeze says, for announcing at the ceremony.

### Holding Discord posts

Discord tab → **Hold posts**, and tick the servers to hold. Nothing goes
to a ticked server: no reviews, points, check-ins, announcements or
codes, and a command's answer there is seen only by whoever ran it. Each
held message is in the Log. Servers left unticked carry on as normal.

### Stopping email

Settings tab → Email → **Stop sending email**. Nothing is emailed while
it is ticked:

- Announcements, their tests and the confirmation email test are
  refused with the reason. An announcement already going out pauses,
  and carries on once the box is unticked. Stop still works on it.
- Sign-ups still go through and get their check-in codes. Their
  confirmations are marked held on the Rego tab, and the scheduled run
  sends them once the box is unticked, three people a minute.
- Send email on the Rego tab is refused. A person moved or placed into a
  team is not emailed about it, then or later.

The Email and Rego tabs say at the top that email is off, and opening
the Email tab puts up a notice with a way to the switch.

### Messages and push

Write on the Messages tab. Urgency decides what a message does: silent
appears and nothing more, normal lights the bell, urgent also puts a
pop-up in front of people. The pop-up is for the urgent message that
went up last, so making a live message urgent, or unarchiving an urgent
one, lights the bell and puts it in front of people again. A message
can carry a publish time; the scheduled run puts it up. Posted at does the
opposite: a past time puts the message in the list as of then, with no
bell dot, no pop-up, no push and no Discord post, for filling in what
was said elsewhere. A push needs the Push permission and the
second password; a push to everyone goes out in batches, the first
while you wait and the rest from the scheduled run, so the Push tab can
be closed once it answers.

### Submissions past the review limit

A team at the review limit (Settings → Submissions, 12 by default) has
its next sends queued rather than refused. They join the queue in order
as reviews free places, within a minute. Only a team with 40 already
queued is refused.

### Request limits

A 429 that says "Error 1015" with a Ray ID comes from a Cloudflare rule
in front of the worker, not from the worker. The zone's Security, Events
page names the rule. The album page and the gallery ask for their
thumbnails in batches of up to 24 (`/api/thumbs`), so a fast scroll
through a large album is a request per screenful rather than per
picture, but uploads, the live tab's polling and the dashboard's own
album grid still make one request each. A rate limiting rule meant for
sign-ins or sign-ups is best limited to those paths; one that counts
every request to the worker's hostname will be met by an ordinary
day's browsing.

## After the event

- Settings → After the event: **Team pages** turns every name on the
  live tab into a link to that team's page; **Recap page** opens
  `/recap/`; **Push notifications** off stops every push. Both pages
  answer 404 until switched on, and while the tab is closed.
- Open the tab again when the results are out.
- Take a backup with the photos: `npm run backup -- --photos` in `tab/`
  and `npm run backup` in `checkin/`. D1's Time Travel can also put the
  database back to any minute of the last 30 days (7 on the free plan).
  Backups hold what
  people typed into the sign-up form: keep them off shared drives and
  delete them once the event is wrapped up.
- The old worker hostname (`scs2-tab-bot.andyrew.space`) and the two spare
  tile hosts are no longer used by any code: remove them in Cloudflare.

## Rolling back

- Website: on Netlify, publish an earlier deploy from the Deploys page.
- Workers: `npx wrangler rollback` in the worker's folder.
- A rollback does not undo a migration. For the data, use a backup or
  D1 Time Travel.

## Known errors and their fixes

| Symptom | Fix |
|---|---|
| `worker error: no such column: X — the database is behind the code` | `npm run db:migrate`. If it still says so, follow the steps under ["The database is behind" and it still is after migrating](../tab/README.md#the-database-is-behind-and-it-still-is-after-migrating), starting with `npm run db:check`. |
| `db:migrate` runs clean but a column is still missing | `npm run db:check` says which migration adds it, or writes `wrangler.repair.sql` when none does. `npm run db:schema` cannot add a column. |
| `{"D1_RESET_DO":true}` from `db:migrate` | An older checkout sending files through D1's import API. `git pull` and run it again ([details](../tab/README.md#d1_reset_dotrue-from-npm-run-dbmigrate)). |
| `SQL code did not contain a statement` | An empty command (a shell ate the quotes in `DEFAULT ''`) or two semicolons in a row ([details](../tab/README.md#sql-code-did-not-contain-a-statement)). |
| Uploads fail and nothing else looks wrong | `npm run db:check` first; then the R2 binding, the tables for large uploads, and the queue ceiling ([details](../tab/README.md#uploads-fail-but-nothing-else-looks-wrong)). |
| A feature is missing with no error: no push, no Turnstile, no short links, the encoder answering 503 | `npm run secrets:check`. |
| A worker deployed with no database behind it | It was deployed with `wrangler deploy`. Use `npm run deploy`. |
| A score set on the dashboard shows late on the site | `PUBLIC_API` must name the hostname the site reads on. A purge reaches one data centre; elsewhere a copy lasts up to 10 or 30 seconds. |
| A page left open keeps running old code after a deploy | The commit did not bump `CACHE` in `website/sw.js`. `npm run check` catches it. |
| The check-in worker answers 500 for a second person signed up without a UNSW zID | Its database predates the shared-zID fix: run `checkin/migrations/2026-10-shared-zid.once.sql` by hand after `db:migrate` ([`checkin/CLAUDE.md`](../checkin/CLAUDE.md)). |

## Where to read more

- [`README.md`](../README.md#deploying): the deploy steps in brief.
- [`tab/README.md`](../tab/README.md): [Freezing the tab](../tab/README.md#freezing-the-tab),
  [After the event](../tab/README.md#after-the-event),
  [Backups](../tab/README.md#backups) and
  [Updating the bot once it's live](../tab/README.md#updating-the-bot-once-its-live).
- [`checkin/README.md`](../checkin/README.md): setting up and running
  check-in.
- [`tab/ENCODER.md`](../tab/ENCODER.md): the encoder.
- [`tab/CLAUDE.md`](../tab/CLAUDE.md): "Freezing the tab", "Closing the
  tab", "Saved copies", "Holding every post", "The worker's own clock",
  "Past the review cap: queued, not refused", and
  [Migrations](../tab/CLAUDE.md#migrations).
