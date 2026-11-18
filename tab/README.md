# SCS.2 tab worker

The event tab on Cloudflare Workers: a public read-only API for the
website, a dashboard for organisers, web submissions, push
notifications, team registration and Discord slash commands, all on one
worker with the scores in a D1 database. There is no server to keep
alive.

Commands: `/score`, `/leaderboard`, `/quest`, `/list`, `/submit`,
`/unsubmit`, `/post`, `/verify`, `/help`. Team and quest fields suggest as you
type, from the database.

## What's in this folder

```
schema.sql              the D1 tables (safe to re-run)
seed.sql                test data, generated from the tab exports
data/                   the tab exports (quest tracker + score database)
src/index.ts            the worker: routing, Discord commands, public API, check-in reports
src/shared.ts           helpers every module uses: responses, input cleaning, secrets, R2 streaming
src/console.ts          the dashboard API
src/dash/               the dashboard page: dash.html, dash.css and the script in js/, a file per tab; src/console-page.js puts them into one document
src/discord.ts          servers, /verify, team roles and channels, the dashboard's Discord tab
src/rolemenus.ts        role menus: the dropdown messages members pick their own roles from
src/tab.ts              standings and number formatting shared by the commands and the dashboard
src/quests.ts           the quest list: regions, groups, codes, retire/import, file export/import, /api/questlist
src/messages.ts         organiser messages, the version counters, /api/pulse and /api/messages
src/data/scs2-quests.ts the SCS.2 quest list the dashboard imports; src/data/places.ts the station and Sushi Hub lists
src/submit.ts           web submissions and proof files
src/push.ts, webpush.ts push subscriptions and the Web Push protocol
src/rego.ts, email.ts   team registration and outbound email
src/commands.ts         the slash command definitions
scripts/build-seed.mjs  regenerates seed.sql from data/*.csv
scripts/register.mjs    tells Discord which commands exist
scripts/gen-vapid.mjs   mints a VAPID key pair for push
ENCODER.md              the video encoder organisers run on their own computers on the day (scripts/encoder.mjs and the two launchers beside it)
migrations/             one-off SQL for databases created before a feature (npm run db:migrate)
tests/                  the suites (npm test, npm run test:ui, node tests/verify-*.mjs)
wrangler.toml           worker + D1 + R2 config (no secrets, no per-account edits)
scripts/deploy.mjs      npm run deploy: fills the database id by name, then wrangler deploy
scripts/migrate.mjs     npm run db:migrate: applies the migrations/ the database has not had (-- --all for every one)
scripts/db-check.mjs    npm run db:check: reads the live schema and says what it is missing
scripts/d1-run.mjs      npm run db:schema / db:seed: one .sql file against the live database
scripts/secrets-check.mjs  npm run secrets:check: which secrets the live worker has (names only)
secrets.example.json    every secret the worker takes; copy to secrets.json, npm run secrets
```

The scoring model is the tab's own: every quest has points per unit,
every entry is an amount (1 for a normal completion, 38 for someone's
Make 21 spree, 0.25 for partial credit), and every change to a team's
score is a line on its ledger with the points it was worth when it was
written. A team's total is the sum of those points.

## Setting it up

You need Node 18 or newer, a Cloudflare account, and a Discord server
you manage. Everything below runs from this folder.

### 1. Cloudflare: database and worker

```
npm install
npx wrangler login
npx wrangler d1 create scs-scores
npx wrangler r2 bucket create scs-submissions
npm run db:schema
npm run db:seed
npm run deploy
```

Nothing in `wrangler.toml` needs editing: `npm run deploy` looks the
database up by name on your account, writes the filled-in config to
`wrangler.deploy.toml` (ignored by git) and deploys with that. Deploy
prints your worker URL — something like
`https://scs-tab-bot.<your-subdomain>.workers.dev`. Keep it handy.

Every value that differs between accounts is a secret, set in one go:

```
cp secrets.example.json secrets.json   # ignored by git
# fill in the values you have; leave the rest as they are
npm run secrets
```

`npm run secrets` uploads every key in `secrets.json`. A value left
as its `PASTE …` description counts as unset, so the feature it
unlocks stays locked and nothing breaks. The full list is under
"Secrets" below; the Discord ones come from the next two steps.

### 2. Discord: create the application

1. Go to https://discord.com/developers/applications and create a new
   application.
2. On **General Information**, copy two things: the **Application ID**
   and the **Public Key**.
3. Give the worker the public key: put it in `secrets.json` as
   `DISCORD_PUBLIC_KEY` and run `npm run secrets` (or
   `npx wrangler secret put DISCORD_PUBLIC_KEY` for just this one).
4. Back on **General Information**, set **Interactions Endpoint URL**
   to your worker URL from step 1. Do this *after* the deploy and the
   secret — Discord immediately sends a signed test ping, and only
   saves the URL if the worker answers it correctly.

### 3. Register the commands

On **Bot** in the developer portal, get (or reset) the **Token**. Two
ways to register the commands with it:

- From the dashboard: set the token as a worker secret
  (`npx wrangler secret put DISCORD_BOT_TOKEN`), open the dashboard's
  Discord tab, add your server and click **Register the commands
  here**. Instant, and repeatable after any change to
  `src/commands.ts`.
- From your shell, with the token in the environment only (it is
  never stored anywhere):

  ```
  DISCORD_APPLICATION_ID=<application id> \
  DISCORD_BOT_TOKEN=<token> \
  DISCORD_GUILD_ID=<server id, or several comma-separated> \
  node scripts/register.mjs
  ```

  `DISCORD_GUILD_ID` (right-click your server → Copy Server ID, with
  developer mode on) registers to those servers and shows up
  instantly. Leave it off to register globally, which Discord can
  take up to an hour to roll out.

### 4. Invite it to the server

On **OAuth2 → URL Generator**, tick the `applications.commands` and
`bot` scopes and give the bot these permissions: **Manage Roles**,
**Manage Channels**, **Send Messages**, **View Channels**; add
**Mention Everyone** only if announcements should be able to ping.
Open the generated URL and pick your server. Then, in Server Settings
→ Roles, drag the bot's role above where the team roles will sit (a
bot can only hand out roles below its own).

The commands that only answer work with `applications.commands`
alone; `/post`, `/verify`, team roles and channels and the dashboard's
Discord tab need the `bot` scope and the token (see "Discord servers,
/verify and the dashboard's Discord tab").

Type `/help` in any channel. If Discord suggests it, you're done.

## Secrets

Everything that differs between accounts is a worker secret, never a
file in the repo. `secrets.example.json` lists them all; copy it to
`secrets.json`, fill in what you have, and `npm run secrets` uploads
the lot (`wrangler secret bulk`). Any value left as its `PASTE …`
description counts as unset. To change one later, edit `secrets.json`
and run `npm run secrets` again, or `npx wrangler secret put NAME`.

| Secret | What it is | Where it comes from |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | verifies that interactions really come from Discord | developer portal → General Information |
| `DISCORD_BOT_TOKEN` | posting, `/verify`, team roles and channels, the Discord tab | developer portal → Bot → Token |
| `CONSOLE_PASSWORD` | makes the first dashboard admin, and signs in accounts that have no password of their own yet | choose one |
| `TAB_SYNC_KEY` | the check-in worker's reports of complete teams | `openssl rand -base64 32`; set the same value on the check-in worker |
| `PHONE_SYNC_KEY` | the phone worker's calls and recorded messages (the payphone quest) | `openssl rand -base64 32`; set the same value on the phone worker (`phone/README.md`) |
| `CHECKIN_KEY` | registration minting QR codes | the check-in worker's `REGISTRATION_KEY` |
| `CHECKIN_API` | where the check-in worker answers | its address, `https://…`, no trailing slash |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | push notifications | `npm run vapid` prints both |
| `PUSH_PASSWORD` | the second password, asked for before a push goes out and before any other action an admin ticks | choose one; give it to fewer people than have dashboard accounts |
| `SHEETS_WEBHOOK_URL` | the registrations Google Sheet | the Apps Script web app URL with its `?token=` (see "The live Google Sheet"); leave unset to skip |
| `EMAIL_API_KEY` | Resend, only if the Email Service binding is not set up | resend.com; leave unset otherwise |
| `GUILD_ID`, `ORGANISER_ROLE_ID` | seed the first Discord server before the Discord tab has one | Copy Server ID / Copy Role ID; leave unset once servers are managed from the dashboard |

The bot token is the one real credential: whoever has it can act as
the bot. `wrangler secret put` and `npm run secrets` send it to
Cloudflare over TLS and store nothing locally; `secrets.json` is
ignored by git, so keep it out of chats and screenshots. Discord's
public key and the various ids are identifiers, not credentials;
they are secrets here only so a `git pull` never overwrites them.

The three `[vars]` in `wrangler.toml` (`VAPID_SUBJECT`, `EMAIL_FROM`,
`EMAIL_REPLY_TO`) are plain settings that are the same for every SCS.2
deployment. A secret must not share a name with a var, so keep the
two sets apart.

## Locking down score changes

`/submit`, `/unsubmit`, `/post` and `channel:` are refused by the
worker itself unless both of these hold, checked against the signed
payload Discord sends (so neither server settings nor inviting the bot
elsewhere can get around it):

1. the command came from a server set up in the dashboard's Discord
   tab, and
2. the person running it holds that server's organiser role (OrgComm).

Both are chosen in the dashboard, per server. The `GUILD_ID` and
`ORGANISER_ROLE_ID` secrets still work: they seed the first server
when the dashboard has none, so an older setup keeps its lock. They do
it once: a server removed on the dashboard does not come back from them.
Until a server has an organiser role chosen, score changes there stay
locked and the bot says so.

Two Discord-side settings back this up: per-command role permissions
(Server Settings → Integrations) tidy up who even sees the commands,
and turning off **Public Bot** (developer portal → Bot) stops
strangers adding the app to their own servers at all.

## Discord servers, /verify and the dashboard's Discord tab

Everything here needs the bot token as a worker secret
(`npx wrangler secret put DISCORD_BOT_TOKEN`) and the invite from
step 4. Without the token the tab says so and the commands that only
answer keep working.

**Servers.** The Discord tab lists the servers the bot is in. Add one
(pick it from the list, or type its id), choose its organiser role
(a role called OrgCom is picked by default when there is one), name
the category team channels go under (Private Channels by default),
pick the channel new messages are cross-posted to (or leave it at
"No cross-posting"), and save. The bot works in as many servers as
you add; each has its
own organiser role and its own team roles and channels. Pause a
server to stop verification and score changes there without
forgetting it; remove it to forget it (roles and channels already in
Discord are left alone).

**`/verify`.** A member runs it in the server. The bot finds their
Discord username on a signup (the username, never the display name,
which anybody can set to somebody else's username; `@` and case do
not matter), makes sure their team has a role named
after the team and a text channel named after the team under the
category (visible only to that role, the organiser role and the bot),
gives them the role, and tells them, in a message only they see. A
username on no signup is told to register or ask an organiser to add
it in the Rego tab. Role names are the team name as typed (tidied to
Discord's limits); channel names are what Discord allows, so "Loco
Motive!" gets `#loco-motive`. Renaming a team in the Rego or Teams
tab renames its role and channel too.

**Set up teams and give out roles** makes every team's role and
channel, then looks up each person's Discord username in the server
and gives them their team role, the way `/verify` would. It goes one
team at a time and says how far it has got; at the end it lists the
usernames it could not find in the server, which are people who have
not joined yet or typed their username wrong on the form. Running it
again makes nothing that exists, and a run cut off part way carries
on from where it stopped, because each role and channel is recorded
the moment Discord makes it. Discord's rate limits are waited out
rather than reported as failures. The teams table shows each team's
role and channel per server and how many of its members have the
role, with a per-team **Set up** button that does the same for one
team.

**Give every member a role** goes through everyone in the server: a
member with no role yet gets their team's role when their Discord
username is on a team's signup, or Unknown Team when it is not, and
Legend either way. **Recheck Unknown Team** is for later, once more
people have signed up or been put in teams: it moves members still on
Unknown Team (or with no role) to their team's role and touches nobody
else. Both need the bot's Server Members Intent.

**Find leftover roles and channels** lists roles and channels the bot
made that no team uses: a role with a team's name and no permissions
of its own, or a channel in the team category with the topic the bot
gives team channels. Runs from before the bot recorded each role as
it was made could leave a second role for a team this way. Nothing is
deleted until **Delete these** is pressed under the list.

**Role menus** are messages the bot posts with a dropdown, from which
members give themselves roles: a name colour, pronouns, a ping for
announcements. Make one on the Discord tab: a title, whether members
pick one role or any number, the words above the dropdown, and the
roles it offers, each with the label shown in the dropdown. **Make
role** makes a new role with a colour, and **Add the line colours**
makes a colour role for each of the site's nine line colours (or uses
ones already called that) and adds them. **Save and post** posts it to
a channel; changing a posted menu edits the message in place. Picking a
role in a pick-one menu takes off the menu's other role, and None takes
it off. The bot can only give out roles below its own role in Server
Settings → Roles, and saving a menu says which roles it cannot give.

**Reviews, points and check-ins** are posted in the team's own
channel: the quest, the points it was worth and the team's new total,
or the reason it was rejected, and a link to each file, which Discord
shows as the picture or video. Points an organiser records on the
Points tab or with `/submit` are posted the same way, and points taken
back or set by hand say how many came off or went on. Each check-in at
the door is a line too ("**Alice Park** checked in (2 of 3).", and
"The whole team is here" with the last one), which needs `TAB_API` and
`TAB_SYNC_KEY` on the check-in worker (see Check-in reports). While the
tab is frozen the total is left out. Each server's card has a **Posted
in team channels** setting to turn all of this off there. A team with
no channel on a server gets nothing on that server, and a hidden team
gets nothing anywhere.

**Submit codes** on the Discord tab posts each team's submit code in
its own channel, mentioning the team's role, with the code on a line of
its own and a button to the submit page. Send it to every team with a
channel or tick the ones to send to; a team without a code yet is given
one first. Nobody but the team's role is pinged.

**A team's role and channel by hand.** **Edit** in a team's cell of
the teams table picks its role and its channel from the server's own
lists. The bot still refuses anything it would never give a team —
@everyone, the organiser role, Legend, Unknown Team, a bot's role, a
role with staff permissions, or another team's role or channel. With
both picked, the team's setup runs straight away so the channel lets
the role in, and a new role is given to everyone on the team who is in
the server; anyone holding the old one keeps it until somebody takes
it off. Picking none forgets that one, and the next setup makes a new
one.

**Send a message** posts as the bot into any channel it can see,
mentions as typed, the same as `/post` without opening Discord.
**Post the top 10** posts the leaderboard. **Register the commands
here** does what `scripts/register.mjs` does, per server.

Everything is logged (`discord-verify`, `discord-setup`,
`discord-post`, …). `node tests/verify-discord.mjs` covers it all
against a pretend Discord.

## Posting into channels

Two organiser features make the bot speak in channels of your
choosing rather than just answering where it was asked:

- **`/post channel message`** — the bot posts your message in that
  channel. The input box is one line, so write `\n` wherever you want
  a line break. Your @mentions go through as typed (subject to the
  bot's permissions in that channel), so an announcement can ping if
  the bot is allowed to.
- **`channel:` on the read commands** — `/score`, `/leaderboard`,
  `/quest` and `/list` all take an optional `channel:`. The answer is
  posted there — a fresh `/leaderboard channel:#leaderboard` into the
  pinned leaderboard channel, say — and you get a quiet confirmation
  only you can see. Output sent this way never pings anyone.

Both run through the same organiser guard as `/submit`: they work
only from your server, only for the organiser role. They also need
two things the basic setup skips, both one-off:

1. The bot token as a worker secret:
   `npx wrangler secret put DISCORD_BOT_TOKEN` (paste the token from
   the **Bot** page). Until it is set, both features refuse and say
   so; everything else works without it.
2. The invite to include the `bot` scope with **Send Messages** (see
   step 4). Without it Discord answers 403, which the bot passes on
   in plain words.

Replying where a command was run needs no credentials — that is why
the rest of the bot never needed the token. Writing into an arbitrary
channel is a plain REST call to Discord, and that call is what the
secret is for.

## The dashboard

`/dash` on the worker is the dashboard: where the tab team manages
the data from a page instead of Discord commands, with every change
logged. It works on a phone (the tabs fold behind a Menu button) and
shows times in the device's own time zone.

Reloading comes back to the tab you were on rather than to Scores,
which matters on the day because the page gets reloaded constantly.
The tab is in the address too — `/dash#rego` — so you can bookmark one
or send someone a link to it instead of describing where to click. An
address naming a tab that does not exist opens the last one you used.

Twelve tabs. Each one is a job done on the day, with that job at the
top; everything set once and then left is on **Settings**.

- **Scores** — the day board across the top (below) and the public
  tab's freeze.
- **Points** — points for a team, recorded the way a team sends proof
  in: pick the team and the quest, tick the codes to credit, fill in
  what the quest asks (a count, a line, places from its list), an
  amount, a note, and up to four photos or videos if there are any.
  Each one is saved as a submission that is already accepted, so it
  shows in Review, posts in the team's Discord channel and leaves a row
  behind every point. **Recorded** lists what organisers have put in,
  newest first, with **Take back** on each for the wrong team or the
  wrong quest. **Set an amount by hand** is the old table: pick a team,
  see every quest with its amount, set or clear one directly. Fractions
  are partial credit, counts above one are repeatables, exactly like
  `/submit`; a change made there is recorded as the difference it
  makes. `/submit` and `/unsubmit` in Discord are recorded the same
  way.
- **Review** — web submissions with their media, the quest's name and
  the team's answer (a count, a line, the places or the codes they
  picked). Tick the codes to credit, set an amount, accept; or reject
  with a reason the team sees — on their own submissions list and in
  the notification that tells them. The filter shows pending,
  accepted, rejected, or all of them. Opening a submission takes it in
  your name; anyone else's dashboard then says "Being reviewed by
  …" on that card. It is advice, not a lock — their Accept and Reject
  still work — and it lapses after ten minutes. A team that already
  has points on the quest is said so above the buttons, so a second
  acceptance is a decision rather than a slip.
- **Quests** — the one quest list the tab, the website and the submit
  page all read (see "The quest list" below). Every field of a quest
  is editable in place; codes rename with their tab entries; delete
  asks for the quest's code typed back and says how many entries go.
  Each card says who can see the quest and changes it in place (see
  "Who can see a quest" below). Quests under a tag hidden from the
  dashboard, such as Old, stay out of the list until **Show hidden
  tags** is on.
- **Teams** — add, rename, hide, delete, and mint submit codes.
  Deleting asks for the team's exact name typed back, and takes its
  tab entries with it. **Hide hidden teams everywhere** (on by
  default, remembered per browser) keeps hidden teams out of every
  tab: this table, the score picker, Review, Rego and Discord.
- **Messages** — write the announcements the site's messages page
  shows (see "Messages" below). **Post message** puts one up, **Save
  as draft** keeps it off the site.
- **Push** — send a notification to everyone, one team, or one
  device, and name the devices so the list means something.
- **Rego** — whether sign-ups are open, with a button to their
  settings, then a summary of the sign-ups, the way a form shows its
  responses: totals for teams, people, checked in and photo
  permission, and under **Breakdown** a bar per answer for societies
  (every society, picked or not), team size, Arc membership, photo
  permission, dietary requirements and check-in. The bars are counted from the
  same registrations listed below them — the Google Sheet is filled
  from these rows (each signup appends and each edit resyncs it), so
  the summary is the sheet's data without reading the sheet back.
  Under it, every team with its people beneath it, each marked
  checked in or not (read live from the check-in worker with the
  registration key). **Edit** opens the fields: team name (renames
  the tab team and its Discord role and channel), societies, photo
  permission, questions, and every person's name, zID, email, Discord
  username, dietary and Arc. Add a person to a team (they get a QR
  code and a confirmation email like the form would have sent),
  remove one, or register a whole team with **New team**, skipping
  the public form. Each person carries **Open QR** and **Open
  ticket** links and a **Send email** button, which makes their code
  first and only sends once there is one. When the code cannot be
  made, nothing is emailed: the row says why and offers to send it
  anyway — once — and **Create QR code** retries the code on its own.
  CSV export and sheet resync as before; the sheet is rewritten in
  the background after every edit.
- **Files** — upload a file with nothing attached to it (a poster, a
  map, a schedule) and get a link to hand out, and make the short
  links that live on `go.scs.andyrew.space` (see "Files and short
  links" below).
- **Discord** — the servers the bot works in, each with its
  organiser role, team-channel category and the channel new messages
  are cross-posted to; send a message or the top 10 as the bot;
  register the commands; set up every team's role and channel; who
  has run `/verify`.
- **Settings** — one card each, with a contents line across the top:
  **Sign-ups** (open or closed, the cap, the four rate limits),
  **Submissions** (how many a team may have waiting on review), **Home
  page** (the countdown and the slideshow), **After the event** (team
  pages and the recap), **Email** (**Stop sending email**, which keeps
  every email back until it is unticked, and the confirmation email
  tests),
  **Organisers** (who is set up, resetting someone whose phone is
  gone, new backup codes, and every sign-in attempt with the name
  typed and a hash of the address, so a run of guesses stands out) and
  **Tools**: **Export everything** downloads one JSON file of every
  table — scores, quests, submissions, messages, registrations and the
  log; push subscriptions are counted rather than copied (an endpoint
  and its keys are enough to send notifications to that phone) and
  sign-in sessions are left out — **Rebuild photo copies**, and the two
  version counters.
- **Log** — the submission log, newest first, including who did what
  from the dashboard (`console:<name>`, the name given at sign-in).

An existing database needs `npm run db:migrate` once for the review
claims, the message publish time and the question deadline
(`migrations/2026-10-day-ops.sql`); a fresh one has them from
`schema.sql`.

**The day board.** The row of numbers at the top of the Scores tab,
read again whenever that tab is opened: what is waiting on review and
how long the oldest has waited, submissions this hour against the hour
before, how many people have checked in of those registered (asked of
the check-in worker; it says so plainly when that worker is not
answering), teams and how many are hidden, subscribed devices,
encoders online with the videos still waiting on them, and whether the
public tab is frozen or live.

Setup is one secret: `npx wrangler secret put CONSOLE_PASSWORD`, then
`npm run db:schema` once and deploy. Until the secret is set the
dashboard refuses to sign anyone in. The first person to sign in, with
any name and that password, becomes the first admin and sets up a code
on the spot. Sessions last 18 hours and are checked server-side on
every call; the page never holds the password.
Dashboard writes purge the API cache, so the live tab and quest pages
update straight away, and Discord commands keep working beside it.

**Accounts.** An admin makes everybody else's account on the Accounts
tab: a name, a password, the tabs it may use (or Admin, which is every
tab and the Accounts tab), and whether it needs a code from an
authenticator app. Tabs an account cannot use are not shown to it, and
the worker refuses their requests whatever the page does. Accounts from
before this keep signing in with the shared password until an admin
gives them one of their own.

**Accounts for one quest.** Untick **Every quest** on an account and
tick the quests it may score: it then records points, sets amounts and
reviews submissions for those quests and no others. For the people out
at a main quest across the city, give an account the Points tab alone
and that one quest. It signs in on a phone to a page with the Add
points form and nothing else, offered only that quest.

**An account that needs a code** is shown a QR the first time it signs
in — Google Authenticator, 1Password, Authy, anything that does TOTP —
and typing the first code it gives finishes the setup and prints ten
backup codes. Print those and keep them somewhere that is not the
phone: each one works once and they are the way in if the phone is
dead, lost or at home. If somebody loses theirs entirely, an admin
resets their code from the Accounts tab and they set a new one up on
their next sign-in. Give every account that can change scores a code.

**The second password** (`PUSH_PASSWORD`) is asked for before a push
goes out, and before any other action an admin ticks on the Accounts
tab: sending an email announcement, freezing the tab, deleting a team
or a submission, exporting everything, changing an account and a few
more. The dashboard asks for it in a box over the page when it is
needed.

Wrong passwords and wrong codes are throttled per address: three are
free, then the wait doubles from five seconds up to a quarter of an
hour. It is never worker-wide, so nobody can lock the committee out by
guessing at the dashboard from a phone in the street.

If `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are set — the same pair
the sign-up form uses — Cloudflare's human check appears on the
dashboard sign-in as well. It only has to *pass* once something from
that address has been refused: a first, correct sign-in never depends
on it, so a venue that cannot reach Cloudflare cannot keep you out.

One thing to know about the order: a deploy lands before
`npm run db:migrate` runs, and the tables behind the codes are added by
a migration. In that window the password alone signs you in and the
dashboard says so; run the migration and the codes come back on by
themselves.

Tests live in `tests/`: `npm test` runs the API suite against sqlite
(Node 22+), `npm run test:ui` drives the page in a headless Chromium
(needs `playwright` installed, plus a Chromium at CHROMIUM_PATH or
playwright's own). The other `verify-*` files cover the quest list,
submissions, messages, push, registration, Discord and the site pages
the same way; `verify-ops.mjs` covers what only matters on the day —
the team score sheet, rejection reasons, review claims, the day board,
scheduled messages, question deadlines and the export.

## The quest list

Quests live in D1, in three tables. `quest_regions` is the list of
regions (the site's categories) in display order. `quest_groups` is a
quest as the site shows it: code (its key), name, region, description in
markdown (`**bold**`, `__underline__`, `*italic*`, `- lists`,
links), the italic flavour line, the location text, the map pins, an
order, a hidden flag, and the answer box the submit page shows.
`quests` is the tab's rows: one code per thing that scores, each in a
group with a label ("15–19 stations", "Public transport bonus") and
its points. A quest with one code has the same code as its group;
tiers and bonuses hang off it as `SQ1-10`, `SQ1-B` and so on. Case
and spaces in a code never matter; hyphens do (`SQ2-3` is not
`SQ23`).

The site reads it all from `GET /api/questlist` (public, CORS-open,
cached 30 seconds, purged on every console write): the regions in
order, every visible group with its visible codes, and the station
and Sushi Hub lists the answer boxes draw on. The quest page and the
submit page keep the last good copy in the browser, so both keep
working offline.

Answer boxes (the Quests tab's "Answer box" field):

- `none` — proof only.
- `count` — a number ("How many stations?").
- `text` — a short line ("Which Mount suburbs?").
- `pick` — one or more from a list. Options are one per line;
  `@stations` and `@sushi` stand for the built-in lists in
  `src/data/places.ts`. The station quest and the Sushi Hub quest use
  these.
- `codes` — a rocker per code of the quest, for quests where a team
  claims several parts at once (the Macquaries, the outfit bonuses).

The answer is stored with the submission as JSON and shown in the
Review tab; for `codes` the review pre-ticks what the team claimed.

**Mystery points.** Tick "Mystery points" under a quest's codes in its
editor and the site shows ??? wherever that quest's points would be:
the list, the quest sheet, the full list, the submit page and a quest
card in a message. The worker still holds the real points and scores
them as usual, so the tab and every total are right; the public and
team quest lists simply leave the figure out. A team that is credited
for the quest sees what it earned on its score sheet and in its
channel, as it would for any other. Needs `npm run db:migrate`
(`2026-10-mystery.sql`); before that the box saves nothing and says so.

### Regions

The Regions panel in the dashboard's Quests tab lists every region with its quest
count. Rename one and every quest in it follows; reorder with the
arrows (the site shows regions in this order); add an empty one to
fill later; delete one and choose where its quests go (another
region, or no region at all). A quest's region is a pick list in its
editor, with "No region" allowed: those quests sit last on the site
under "Other quests". A region named in a file import is created if
it does not exist. Each region also takes one of the site's line
colours from the select beside its name: the quest sheet's route disc
and the rule along its top are drawn in it. A region left alone is
red, as they all were before (`npm run db:migrate` adds the column,
`2026-10-region-colours.sql`).

### Export and import files

**Export CSV** downloads one row per quest: `code, name, region,
description, flavour, location, pins, answer, prompt, options, order,
hidden, codes`. Cells that hold several lines (pins as `Label @ lat,
lng`, options, and codes as `code | label | points`, with `| hidden`
on a hidden code) are quoted, so a spreadsheet opens and saves the
file as is. **Export JSON** is the same data as a lossless copy, with
the region order included.

**Import a file** takes either format back. The preview lists every
row as add, update (naming the fields that change), same, or error
(missing code or name, a code that belongs to another quest, a quest
listed twice). Nothing is written at preview; a file with any error
row is refused whole. Import matches quests by code and codes by
code: fields are replaced, codes are added or updated, and nothing is
ever deleted by an import. Delete from the editor instead.

### Moving to the SCS.2 list

The tab that shipped with this repo carries the old quest codes. To
move to the SCS.2 list without losing what was scored:

```
npm run db:migrate     # the files in migrations/ this database has not had, oldest first
npm run deploy
```

Then in the dashboard's Quests tab: **Retire current quests** (type
RETIRE) gives every code on the tab a `-o` suffix and hides it; the
scores stay and the leaderboard does not move. **Import the SCS.2
list** loads `src/data/scs2-quests.ts`, skipping anything already
there, so it is safe to run again. The retired codes stay visible in
a team's score sheet while the team holds an entry on them, and the
retired quests go under the Old tag, which the Quests tab shows only
with **Show hidden tags** on.

### Who can see a quest

Every quest is shown to one of four audiences, set on its card or in
its editor:

- **Everyone** — on the website for anybody, signed in or not.
- **Signed-in teams** — any team signed in on the submit page with its
  submit code. Hand a team its code early and it can see these before
  the day.
- **Team groups** — only the teams in the groups picked. Groups are
  made on the Teams tab.
- **Organisers only** — on the dashboard and nowhere else. A new quest
  starts here.

A quest a team cannot see is one it cannot send proof for, answer the
question on, or find in the Discord bot's suggestions. The leaderboard
still names the last quest each team scored, whoever can see it.

**Opens to everyone at** puts a time on a quest: at that time it goes
to everyone, whatever it was set to. Nobody has to be watching; the
worker checks every minute.

**Tags** group quests so they can be opened together. The Tags panel
on the Quests tab opens every quest under a tag now, at a time, or
sets who can see them all at once. A tag can be hidden from the
dashboard, which keeps its quests out of the list there; that is what
the Old tag is for.

**Open everything now** (type OPEN) gives every quest to everyone
except the ones under a hidden tag and the ones with an opening time
still to come.

The quests that were hidden before this existed were filed under Old
by `npm run db:migrate`.

### Quests run live: files and questions

A quest can carry files and ask every team a question. Both are set
per quest and neither is touched by anything else that writes a quest:
an ordinary save, a rename, a file import — the files and the question
stay as they were.

**Files** are pictures and PDFs, up to eight per quest at 25MB each,
kept in the same R2 bucket as proof files under a `qst/` prefix. They
ride on the quest list (`files: [{key, name, type, bytes}]`) and are
read at `GET /api/quests/file?key=…`, `&thumb=1` for the small copy
where the dashboard made one. The key is the capability, the same as
proof files and message attachments, and responses are cached forever.

**A question** is one of four kinds, plus a prompt, up to eight option
labels, and whether it is taking answers right now:

- `choice` — buttons. Every team presses one (red or blue, yes or no).
- `number` — a number nobody else sees, for a sealed bid.
- `wager` — an option and a stake: pick a side and put points on it.
- `text` — a typed answer, for "name the place in this photograph".
  The answers carry the moment each team last changed theirs, which is
  how a first-correct-answer quest is judged.

The question rides on the quest list too (`ask: {kind, prompt,
options, open, open_until}`, or `null` for a quest that asks nothing),
and the site reads and writes it at `/api/quest/ask`. Answering needs
the team's submit session, one answer per team, changeable while the
question is open and refused once it is closed.

**Closes at** puts a deadline on it, in your own time zone and stored
as UTC. Nothing runs when the time passes and nothing is written: a
question counts as open when the switch is on *and* the deadline is
either empty or still ahead, worked out on every read, so the quest
list, the sheet and the responses table can never disagree about it.
Clearing the time opens it again.

Settling a wager credits every team at once: whoever picked the
winning option gains what they staked and everyone else loses it, on
the quest's first visible code. The amount written is the stake
divided by what that code is worth, so the standings move by exactly
the points staked whatever the code's points are — a code worth 0
points is refused rather than silently losing the wager. The question
closes as it settles, and the whole thing is one transaction: either
every team is settled or none is. It lands in the log as `ask-settle`.

## Messages

The Messages tab is where organisers write what the site's messages
page shows. A message is a title, a body in markdown (the toolbar over
the box does bold, italic, headings, lists, links and code, and
Preview shows it the way the site will), and up to six files at 25MB
each: pictures, PDFs and documents. Pictures get a small copy made in
the browser before upload, so the lists load quickly; everything is
served from `/api/messages/file?key=…`, where the random half of the
key is what makes the file reachable, exactly as with proof files.

Three switches decide what a new message does beyond appearing:

- **Urgency** — silent puts it on the page and nothing else; normal
  moves the messages counter, which is what marks the bell in the app;
  urgent moves the counter and names itself in `/api/pulse`, so the
  site holds it in front of people until they dismiss it. Default
  normal.
- **Send as push** — a notification to every subscribed device, title
  and the first line or so of the body, opening `/messages/`. It needs
  the push password, the same second lock the Push tab uses, and it is
  checked before anything is written: a refused push means the message
  was not posted either.
- **Post to Discord** — on by default for a new message. Every enabled
  server with an announcement channel set on the Discord tab gets the
  title in bold, the body and a link per attachment. It goes out after
  the save has answered, so Discord never holds up the dashboard, and
  a refusal is written to the log rather than losing the message.
  Edits are not posted again.

**Publish at** holds a message back until a time you set, shown in
your own time zone and stored as UTC. At that time it goes up on its
own and moves the counter, within about a minute: the site asking and
the worker's own once-a-minute run both publish it. A message that
publishes itself sends no notification and is not posted to Discord,
so the push and Discord ticks go away while a time is set; post it by
hand if it needs either. Leave the time empty to post now.

**Save as draft** keeps a message saved, off the site and announcing
nothing, and the counter does not move. Editing a draft, **Post
message** puts it up, which is when the counter moves, since that is
when anyone can read it; editing a live one, **Move to drafts** takes
it back off. A published message can be **archived**: it leaves the site and
the tab's main list for the archived view, and can come back. **Up** and **Down**
set the order the site shows them in; a message posted afterwards
lands on top. Deleting asks for the title typed back and takes the
attachments with it.

**Counters.** The Settings tab's Tools card shows the two numbers the site
polls at `/api/pulse`: `quests`, moved by every accepted quest write,
and `messages`, moved by every new message that is not silent. They
say only that something changed, so a phone can ask often. Both go
forward on their own; setting one by hand is for putting a number back
after a mistake, which makes every page fetch again.

Everything here is logged — `message-post`, `message-edit`,
`message-archive`, `message-unarchive`, `message-order`,
`message-delete`, `message-discord`, `message-publish` (the actor is
`schedule`), `counter-set` — and purges the API cache.
`node tests/verify-messages.mjs` covers the lot, and
`node tests/verify-ops.mjs` the scheduled ones.

The tables (`messages`, `message_files`, `counters`) and the Discord
announcement column come from `schema.sql` on a fresh database, and
from `migrations/2026-09-messages.sql` on an existing one:
`npm run db:migrate`.

## Files and short links

The **Files** tab does two jobs that turn out to be one.

The **drop** is a file uploaded with nothing attached to it — not a
submission, not a message attachment. A poster, a route map, the
running order. It goes into the same R2 bucket under a random `drop/`
key and comes back with a link anyone holding it can open. Up to 90MB,
which is as much as one request carries; a photo has its metadata
taken out on the way through exactly like every other picture the
worker serves. Deleting a file takes every short link pointing at it,
because a link left answering 404 under a name somebody has already
shared is worse than the name being free again.

The **short links** live on their own hostname: `go.scs.andyrew.space`
in `SHORT_HOST`, pointed at this worker as a custom domain in
Cloudflare. On that hostname nothing else exists — no API, no
dashboard — so it answers before any other route. A link either goes
to an address, in which case it redirects, or it points at a file in
the drop, in which case **it serves the file's bytes at that address**
rather than bouncing to another one.

That last part is the whole reason the two features are one tab.
Discord, Slack and the rest work out whether a link is a picture from
the URL's shape alone, and a redirect is one more hop for an unfurler
to follow and one more way for an embed to fail. So the file answers
in place, and the link name can end in the file's own extension:
`go.scs.andyrew.space/poster.png` reads as a picture, embeds as one,
and is short enough to say out loud. Both spellings resolve either
way — save it as `poster` and `/poster.png` still works, save it as
`poster.png` and `/poster` still works — so nobody has to remember
which way it was written down.

Names are lower case and may hold letters, numbers, dots, dashes and
underscores. Anything that would shadow the worker (`api`, `dash`,
`console`, `admin`, …) is refused, a name already taken answers 409
rather than quietly taking it over, and renaming a link frees the old
name. Every link counts how often it has been opened, and every
upload, delete and save is in the log like any other dashboard write.

An existing database needs `npm run db:migrate` once for the two
tables (`migrations/2026-10-drop.sql`); a fresh one has them from
`schema.sql`. With `SHORT_HOST` unset the short links are simply off
and the rest of the worker does not notice.

## Email announcements

The dashboard's **Email** tab sends an announcement to every registered
participant, or to one team. Each person gets their own copy with only
their address on it: there is no Bcc, so nobody can see who else it went
to. An address registered twice gets one copy, and hidden teams are left
out of a send to everyone.

Write the message as text (the same Markdown the messages use, with the
toolbar) or switch to HTML and paste your own. Scripts, frames and
`javascript:` links are taken out of HTML before it is sent. The preview
under the box is the email as it will arrive, in the same layout as the
confirmation email. **Send a test** to one address first; it arrives
with "[Test]" in front of the subject. **Send** takes two taps and says
how many people it will reach before the second.

The first twenty go out straight away. The rest go out while the page is
open, and the worker's own clock carries on at fifty a minute if it is
closed. The Sent list shows each send's progress, with **Stop** for one
still going and **Try the failed ones again** for one that finished with
failures.

It uses the same email service as the confirmation email, so it is off
until that is set up. An existing database needs `npm run db:migrate`
once for the two tables (`migrations/2026-10-announce.sql`); a fresh one
has them from `schema.sql`.

## Freezing the tab

Partway through the day the public tab is usually stopped, so the last
stretch is played blind. **Scores → Freeze the tab** does it: two taps,
the first arming and the second firing, so it cannot happen by accident
mid-event.

Frozen, the leaderboard, the per-quest counts and the headline stats
are all served exactly as they stood at that moment — to the website,
to the quest page's "N of M teams" line, and to the Discord `/leaderboard`
and `/score` commands. `/quest` and `/list` stop answering until the
freeze lifts, because whether a team holds a quest is live progress.

The freeze is a copy rather than a filter: turning it on renders those
payloads once and stores them, and every frozen read serves the stored
copy. While the freeze is on, nothing asks the live tables the public's
questions at all, so there is no query for a team to tilt. Organisers
are unaffected — scoring carries on as normal, the dashboard shows the
real tab throughout, and organisers in Discord still get live answers.

Messages are not frozen. `/api/pulse` and `/api/messages` answer live
throughout, so organisers can still tell everyone something while the
standings are stopped — the freeze is about the scores, not about
talking to people.

The live tab page ices over while it is on: frost grows in from the
edges, snow falls, icicles hang off the top bar, and the line under
the title says when the standings stopped.

Unfreezing publishes everything scored during the freeze at once.

**Closing the tab** (Close the tab, two taps as well) goes further: the
leaderboard, the quest counts and the stats answer that the tab is
closed and nothing else. The live tab page shows a sign saying so, the
submit page's score section says scores are hidden, the four Discord
read commands say the tab is closed, the after-the-event team pages and
recap stay shut, and the posts in team channels leave the total out.
Closing sits on top of a freeze: open the tab again and the public sees
the frozen copy, or the live tab if it was not frozen.

**Saved standings.** Every freeze keeps its copy, and the scheduled run
keeps one at the top of each hour once teams have scored, skipping an
hour in which nothing moved; **Save the standings now** keeps one by
hand. The card lists them newest first. Pick one, or step with
**Earlier** and **Later**, to see the board as it stood and what
changed since the copy before it, hour by hour. **Freeze the tab with
this** puts a copy up as the frozen tab, dated when it was taken, which
is how an unfreeze by mistake is undone: freeze with the copy taken at
the freeze. The newest 240 hourly copies are kept; the others stay
until deleted. Needs `npm run db:migrate` (`2026-10-tab-copies.sql`).

## After the event

The leaderboard is a race while the day runs, so two things stay
closed until you open them from **Settings → After the event**:

- **Team pages on the site** turns every name on the live tab into a
  link to that team's own page: its place and points, every quest it
  did grouped by region with when each was recorded, its submissions
  by hour, the proof it sent and when it checked in.
- **Recap page on the site** opens `/recap/`, the day in numbers:
  submissions by hour with the accepted part marked, the hour each
  quest was most often done and by how many teams, the quests most
  and rarely done and the ones nobody did, the top of the tab, the
  busiest senders, points by region, how long verdicts took, the
  proof sent, arrivals and the live questions asked. The live tab
  links to it once it is open.

Both switches take effect on the site at once and both are logged.
Closed, the two reads behind them (`/api/team` and `/api/recap`)
answer 404, so nothing can be read early. Hidden teams are left out
of every number. The table behind the switches is `site_flags`;
databases made before it need `migrations/2026-10-recap.sql`.

## Web submissions

Teams can send proof from the site's `/submit` page instead of
Discord. The flow end to end:

1. **Codes.** In the dashboard's Teams tab, mint submit codes (one
   readable eight-character code per team) and hand them out privately
   with the team packs. A team signs in on the site with its name plus
   the code; that's the whole credential, exchanged server-side for a
   24-hour session.
2. **Upload.** `POST /api/submit/create` takes a multipart form —
   quest code, optional note, up to 4 photos/videos. Files up to 48MB
   ride the request itself (90MB per request); bigger files, up to
   4GB, are registered in the same call and their bytes follow in
   20MB slices (`PUT /api/submit/upload/part`, then `finish`). The
   submission reaches the Review tab the moment create returns — a
   large file shows as "still uploading" until its last slice lands —
   and a broken upload picks up where it stopped: the worker keeps the
   slices it has (`upload/status` lists them) and the page asks for
   the same file again after a reload. Past 500MB the site suggests
   the compress page first; discarding an unfinished upload
   (`upload/abort`) removes the file, and the submission too when that
   file was all it had. Files land in the `scs-submissions` R2 bucket
   under random keys; rows land in `submissions`/`submission_files`
   (large uploads add `submission_upload_parts` — older databases need
   `npm run db:migrate` once).
   The page also sends a small browser-made preview per file — a
   photo downscaled to 480px, or a frame grabbed from a video — which
   lands beside the original as `<key>.t`. The worker itself cannot
   resize images, so the sender's phone does the work once, and every
   later view of a grid loads kilobytes instead of megabytes
   (`?thumb=1` on the file endpoints, falling back to the full file
   for older uploads). Tapping any proof opens the full file in a
   preview over the page rather than a new tab. A team with 12
   submissions already pending is asked to wait.
3. **Review.** The dashboard's Review tab lists pending submissions with
   the media inline (files stream through the worker with Range
   support, so videos scrub; the bucket itself stays private). Accept
   adds the given amount onto the team's tab entry — 1 for a normal
   completion, fractions for partial credit, exactly like `/submit` —
   and Reject records a reason the team sees on the site and in the
   notification it gets. Both land in the submission log, and both let
   go of whoever had claimed the card.

Teams also read where they stand from the same session:
`GET /api/submit/score` answers their place, their total, every entry
behind it and how many of their submissions are still waiting. It goes
quiet while the tab is frozen — see "Freezing the tab".

Teams also see their own proof as thumbnails in the submit page's
list, and each submission has a gallery switch: a checkbox at upload
plus a per-row rocker afterwards. Anything a team has switched on
*and* the tab team has accepted shows on the site's `/gallery/` page.

Reading that page takes a sign-in — any team's submit session, or an
organiser's dashboard session. The listing is what hands out file
keys, so gating it is what keeps the whole set of proof from being
collected by anyone who finds the address; the files themselves stay
reachable by their keys, which is what lets a team share a single
one. The response is never cached at the edge. Files are fetched by
their R2 keys — the random half of a key is 96 bits, so holding a
file's URL is what grants access to it, and only the owning team (and
the gallery, for opted-in proof) is ever handed one.

The gallery also runs the closing ceremony: **Start slideshow** puts
every photo and video up one at a time in a random order, each in a
paper frame with its quest and team on a signage plate underneath.
Settings on the screen set how long a photo holds, how many seconds
of each video to show, and what speed to play them at; they are kept
on the device. Arrows step, space pauses, Escape leaves, and a file
that will not play is skipped rather than stalling the room.

Setup: `npx wrangler r2 bucket create scs-submissions`,
`npm run db:schema` to add the tables, deploy. A database created
before the gallery switch existed needs one extra command (also noted
in schema.sql):

```
npx wrangler d1 execute scs-scores --remote --command \
  "ALTER TABLE submissions ADD COLUMN gallery INTEGER NOT NULL DEFAULT 0"
```

Files stay in the bucket until someone deletes them (R2 storage is
about $0.015 per GB-month). Add a lifecycle delete rule in the
dashboard if you want auto-cleanup. Without the bucket bound, uploads
refuse and everything else keeps working. Tests:
`node tests/verify-submit.mjs` covers the worker end to end,
`node tests/verify-submit-page.cjs` drives the site page.

### Uploads straight to R2 (optional)

By default every file passes through the worker on its way to the
bucket. That works, but one worker instance has 128MB of memory for all
the uploads it is serving at once, and Cloudflare caps a single request
at 100MB, which is why big files are cut into slices. With an R2 API
token, files go straight to R2 instead: the worker signs an address for
each 20MB slice, the slices go to R2, and the worker joins them at the
end and checks the file. No file passes through the worker, so neither
limit applies. Every upload works this way once the token is set: the
submit page, the album page, the dashboard (message attachments, quest
files, slideshow pictures, the Files tab's drop, photos on points,
album uploads) and the video encoder, which also reads its sources from
R2 directly (ENCODER.md).

1. **Make a token.** Cloudflare dashboard → R2 → Manage API tokens →
   Create API token. Permission **Object Read & Write**, applied to the
   `scs-submissions` bucket only. Copy the **Access Key ID** and the
   **Secret Access Key** (the secret is shown once). Your account ID is
   on the R2 overview page, and is the first part of the S3 address it
   shows, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
2. **Give the worker the three values.** In `secrets.json`, fill in
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, then
   `npm run secrets` and `npm run secrets:check`. The bucket's name is
   `R2_BUCKET` in `wrangler.toml`; keep it the same as `bucket_name`.
3. **Let browsers send to the bucket.** R2 → `scs-submissions` →
   Settings → CORS policy → Add, and paste:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["PUT"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Any origin is fine here: an upload can only go to an address the
   worker signed, for one slice of one file, for fifteen minutes. CORS
   only decides which web pages a browser lets send it, and `*` lets
   deploy previews and the dashboard work too. To limit it anyway, list
   `https://scs.andyrew.space`, `https://dashboard.scs.andyrew.space`
   and the preview addresses you use instead. The encoder is not a
   browser and needs no CORS.
4. **Migrate and deploy** (`npm run db:migrate`, then `npm run deploy`).
   The migration adds the table the dashboard's uploads wait in
   between being sent and being saved; until it has run, the dashboard
   sends its files with its saves as before. The pages ask the worker
   (`upload/mode`) when they load and send straight to R2 from then on.
5. **Try it on a deploy preview** before anyone relies on it (see
   below). If something is wrong, delete one of the three secrets
   (`npx wrangler secret delete R2_SECRET_ACCESS_KEY`) and every page
   goes back to sending through the worker.

A file that is not finished keeps its slices in R2 until the upload is
finished or abandoned. R2 drops unfinished uploads on its own after a
while, so one left behind by a closed page does not stay for good. A
dashboard file sent and never saved (the save was abandoned) is deleted
by the worker's scheduled run a day later.

**Trying it.** Use a hidden test team so nothing shows publicly, and
keep the browser's developer tools open on the Network tab: a slice
shows as a `PUT` to `<ACCOUNT_ID>.r2.cloudflarestorage.com`, and the
request to the worker carries no file. `npx wrangler tail` shows
`upload/sign` where it used to show `upload/part`.

- A photo of a few MB and a video over 100MB on the submit page, from a
  phone. For a large test video, `ffmpeg -f lavfi -i
  testsrc=size=1920x1080:rate=30 -t 600 -c:v libx264 -b:v 8M big.mp4`
  makes a real one of about 600MB.
- Start a large one, turn on flight mode half way, come back, sign in
  and pick the same file when asked: only the missing slices go again.
- A text file renamed to `.jpg`: refused once it lands, and nothing is
  left in Review.
- An album open to anyone, from a phone that is not signed in.
- On the dashboard: a message with a photo and a PDF, a quest's file,
  a slideshow picture, a dropped file over 90MB (the old limit) and a
  replacement for it (the address keeps working and serves the new
  file), points with a photo, and an album upload.
- Run the encoder on a video sent this way; the Review card lists the
  sizes it made.

`node tests/verify-direct.mjs`, `node tests/verify-staged.mjs` and
`node tests/verify-console-direct.cjs` cover this side: the signature
against AWS's published examples, and whole uploads against a pretend
R2 that checks every signature with the backup script's separate copy.

### Hiding test teams

Every team row in the dashboard's Teams tab has a **Hide** button.
Hidden teams keep everything — scores, submissions, codes, their
name stays reserved — but vanish from every public read: the
leaderboard, the quest "N of M teams" counts (numerator and
denominator), stats, the gallery, and Discord lookups. The console
shows them greyed with a "(hidden)" mark, and **Show** restores them
everywhere. That is the switch for test runs on event day: nothing to
save or delete, and a hidden team can keep scoring while hidden. Both
directions land in the log as `team-hide` / `team-show`.

**A group of test teams at once.** Put them in a team group (the
Access tab) and press **Hide these teams** on the group; **Show these
teams** brings them back.

**Test signups without a team.** In the Rego tab's Without a team
box, tick the signups and press **Hide**. A hidden signup is off the
public sign-up count and out of email announcements, and it leaves the
Rego tab's list and counts while **Hide hidden teams everywhere** is
on (turn the switch off to see it again and **Show** it). Once the
people on it are put in a team, the team's own Hide is the one that
counts. Both directions are logged as `rego-hide` / `rego-show`.

The two flags are columns a live database gets from
`npm run db:migrate` (`teams.hidden` and `registrations.hidden`).

### Teams that did not finish

Every team row in the Teams tab also has **DNF**. A team marked that
way stays on the leaderboard where its points put it, but with a dash
for its place and a `*` after its points, and the teams under it move
up a place: 100, 90 (DNF) and 80 read 1, –, 2. A line under the board
says what the `*` means. Discord's `/leaderboard` and `/score`, the
team's own score sheet, its team page and the recap's top teams all
follow. **Finished** on the same row undoes it. Both are logged, as
`team-dnf` / `team-finish`. A live database needs `npm run db:migrate`
for the column (`migrations/2026-10-team-dnf.sql`); before that the
button says so and the tab shows every team as finished.

## Team registration (`/rego`)

One person signs the whole team up at `scs.andyrew.space/rego`: team
name, three to five members with zIDs, emails, Arc membership, dietary
needs and Discord usernames, the societies question and photo
permission. Each person accepts the terms and waiver themselves, from
the link in their own email. People without a team sign up on their
own or as a pair, with no team name; the dashboard's **Rego** tab lists
them under **Without a team**, and ticking them there puts them into a
new team or one with room, and emails them which. One accepted signup
does everything at once:

1. the team is created on the tab (not for a signup without one),
2. every person is recorded (the dashboard's **Rego** tab shows it all,
   with a dietary tally for the BBQ order),
3. each member is registered with the check-in worker and gets a
   personal QR code,
4. each member gets a confirmation email carrying their QR and a
   link to their ticket page on the site (`/ticket/?<blob>`, one
   base64url blob packing the check-in token's raw bytes with their
   name and team; the page draws the QR itself from the token, so the
   link is short, nothing is fetched and it works offline; older
   links that carried the image's file name still load it through
   this worker's `GET /api/ticket/qr?k=`), and
5. the rows land in the organisers' Google Sheet, live, like a form.

The endpoint is public, so it checks everything itself: all fields
are re-validated server-side, a honeypot field catches bots,
per-connection and global hourly rate limits stop floods, duplicate
zIDs are refused with the team they already belong to (z0000000, the
not-a-UNSW-student marker, may repeat), and team names are checked
against the tab. Registrations land in the log as `team-register`.

### What the confirmation looks like

The same signage as the site: the five-route stripe along the top and
bottom, then the title animation's last frame as a header — routes on
white with interchange markers over them and the black
destination sign with the S C S 2 discs — then the team, date and
place as label-over-value rows, and the check-in code in a paper frame
with a name plate under it.

The header is drawn in table cells, not fetched as a picture, so it
needs nothing hosted and it still draws when a client blocks images,
which most do until the reader says otherwise. One thing does not come
across: the 45 degree doglegs. A diagonal in email is either a picture
or a CSS transform and Outlook has neither, so every route in the
header runs straight.

If you want the exact map instead, with the doglegs, open
`marketing/title-animation/route-lines.html`, turn **Cinematic
v2** on and press **Save PNG** — that writes the frame the piece ends
on. Upload it in the **Files** tab and paste the link into the test
card's picture box. It will look right, and it will be a blank box for
anyone whose client blocks images until they ask for them. That is the
whole trade.

It is built in `src/email-html.ts` — tables, inline styles and literal
hex, because that is the HTML an email client will render. It also
asks not to be inverted in dark mode: Apple Mail and iOS otherwise
turn the whole message inside out, and an inverted page is a
grey nobody chose. In Outlook the square corners and the drop
shadow go, which the design survives.

### Testing it before a real team gets one

The Settings tab's Email card, under **Test the confirmation email**,
sends three things, all to an address you type:

- **Send plain test** — one bare message, and the report says which
  way it went out and whether inboxes will show the sender's name.
- **Send the ticket email** — the real confirmation, built by the same
  code a team's is, with the name and team from the two boxes above.
  Its code is a demo one the check-in worker draws on the spot and
  stores nowhere, so a test send does not put a person on the check-in
  board that nobody can take off again.
- **Send it with a header** — the same email with a picture across the
  top, in place of the drawn header. Use it to try the exact map (see
  above) or any other picture. It has to be `https://` — an `http://`
  one is blocked as mixed content and shows as a broken box.

Every test send is logged as `email-test` with which kind it was.

### Setup

**1. Email (Cloudflare Email Service).** Sends go out through the
native `send_email` Workers binding — no third party, no API key. The
binding (`EMAIL`) is already declared in `wrangler.toml`; the one-time
setup is in the dashboard:

- **Compute → Email Service → Email Sending → Onboard Domain**, pick
  the domain (it must be on Cloudflare DNS, which it is). Cloudflare
  adds the SPF/DKIM/DMARC and bounce records to the zone itself;
  usually live within minutes.
- `EMAIL_FROM` and `EMAIL_REPLY_TO` sit in `wrangler.toml [vars]` —
  From is the unmonitored address, and Reply-To means hitting reply
  in any mail client fills in `westsocunsw@gmail.com` even though the
  message never came from it. If the binding ever refuses the
  reply_to field, the worker retries the send without it — and the
  routing rule below forwards replies to the same inbox regardless,
  so nothing is lost either way.
- To also *receive* anything sent directly to `tab@scs.andyrew.space`:
  the zone → Email → Email Routing → add it as a custom address
  forwarding to the org gmail.

Fallback: a Resend API key set as the `EMAIL_API_KEY` secret is used
when the account has no `EMAIL` binding (delete the `[[send_email]]`
block to force it). With neither configured, registration still
works — emails are marked `skipped` and the dashboard can resend them
once sending exists.

**2. Check-in QRs.** The tab worker calls the check-in worker
server-to-server:

- `CHECKIN_API` = the check-in worker's URL.
- `CHECKIN_KEY` = the same value as the check-in worker's
  `REGISTRATION_KEY`.

Both are secrets (`secrets.json`, `npm run secrets`).

Unset, registration still works and codes can be made later from the
dashboard: each person's **Create QR code**, or **Send email**, which
makes the code first and sends only once there is one. A person whose
code cannot be made is never emailed a confirmation with no ticket in
it unless an organiser answers the question on their row, and then
only once.

**3. Tables**: `npm run db:schema` (adds `registrations` and
`participants`).

**4. Deploy** the worker, and ship the site (the `/rego` page).

### Keeping spam out

The form defends itself in layers, all enforced in the worker so
calling the API directly skips none of them: a honeypot field, at
most 4 signups an hour per connection and 15 an hour overall, zIDs
that can only register once, and confirmation emails capped at 3 a
day to any one address and 60 an hour overall. A capped email is
recorded as skipped and can be resent from the Rego tab, so a real
one is delayed, never lost.

Two more layers are yours to switch on:

- **The human check.** Make a Cloudflare Turnstile widget (Cloudflare
  dashboard, Turnstile) for the site's domain and put its two keys in
  `secrets.json` as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`, then
  `npm run secrets`. With both set the rego page shows the widget and
  the worker verifies every signup with Cloudflare; with either unset
  the check stands down. If Cloudflare's verify service is
  unreachable the signup is let through rather than blocked.
- **The Sign-ups card** on the Settings tab: a Registrations open switch
  and a cap. With a cap set the form closes itself once that many
  people are signed up (hidden test teams do not take spots) and
  shows "Registrations are full." Clear or raise the cap to reopen.
  The switch closes it by hand either way.

When signups spike (10 in an hour), the hourly cap trips, or a
signup fills the cap, the bot posts one line to every enabled
server's announce channel, at most one alert an hour.

### The live Google Sheet

A small Apps Script web app owned by your Google account appends rows
as they arrive. The sheet stays private: nothing is shared, and the
worker only knows one unguessable, token-carrying URL, kept as a
secret.

1. Make a Google Sheet. The script writes to a tab called
   `Registrations`, and makes it if it is not there.
2. Extensions → Apps Script, paste:

```js
var TOKEN = 'pick-a-long-random-string';
var TAB = 'Registrations';

function doPost(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) {
    return ContentService.createTextOutput('no');
  }
  // two sign-ups at once must not write over each other's rows
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = book.getSheetByName(TAB) || book.insertSheet(TAB);
    var width = body.header.length;
    var rows = body.rows || [];
    if (body.mode === 'replace') {
      sheet.clearContents();
      rows = [body.header].concat(rows);
    } else if (sheet.getLastRow() === 0) {
      rows = [body.header].concat(rows);
    }
    // every row exactly as wide as the header, written in one go
    rows = rows.map(function (row) {
      var out = row.slice(0, width).map(function (v) { return v == null ? '' : v; });
      while (out.length < width) out.push('');
      return out;
    });
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    }
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}
```

3. Deploy → New deployment → Web app → execute as **Me**, access
   **Anyone** (the token is what actually gates it — wrong token,
   nothing happens). Changing the script later needs Deploy → Manage
   deployments → edit → a new version, or the web app keeps running
   the old one.
4. `npx wrangler secret put SHEETS_WEBHOOK_URL` with the web-app URL
   plus the token, e.g.
   `https://script.google.com/macros/s/…/exec?token=pick-a-long-random-string`

New registrations append within seconds. The worker only counts a
push as sent when the script answers `ok` (Apps Script returns HTTP
200 even when it refuses). The dashboard's **Resync Google Sheet**
button rewrites the whole sheet from the database: run it after
configuring the webhook late, after the webhook has been failing, or if
the sheet has been edited by hand. When it fails it says why: the
token does not match, Google wants a sign-in (access is not Anyone),
the script crashed (with its error), nothing is deployed at that
address, or the script was too slow.

An earlier version of this script wrote one row at a time with
`appendRow`, so a resync got slower with every person signed up and
could run past what Google or the worker will wait for. If the sheet
stopped syncing as sign-ups grew, paste the script above over the old
one and deploy a new version. **Export CSV** downloads everything (QR links and email
statuses included) without Google in the loop.

Everything in those rows was typed into a public form, and a
spreadsheet reads a cell starting `=`, `+`, `-` or `@` as a formula.
The worker puts an apostrophe in front of any such value before it
goes to the sheet or the CSV, which makes it text (Google Sheets hides
the apostrophe; Excel shows it).

## Push notifications

Organiser announcements to lock screens: people turn
**Notifications** on in the site's settings menu, and the tab team
sends from the dashboard's **Push** tab. Standard Web Push, no Apple
developer account, no Firebase; the worker implements the protocol
itself (VAPID JWTs and RFC 8291 payload encryption on WebCrypto,
since the Node `web-push` library can't run on Workers).

Where it works:

- **Android / Chrome / Edge / Firefox** — any visit, installed or not.
- **iPhone / iPad (iOS 16.4+)** — only inside the installed app
  (Share → Add to Home Screen). The settings rocker knows: in plain
  Safari it shows the install hint instead of a broken prompt. If
  someone deletes the icon, their subscription dies with it — the
  next send prunes it automatically.
- **Desktop Safari 16+** — works from the browser.

### Setting it up

1. **Generate a VAPID key pair** (once): `npm run vapid`. Put both
   halves in `secrets.json` as `VAPID_PUBLIC_KEY` and
   `VAPID_PRIVATE_KEY` and run `npm run secrets` (the public half is
   not really a secret, every browser sees it, but keeping it there
   means a `git pull` never overwrites it). Generating a *new* pair
   later invalidates every existing subscription, so keep this one.
2. **Set the push password**: `PUSH_PASSWORD` in `secrets.json`.
   This is deliberately a *second* lock — sending requires a signed-in
   console session *and* this password on every send, so give it to
   fewer people than the dashboard password.
3. **Add the table**: `npm run db:schema` (creates `push_subs`).
4. **Deploy**: `npm run deploy`. The site side ships with the website
   (the settings rocker, and the service worker's push handlers).

Secrets set with `wrangler secret put` live on the worker in
Cloudflare and survive every deploy. You only re-enter one to change
it.

### Sending

Console → **Push** tab: title (80 chars), message (300), an optional
link that opens on tap (e.g. `/questlist/`), a tier, and the push
password. Two tiers: an **Announcement** buzzes at high urgency; a
**Quiet update** rides the low-urgency lane, replaces the previous
update on screen instead of stacking, and never makes a sound.
Same-tier messages a phone missed while offline collapse to the
latest one.

**Who it goes to** is the row above the password: everyone, one team,
or one device. A team or a device goes out in one go and finishes
before the page answers; everyone goes out in batches with a cursor
and the page loops until it is done. Sending to one device is how you
see what an announcement actually looks like on a phone before
everybody gets it — and a send that is not to everybody leaves the
boxes filled, because it is usually a draft about to go out for real.

The Messages tab can send one too, with the message it belongs to:
tick **Send as push** there and the notification goes out as an
announcement pointing at `/messages/`, using the same password. The
save takes the first batch itself, so an urgent message is on most
phones before the page answers, and leaves the rest for the worker's
own clock to finish a batch a minute.

Teams also get their own lane: when a signed-in team opens the submit
page, its device is linked to the team, and a **rejected submission
pushes to just that team** with the quest code and reason; a tap opens
the submit page. Acceptances don't push (they are already on the tab).
Dead subscriptions are pruned as they are found. Every send lands in
the log as `push-send` with the title, the counts and who it was aimed
at.

### The device list

Under the compose box, every subscribed device, with a **Send here**
button and a name you can edit.

What a subscription actually is: an address belonging to that phone's
push service and two encryption keys. That is all the worker holds,
and none of it leaves the worker — those three values are enough to
send a notification to that phone, which is why subscriptions are the
one thing left out of **Export everything**. So the list shows only
what can safely be said: the name, the push service, the team the
device linked itself to, and when it subscribed.

The **service** is the company carrying the notification, read off the
address — Apple, Google, Mozilla. It is not the same thing as the
device: Safari on a Mac and Safari on an iPhone both go through Apple,
and Chrome on Windows and Chrome on Android both through Google. That
is why the site sends a name with each subscription — the browser's own
guess, like "iPhone app" or "Android Chrome". Rename it to something
you will recognise; a rename is never written over the next time that
device re-posts its subscription.

Devices leave the list on their own once their push service says they
are gone, which is what happens when someone deletes the installed app
or turns notifications off.

An existing database needs `npm run db:migrate` once for the name
column (`migrations/2026-10-push-devices.sql`); without it everything
still works, the names are just always blank.

Keep messages rare. Every push shows a visible notification (iOS
revokes subscriptions that stay silent), and people who get too many
turn notifications off.

### How the pieces fit

- `src/webpush.ts` — the protocol: `encryptPayload` (ECDH + HKDF +
  AES-128-GCM in aes128gcm framing) and `vapidAuth` (ES256 JWT per
  push-service origin).
- `src/push.ts` — public API: `GET /api/push/vapid` hands the site
  the public key, `POST /api/push/subscribe` / `unsubscribe` maintain
  `push_subs` (endpoint-deduped, shape-checked, capped).
- `console.ts` — `push/stats` and `push/send` (session + password,
  batch cursor).
- Site: the rocker in every page's settings menu (`assets/site-app.js`,
  through `scs.pushSub` in `assets/site.js`),
  and `push`/`notificationclick` handlers in `sw.js`.
- `tests/verify-push.mjs` proves the crypto end to end: it plays the
  browser with Node's own crypto, decrypts a captured push and
  verifies the VAPID signature independently.
  `tests/verify-sw-push.cjs` covers the service worker's half.

### Deploy previews and other origins

Push is tied to the exact origin someone subscribed from, and the site
is fully relative — manifest `start_url`, `scope` and every link — so
it works unchanged on a Netlify deploy preview
(`deploy-preview-N--scs-website.netlify.app`), a branch deploy, or the
live domain. Links in a notification are resolved against the
registration's own scope, so typing `/questlist/` in the dashboard
reaches the quest list on whichever deployment the reader installed;
avoid typing full `https://` links, which would send everyone to one
origin.

Two consequences:

- **A subscription belongs to one origin.** Someone who subscribed on
  preview 1 is not subscribed on the live site, and vice versa. Moving
  origins means everyone re-subscribes.
- **Previews are temporary.** When the pull request closes, Netlify
  takes its preview down and every subscription made there is dead
  (the next send prunes them). Use previews to test push; onboard real
  teams only once the site is on the address it will keep.

## The submission log

Every accepted `/submit` and `/unsubmit` is appended to the
`submission_log` table: timestamp, action, team, quest, points moved,
the team's total before and after, and the Discord username that ran
it. Nothing reads it on the hot path — it exists for checking the log
when a score looks off, and for day-of analysis. A few useful queries:

```
# the last 20 changes
npx wrangler d1 execute scs-scores --remote --command \
  "SELECT at, action, team_name, quest_code, points_delta, old_total, new_total, actor FROM submission_log ORDER BY id DESC LIMIT 20"

# submissions per hour
npx wrangler d1 execute scs-scores --remote --command \
  "SELECT strftime('%Y-%m-%d %H:00', at) AS hour, COUNT(*) AS n FROM submission_log WHERE action='submit' GROUP BY hour ORDER BY hour"
```

The same per-hour numbers come out of `GET /api/stats` for anything
that wants to chart them. If you added the log to an already-created
database, run `npm run db:schema` once — it only adds what's missing
and touches no data.

## The HTTP API

The same worker also answers plain GET requests, reading the same
database the commands do. The website uses these; anything else may
too — they are public, read-only JSON with open CORS, cached at the
edge for 30 seconds (the leaderboard and the stats for 10):

- `GET /api/leaderboard` — every team, best first, each with the quest
  it last had scored (`null` until a team has scored something; `name`
  falls back to the code for a quest with no group):
  `{ "teams": [{ "rank": 1, "name": "…", "points": 7287, "quests_done": 21, "last_quest": { "code": "SQ18", "name": "The Snout", "at": "2026-10-20 01:26:00" } }, …] }`
- `GET /api/quests` — completion counts per code, plus per quest
  (teams holding any of its codes):
  `{ "total_teams": 43, "quests": [{ "code": "SQ1-10", "group": "SQ1", "points": 100, "teams_done": 7 }, …], "groups": { "SQ1": 9, … } }`
- `GET /api/questlist` — the quest list itself, see "The quest list".
- `GET /api/stats` — the headline numbers, how many submissions are
  still waiting on review, plus bot submissions per hour:
  `{ "total_teams": 43, "total_completions": 681, "total_points": 123456, "submissions_pending": 29, "submissions_by_hour": [{ "hour": "2026-08-02T04:00Z", "submissions": 12 }, …] }`
- `GET /api/pulse` — the two version numbers, whether something is
  urgent, and the two after-the-event switches:
  `{ "quests": 12, "messages": 4, "urgent": 37, "team_pages": false, "recap": false }`.
  `urgent` is the id of the newest message marked urgent that is
  actually on the site, or 0. This is the call the site makes on a
  timer; a number bigger than the one it last saw is its cue to fetch
  again, and the two flags are how the leaderboard learns that names
  are links and that the recap exists.
- `GET /api/messages` — the messages themselves, in the order to show
  them (drafts and archived ones left out):
  `{ "messages": [{ "id": 37, "title": "…", "body": "…markdown…", "created_at": "2026-10-20 09:15:00", "urgency": "normal", "files": [{ "key": "msg/…", "name": "map.png", "type": "image/png", "bytes": 20481 }] }, …] }`
- `GET /api/messages/file?key=…` — one attachment, `&thumb=1` for the
  small copy where there is one. The key is the capability, so a
  shared link keeps working; responses are cached forever.
- `GET /api/slides` — the pictures the home page runs as a slideshow,
  in the order it plays them:
  `{ "ok": true, "slides": [{ "key": "slide/…", "name": "quad.jpg", "alt": "Teams waiting in the quad", "caption": "Before the start" }, …] }`.
  With no pictures set it answers `{ "ok": true, "slides": [] }` and
  the home page has no slideshow on it.
- `GET /api/slides/file?key=…` — one of those pictures, `&thumb=1` for
  the small copy. Same key-is-the-capability rule, cached forever, and
  what it serves is the copy with the metadata taken out.
- `GET /api/quests/file?key=…` — a file hung on a quest, `&thumb=1`
  for the small copy. Same key-is-the-capability rule, cached forever.
- `GET /api/quest/ask?quest=SQ41` — what that quest is asking:
  `{ "kind": "choice", "prompt": "…", "options": ["Red", "Blue"], "open": true, "response": null }`,
  or `{ "kind": "" }` for a quest that asks nothing. The quest is
  named by its key or any of its codes. Sent with a team's submit
  session (`Authorization: Bearer …`), `response` is that team's own
  answer, `{ "choice": "Red", "amount": 0 }` or null. Never cached.
- `POST /api/quest/ask` — the team's answer:
  `{ "quest": "SQ41", "choice": "Red", "amount": 30 }` with a team
  session. One answer per team, changeable while the question is open
  (409 once it is closed).
- `GET /api/team?name=…` — one team's day, once **Team pages on the
  site** is on (404 before that, and for a hidden or unknown team):
  `{ "ok": true, "team": "…", "rank": 4, "teams": 43, "total": 4167, "quests_done": 21, "lines": [{ "code": "SQ18", "group_key": "SQ18", "name": "The Snout", "label": "", "region": "Exploration Region", "amount": 1, "points": 25, "worth": 25, "at": "2026-10-20 01:26:00" }, …], "submissions": { "sent": 12, "accepted": 9, "rejected": 2, "pending": 1 }, "first_at": "…", "last_at": "…", "by_hour": [{ "hour": "2026-10-20 01:00", "sent": 2, "accepted": 2 }, …], "files": { "photos": 9, "videos": 3, "bytes": 91200000 }, "checked_in_at": "…" }`
  — the quests in the order they were recorded, every hour from the
  first submission to the last. Never cached.
- `GET /api/recap` — the day in numbers, once **Recap page on the
  site** is on (404 before that): the headline counts, submissions
  by hour with the busiest hour named, how long verdicts took,
  `quests_by_time` (each quest, how many teams did it and the hour it
  was most often done — from accepted submissions, or from when the
  completion was recorded for quests scored on Discord alone),
  `most_done`, `least_done`, `never_done`, `regions`, `top_teams`,
  `most_active`, `biggest_score`, `points_spread`, `files`,
  `checkins` and `asks`. Hours are UTC stamps like
  `"2026-10-20 03:00"`; the site shows them in the reader's zone.
  Hidden teams are left out of everything. Never cached.
- `GET /api/rego/status` — whether the registration form is taking
  signups: `{ "ok": true, "open": true, "message": "", "turnstile": "" }`.
  Closed by hand or full against the cap, `open` is false and
  `message` says which; `turnstile` carries the Turnstile site key
  while the human check is on. Never cached.
- `GET /api/submit/score` — a team's own score sheet, with its submit
  session and no one else's:
  `{ "ok": true, "frozen": false, "team": "…", "rank": 4, "teams": 43, "total": 4167, "lines": [{ "code": "SQ1-10", "group_key": "SQ1", "name": "Wondabyne", "amount": 1, "points": 100, "worth": 100 }, …], "pending": 2 }`
  — every entry it holds, biggest first, plus how many submissions are
  still waiting on a reviewer. A hidden team reads its own sheet with
  `rank: null`. While the tab is frozen this answers
  `{ "ok": true, "frozen": true }` and nothing else: a team's place is
  exactly what the freeze hides. Never cached.

Responses are served through the Cache API: each one lives at the edge
for 30 seconds (the leaderboard and the stats for 10), and any write
that changes them, from Discord or the dashboard, purges them at once
in the data centre that took the write. (On a bare `workers.dev` address the Cache API is a no-op —
the custom domain is what makes it real.) `/api/pulse` and
`/api/messages` are the two public reads the tab freeze does not
touch: they answer live whether the tab is stopped or not.

The quest page reads `/api/questlist` for the quests themselves and
`/api/quests` for "N of M teams have this on the tab" inside each
quest panel. If you rename the worker or move it to a custom domain,
update `TAB_API` in `assets/site.js`.

## Check-in reports

The check-in worker (`/checkin` — its own worker, database and
README) tells this one about each check-in, and when a team has fully
arrived:

- `POST /api/team-checkin` — body
  `{ "team_name": "…", "completed_at": "2026-08-15 09:10:00", "people": 4,
  "checked_in": 4, "person": "Alice Park", "event": "in" }`, guarded
  by `Authorization: Bearer <TAB_SYNC_KEY>`, sent on every check-in
  and every undo (`event` `out`). A null `completed_at` retracts the
  row (an undo on the check-in side broke the team's "everyone is
  here"). Rows land in the `team_checkins` table and surface in
  `/api/stats` as `team_checkins`, which is where organisers read the
  times when handing out on-time points via the normal `/submit` flow.
  The person's line goes in the team's Discord channel.

To enable it, set the same key on both workers
(`npx wrangler secret put TAB_SYNC_KEY` here and in `/checkin`) and
re-run `npm run db:schema` here once to add the table. Until the key
is set, the endpoint refuses everything.

## Backups

```
npm run backup                # the database, as one SQL file
npm run backup -- --photos    # and every photo, video and file in the bucket
```

Both write into `backups/` in this folder, which git ignores. The
database is a dated file (`scs-scores-2026-10-20T0315Z.sql`): every
table, schema and rows, made by `wrangler d1 export`. To look inside one,
load it into a local database:
`npx wrangler d1 execute scs-scores --local --file=backups/<file>.sql`.

`--photos` also mirrors the `scs-submissions` bucket into
`backups/files/scs-submissions/`: proof, message attachments, quest
files, slides and the drop, each under its key. A file already there at
the same size is skipped, so later runs only fetch what is new, and a
run that is cut off can simply be run again. Wrangler cannot list a
bucket, so this needs an R2 API token:

1. Cloudflare dashboard → R2 → Manage API tokens → Create API token,
   with **Object Read only** on `scs-submissions`.
2. Copy `backup.example.json` to `backup.json` and fill in the account
   id and the token's Access Key ID and Secret Access Key. (Or set
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the
   environment.)

**When to take one**: before sign-ups close, the night before the event,
around lunchtime on the day, after the event and once review is done —
and before any `npm run db:migrate` or reseed. The photos matter most
on the evening of the day and at the end.

The live database also has Cloudflare's Time Travel, always on: any
minute of the last 30 days (7 on the free plan) can be put back with
`npx wrangler d1 time-travel restore scs-scores --timestamp=<time>`.
That is the quicker undo for a bad write; the backup is the copy that is
not in Cloudflare.

The backups hold everything people typed into the sign-up form. Keep
them off shared drives and delete them once the event is wrapped up.

## Updating the bot once it's live

Day-to-day changes are one command each, and nothing you set up
earlier needs redoing — secrets, the database and the Discord wiring
all stay put across deploys:

- **Changed worker code** (anything in `src/`): `npm run deploy`.
  Takes effect within seconds. If the change added a table or column,
  run `npm run db:migrate` first; the worker answers with a readable
  error naming the missing column or table if you forget.
- **Changed the commands themselves** (`src/commands.ts` — names,
  descriptions, options): deploy as above, then run
  `scripts/register.mjs` again the same way as during setup, with the
  token in your shell. Guild-registered commands update instantly.
- **Watching it run**: `npx wrangler tail` streams live logs while you
  use the commands in Discord — the quickest way to see why something
  answered oddly.
- **Backing out a bad deploy**: `npx wrangler rollback` returns to the
  previous version.

Always deploy with `npm run deploy`, not `npx wrangler deploy`
directly: the committed `wrangler.toml` carries a placeholder
`database_id`, and only the script fills it in from your account.
Deploying the raw file gives you a worker with no database behind it.

### Migrations

`npm run db:migrate` applies everything in `migrations/`, oldest
first. It is safe to run again — running it is the normal way to catch
a database up, not a last resort:

- It writes `wrangler.deploy.toml` first, because plain
  `wrangler d1 execute` reads the committed placeholder id and fails
  saying it is not a uuid, which reads like a missing database.
- A file that is already applied is reported as such and passed over.
  SQLite has no `ADD COLUMN IF NOT EXISTS`, so an ALTER that has
  already run comes back as an error ("duplicate column name"); that
  is expected and not a problem.
- A file that is only *partly* applied is retried a statement at a
  time, so the statements after the one that was already there still
  land.
- Anything else stops the run and prints the error in full, naming the
  file and the statement. Nothing after that file has been applied, so
  fix the cause and run it again.

A database created from `schema.sql` today needs none of the files;
the runner will say so and do nothing.

A file named `*.once.sql` is the exception and is **listed, not run**.
Those rebuild a table — copy the rows out, drop it, create it again,
copy them back — because SQLite has no `DROP CONSTRAINT` and a
constraint written into a `CREATE TABLE` cannot be changed any other
way. Nothing in SQL like that can say it has already been done, so a
loop would redo the whole thing on every run. `db:migrate` prints the
names at the end and leaves them to a person; `npm run db:check` says
whether one is still needed. There are none here — the check-in worker
has the only one.

The check-in worker has the same four commands over its own database,
from the same scripts: `checkin/scripts/` is a copy of this folder's,
kept identical on purpose (the check-in worker is a separate package
and cannot import from here), and `tests/verify-migrations.mjs` in
both fails if the copies drift.

### "The database is behind" and it still is after migrating

The worker turns any `no such column` / `no such table` into

```
worker error: no such column: X — the database is behind the code:
run npm run db:migrate in tab
```

That is the right advice almost every time. When it is not, the symptom
is confusing in a specific way: `npm run db:migrate` runs clean, says
nothing was left to do, and the site says the same thing as before.
Work through it in this order.

**1. Ask the database what it actually has.**

```
npm run db:check
```

It reads the live schema, compares it with `schema.sql` — tables,
columns, indexes and the column constraints — and for anything missing
says **which migration would add it**. That is the part that tells you
what to do next: a gap with a migration beside it means `npm run
db:migrate` has not got that far, and a gap with "no migration adds
this" means nobody wrote one. It only reads — nothing is altered
without you running it. If it comes back clean, the database is fine
and it is the **worker** that is behind: `npm run deploy`.

The last two of the four fail silently, which is why they are checked
at all. A missing index breaks nothing: every query still answers, a
plain one just reads the whole table, and a `UNIQUE` one has stopped
refusing the duplicate it was put there to refuse. A leftover column
constraint is the same in reverse — the table is still refusing rows
the code expects to insert, and the only symptom is the worker
answering 500 on an insert that looks fine.

**`npm run db:migrate` stops at the first real error and says which
file.** If it has failed, everything after that file is unapplied, so
the list `db:check` gives you is the tail of the migration list rather
than a set of separate problems. Read the **top** of the migrate output,
not the end.

**2. If it names a missing table** — `npm run db:schema`. That file is
all `CREATE TABLE IF NOT EXISTS`, so it adds what is missing and leaves
everything else alone.

**3. If it names a missing column**, know that neither standard command
can necessarily fix it:

- `npm run db:schema` **cannot**. Re-running a `CREATE TABLE IF NOT
  EXISTS` over a table that already exists does nothing at all — it
  does not compare columns. This is the part that catches people out,
  because the command looks like it should work and exits successfully.
- `npm run db:migrate` fixes it **only if a file in `migrations/` adds
  that column**. If nobody wrote one, there is nothing to apply and the
  runner correctly reports that it had nothing to do.

If `db:check` says a migration exists, run `npm run db:migrate` and read
its first error. If it says none does, `db:check` has written the SQL to
`wrangler.repair.sql` for you to run:

```
npx wrangler d1 execute scs-scores --remote \
  --config wrangler.deploy.toml --file=wrangler.repair.sql
```

It writes a file rather than printing something to paste because the SQL
contains `DEFAULT ''`, and several shells eat those two quotes, leaving
wrangler with an empty command.

### `{"D1_RESET_DO":true}` from `npm run db:migrate`

D1 undoing a file that failed, rather than saying why it failed. An older
`db:migrate` sent each migration with `--file`, which on `--remote` is
D1's import API: the database stops answering queries while it runs and
is reset to where it was when anything in the file fails — and an
already-applied `ALTER` counts. Usually the answer still carried the
SQLite error; sometimes it carried only the reset, and the run stopped
there. Nothing from that file was applied, so nothing needs undoing:
`git pull` and run `npm run db:migrate` again. It now sends each
migration with `--command`, the ordinary query path, so the site keeps
working while it runs.

### `SQL code did not contain a statement`

D1 saying it was handed SQL with nothing in it. With `--remote` wrangler
does not split the file — it uploads it whole and D1 splits it server
side, and that parser rejects an empty statement instead of ignoring it.
Two ways to get one:

- **An empty `--command`**, usually a shell eating the quotes in
  `DEFAULT ''`. Put the SQL in a file and use `--file` instead.
- **Two semicolons in a row in the file.** `npm run db:migrate` used to
  do this to every migration, and it is fixed — if you are seeing it
  from `db:migrate`, you are on an older checkout; `git pull`.

Then write the migration, so the next database does not need anyone to
do this by hand. `npm test` enforces it: it builds a database the way a
real one was built and fails if anything in `schema.sql` cannot be
reached from `migrations/`.

**4. If it names a missing index** — `npm run db:schema`. This is the
one repair that command *can* make to a table that already exists:
`CREATE INDEX IF NOT EXISTS` on a live table is a real statement doing
real work, unlike `CREATE TABLE IF NOT EXISTS`, which does nothing.
An index that is there but indexes something else is reported
separately; an index can be dropped freely, so `DROP INDEX <name>` then
`npm run db:schema` puts the right one back.

**5. If it names a column constraint** — the table has to be rebuilt,
and no ordinary migration can do it. `db:check` names the `*.once.sql`
file that does, if one has been written. Read it before running it: it
drops a table, so it is the one kind of file here that cannot be run
twice.

**6. Nothing missing, still broken?** Check in this order:

- `npm run secrets:check` — a secret that was never uploaded fails
  nothing. The code reads it as unset and the thing it guards stays
  off: no push, no Turnstile, no short links, the encoder answering
  503. So the symptom is a feature that is missing rather than an error
  anybody sees. This lists what the repo says the worker takes against
  what the account has, names only, and changes nothing.
- `npm run deploy` — the worker may be older than the database.
- The dashboard's Overview names the database it is bound to. A second
  D1 database with a similar name is the other way to see stale data:
  `wrangler d1 list` and check the id against `wrangler.toml`.
- Reads are edge-cached by full URL, so a write through one hostname
  purges only that hostname. `PUBLIC_API` in
  `wrangler.toml` has to name the hostname the site reads on.

### Uploads fail but nothing else looks wrong

A submission and its files are written in one go, so a column missing
from `submissions` stops the upload before the file reaches R2 — the
page reports a failure and there is nothing in the dashboard to show
for it. Run `npm run db:check` first; `submissions.gallery` is the
column this happened on.

If the database is clean, the next things to check are:

- **The R2 bucket binding.** `wrangler.toml` names it; a worker
  deployed without it fails on the first write.
- **The size.** Anything past the single-request limit goes up in
  parts, which needs `submission_files.status`, `upload_id` and
  `part_size` and the `submission_upload_parts` table
  (`migrations/2026-09-large-uploads.sql`). A small file succeeding
  while a large one fails points straight here.
- **The queue ceiling.** A team past the review limit (Settings →
  Submissions) has its sends queued rather than refused, but a team
  with 40 already queued is refused until some are reviewed; the page
  says so, but it reads as a failed upload if you are not expecting it.

## Updating the scores data

Export the two tab sheets as CSV over the top of `data/quest-tracker.csv`
and `data/score-database.csv`, then:

```
npm run seed
npm run db:seed
```

That regenerates `seed.sql` and reloads the remote database. Note it
replaces the whole table — anything recorded through `/submit` since
the last seed goes with it, so treat the tab as the source of truth
and re-export before reseeding. The exports hold the old quest codes:
after a reseed, retire and import again from the Quests tab.

## Later

- **Locking down `/submit` and `/unsubmit`**: in Discord, Server
  Settings → Integrations → the bot → per-command permissions. Limit
  those two to the organiser role; the read commands can stay open.
- **Local poking**: `npx wrangler dev` runs the worker locally with a
  local D1 (`npx wrangler d1 execute scs-scores --local --file=schema.sql`
  and the seed likewise). You can't hand-craft requests with curl —
  the signature check rejects anything Discord didn't sign — so test
  through a second Discord app pointed at the dev tunnel, or lean on
  the query layer directly with `wrangler d1 execute`.
