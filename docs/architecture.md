# Architecture

SCS.2 runs on a static website and three Cloudflare Workers. There is no
server to keep running. This page names the pieces, follows a request
between them, and lists the caches and the outside services.

## The pieces

| Piece | Folder | Runs on | Address |
|---|---|---|---|
| The website and installable app | `website/` | Netlify, static files | `scs.andyrew.space` |
| The tab worker: public API, submissions, push, registration, the Discord bot | `tab/` | Cloudflare Worker `scs-tab-bot`, D1 `scs-scores`, R2 `scs-submissions` | `files.scs.andyrew.space` and others (below) |
| The dashboard | `tab/src/dash/` | the tab worker, at `/dash` | `dashboard.scs.andyrew.space/dash` |
| The check-in worker | `checkin/` | Cloudflare Worker `scs-checkin`, D1 `scs-checkin`, R2 `scs-checkin-qr` | `checkin.scs.andyrew.space` |
| The map tile server | `tile-server/` | Cloudflare Worker `scs-tiles`, R2 `scs-tiles` | `tiles.scs.andyrew.space` |
| The video encoder | `tab/scripts/encoder.mjs` | organisers' own computers | none; it calls the tab worker |

Netlify publishes `website/` and nothing else. Its build command deletes
every `CLAUDE.md` and every `tests/` folder first (`netlify.toml`).

### The tab worker's hostnames

One worker answers on several hostnames.

| Hostname | Used for | Setting |
|---|---|---|
| `files.scs.andyrew.space` | what the site reads; the links the bot posts in Discord | `PUBLIC_API` in `tab/wrangler.toml` |
| `dashboard.scs.andyrew.space` | the dashboard | none |
| `go.scs.andyrew.space` | short links only; nothing else answers there | `SHORT_HOST` |

The site's own copy of the API address is `TAB_API` in
`website/assets/site.js`.

The map tiles come from `tiles.scs.andyrew.space`, with OpenStreetMap's
tiles as the fallback when it does not answer. The host is written four
times and the four change together: `TILE_URL` in
`website/questlist/scs-2-questlist-map.js` and
`website/tab/replay/replay-map.js`, `TILE_HOSTS` in `website/sw.js` and
`MAP_TILES` in `tab/src/dash/js/map.js`. Any site may load the tiles.

## How a request flows

**A page opens.** Netlify serves the HTML, CSS and scripts. Once the
service worker is installed it answers from its own cache: the files it
installed stay as they are until the next version installs a new worker,
and a page outside that list is refreshed in the background.

**The page reads data.** It asks the tab worker at `TAB_API`. Standings,
the quest list counts, messages and the countdown come from the public
reads, which the worker keeps briefly in its edge cache. A signed-in
team asks for its own copy of the quest list, the pulse and the
messages, sending its submit session; those are never cached. The full
list is in [api.md](api.md).

**The map draws.** MapLibre (vendored in `website/assets/maplibre/`)
asks the tile server for vector tiles cut from `my_area.pmtiles` in R2.
If no tile host answers, the page falls back to OpenStreetMap's raster
tiles.

**A team sends proof.** On `/submit/` a team signs in with its name and
submit code (`POST /api/submit/login`, a 24-hour session). Small files
travel inside the request that creates the submission. A larger file is
registered then and sent afterwards: straight from the phone to R2 on
signed URLs when the `R2_*` secrets are set, otherwise through the
worker in 20MB slices. The submission waits in the review queue.

**An organiser reviews it.** The dashboard calls `/api/console/*` with
its session. The worker checks the account, the tab the action belongs
to and, where an admin asked for it, the second password. Accepting
writes lines to the ledger, posts in the team's Discord channel, and
purges the public reads.

**Discord sends a command.** Discord POSTs each slash command to the
worker's root. The worker checks the Ed25519 signature, runs the command
against the same database and answers in the channel. Posting on its own
(reviews, check-ins, announcements) is a REST call with
`DISCORD_BOT_TOKEN`.

**A team signs up.** `/rego/` posts to `POST /api/rego/create`. The tab
worker creates the team and its people, asks the check-in worker for a
check-in code for each person (`POST /api/register`, with `CHECKIN_KEY`),
emails each person their ticket, and copies the rows to the Google
Sheet if `SHEETS_WEBHOOK_URL` is set.

**A person checks in.** Door crew scan codes on the check-in worker's
`/scan` page. After each check-in or undo, the check-in worker posts
`/api/team-checkin` to the tab worker with `TAB_SYNC_KEY`, once however
many times the code is scanned, and with the time of the change. The tab
worker records complete teams, passes over a report older than one it
has, and posts the line in the team's channel. A report is not sent
again: check-in logs one the tab refuses, and the tab records any
complete team it missed the next time the dashboard's day board or Rego
tab reads `/api/status`.
In the other direction the tab worker pushes renames
(`/api/rename`), marks test people (`/api/hide`), reads
`/api/status`, and takes people's emails and zIDs off and puts them back
(`/api/personal/*`, from the dashboard's Personal data card). The check-in worker has no CORS, so the site cannot call
it.

**The encoder runs.** Each organiser computer running
`tab/scripts/encoder.mjs` polls `/api/encoder/*` with `ENCODER_KEY`,
takes one video at a time, makes 480p, 720p and 1080p copies with
ffmpeg and uploads them. Without it, proof videos play at their original
size and videos added to albums stay off the site.
[`tab/ENCODER.md`](../tab/ENCODER.md) has the guide.

**The clock.** A Cron Trigger runs the tab worker once a minute. It
publishes messages written ahead of time, opens quests whose time has
come, moves queued submissions into the review queue, sends the rest of
a push or email announcement, retries failed ticket emails, saves an
hourly copy of the standings, checks the ledger hourly, and clears
dashboard uploads that were never saved. See [worker.md](worker.md).

## Caches

**The service worker** (`website/sw.js`) keeps four caches, and keeps the quest page's fifth across a version bump.

| Cache | Holds | Kept across a version bump |
|---|---|---|
| `CACHE` (`scs2-cache-vN`) | pages and the site's own files; `PRECACHE` files answered from it until the next version, the rest stale-while-revalidate | no |
| `FILE_CACHE` | images from the worker's file endpoints, cache-first, up to 400, each up to 2.5MB (12MB for slideshow and message pictures) | yes |
| `TILE_CACHE` | map tiles, up to 800, answered with no request and fetched again behind the map once a week old | yes |
| `TILE_CFG` | one entry: whether the Offline Map setting is on | yes |
| `MAP_SHOT_CACHE` (`scs2-map-shot`) | one picture of the quest map as it last stood, shown while the map starts | yes |

`PRECACHE` lists what is fetched on install; pages no menu links to
are left out and kept once opened. A `PRECACHE` file is not fetched
again until a new version installs, so one page load never mixes two
builds' files. The page registers the service worker three seconds after
`load`, so a first install does not compete with the page's own pictures
and reads; every page, the ticket included, carries the manifest link it
registers from. A page is stored under its address without the query
string. Offline, a page never stored is redirected to the home page. The service worker does not answer
API reads; the pages keep their own last good copies in localStorage.
Every commit that changes a file the site serves bumps `CACHE`, which is
what makes an installed app fetch the new files and shows the reload
notice on a page left open. See [website.md](website.md#the-service-worker).

**The edge cache** is the Cloudflare Cache API inside the tab worker.
`/api/tab`, `/api/leaderboard`, `/api/stats` and a challenge's
`/api/quest/standings` are kept for 10 seconds; `/api/quests`,
`/api/questlist`, `/api/pulse`, `/api/messages`, `/api/countdown` and
`/api/slides` for 30. Browsers get `max-age=0` and an `ETag`, and an
unchanged answer is a 304 with no body. A write that changes any of them purges
them. The cache is keyed by the whole URL, so the purge goes to every
hostname the site might read on: the request's own and `PUBLIC_API`. A purge only reaches the data centre that ran
it; a phone served by another one sees the old copy until it expires.

**File endpoints** (`/api/submit/file`, `/api/albums/file` and the
others) answer `immutable`. Each data centre keeps a plain ask for one
of them for an hour (`edgeFile` in `index.ts`): not a range, a link
preview, a person opening the address, the original or a download.
An album photo can be replaced in place, so its version is part of the
key. A file deleted can still be served from there for up to the hour.
A video the encoder has not finished can be answered by its still or by
another height than the one asked for; that answer is `private,
no-store`, so neither the browser, the service worker nor the edge
keeps it, and the same address serves the real copy once it exists.

**The dashboard page** (`/dash`) is built once per isolate and sent
`private, no-cache` with an `ETag`, so reopening it is a 304.

**Netlify** keeps the site's own files at `max-age=0`. `netlify.toml`
gives the vendored files longer: a year for the fonts and the map's
label glyphs, which are never edited, and a day for MapLibre, its style,
the icons and the haptics library. It also isolates `/compress/` from
other origins (COOP and COEP), which the multi-threaded video engine
needs, and nothing else on the site.

## Outside services

| Service | Used for |
|---|---|
| Cloudflare | the three workers, D1, R2, DNS, Email Service (ticket and announcement email), Turnstile (the human check on sign-up and dashboard sign-in), Workers Logs |
| Netlify | the website and deploy previews (`deploy-preview-N--scs-website.netlify.app`) |
| Discord | the bot's application: slash commands, team roles and channels, posts |
| Google Apps Script | the registrations sheet, through `SHEETS_WEBHOOK_URL` |
| Resend | email, only if Cloudflare's Email Service is not set up (`EMAIL_API_KEY`) |
| Browser push services | Web Push, sent from the worker with VAPID keys |
| OpenStreetMap | raster tiles when no tile host answers |
| Google Fonts | Roboto Mono on the dashboard, loaded without blocking the page; the site itself loads no outside fonts |
| GitHub | the repo and its checks |

**Request limits apply to the account, not the worker.** On Cloudflare's
free Workers plan all three workers together get 1,000 requests a minute
and 100,000 a day. The account is on the paid plan, which has no
per-minute limit, so a 429 there comes from a rate limiting rule in
front of the worker, not from the worker. The worker's own 429s are the
sign-in throttle, an album's hourly limit, sign-ups, push subscriptions
and a team's review cap.

## Where to read more

- Root [`CLAUDE.md`](../CLAUDE.md#layout): the layout and hosting notes.
- [`tab/CLAUDE.md`](../tab/CLAUDE.md): the opening paragraphs cover the
  public API, the edge cache and its purge, and the request limits.
- [`website/assets/CLAUDE.md`](../website/assets/CLAUDE.md): "Cached
  images", "The service worker asks the server, never the HTTP cache",
  "Offline map tiles" and "Last-good copies".
- [`checkin/README.md`](../checkin/README.md#how-the-pieces-fit): how
  the check-in worker and the tab worker talk.
