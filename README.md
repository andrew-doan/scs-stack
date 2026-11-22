# SCS.2

The Sydney Challenge Scramble, Season 2: a student-run, city-wide points
race across Sydney. This repo is everything it runs on: the event website
and installable app, the worker behind it (scores, quests, submissions,
the organisers' dashboard and the Discord bot), the check-in worker, and
the map tile server.

Production is `scs.andyrew.space`.

## What is where

| Folder | What it is |
|---|---|
| `website/` | The site. Static files with no build step: what is in the folder is what Netlify publishes. |
| `tab/` | The main Cloudflare Worker: the public API the site reads, submissions, push, registration, the dashboard (`tab/src/dash/`) and the Discord commands. Also holds the site's and the worker's test suites (`tab/tests/`). |
| `checkin/` | The QR check-in worker, with its own database and bucket. |
| `phone/` | The phone worker for the payphone quest: Twilio's webhook. See [`phone/README.md`](phone/README.md). |
| `tile-server/` | The worker that serves the map tiles from R2. |
| `text/` | Every string the site shows, in one CSV, with scripts to extract it and to apply an edited copy back. |
| `tracks/` | The command that cleans the GPS routes teams recorded into cleaned GPX files. The replay's routes are cleaned and saved on the dashboard's Routes tab. |
| `security/` | A script that probes the live hosts for leaks, and what each check proves. |
| `docs/` | Reference pages for people: how each part works now. |
| `.claude/` | One skill for AI coding agents: the copy rules. Not needed to work on the code. |

Each folder's `CLAUDE.md` has the detailed notes on how its code works and
why. Start with the root [`CLAUDE.md`](CLAUDE.md), whose "Hard rules"
apply everywhere. [`tab/README.md`](tab/README.md) and
[`checkin/README.md`](checkin/README.md) cover setting each worker up.

## Documentation

[`docs/README.md`](docs/README.md) lists the reference pages, in
reading order: the architecture, the website, the dashboard, the worker
and its API, the data model, running the event, and testing. Each is
short and links to the `CLAUDE.md` notes for the detail and the
reasons.

## Running it locally

You need Node 22 or later and Python 3.

The site:

```
python3 -m http.server 8123 --directory website
```

Then open `http://localhost:8123`. Serve `website/` itself, not the repo
root, or the relative paths break. Pages read the live worker's public
API (`files.scs.andyrew.space`), so they show real data.

The tab worker runs under `npx wrangler dev` in `tab/`. Setting it up on
a Cloudflare account for the first time is in
[`tab/README.md`](tab/README.md#setting-it-up).

## Tests

```
cd tab
npm install
npx playwright install chromium
```

| Command (in `tab/`) | What it runs |
|---|---|
| `npm run test:affected` | Only the suites your uncommitted change can reach. Use this while working. |
| `npm run test:workers` | Every worker suite, about 15 seconds. |
| `npm run test:browsers` | Every browser suite, about 8 minutes. |
| `npm run test:all` | Both. |
| `npm run check` | The cache bump and PRECACHE rules (below). |
| `npm run lint` | That the site's scripts are ES5 (below). |
| `npm run typecheck` | Types, checked by `tsc` with nothing emitted: the tab worker's, then the site's and the dashboard's scripts against the names they share, declared in `tab/types/`. About a second. |

The browser suites start their own servers on port 8123. Set
`CHROMIUM_PATH` to run them against a different Chromium. The parts of
`verify-compress.cjs` and `verify-encoder-orientation.mjs` that make
real video clips run only where `ffmpeg` is installed. The check-in
worker's two suites are in `checkin/tests/`.

GitHub Actions (`.github/workflows/checks.yml`) runs the rules, the lint
and the worker suites, in one job of about two minutes, on pull requests
and on `main`. A change to notes alone runs nothing. The browser
suites (about ten minutes) run only when asked for: Run workflow on the
Actions tab, or the `browser tests` label on a pull request. `[skip ci]`
at the end of a commit message starts no run for that push.

## Rules that are checked

- **Bump `CACHE` in `website/sw.js` in every commit that changes a file
  the site serves.** Installed apps only pick up a new version on a bump.
  A new file also goes in `PRECACHE` in the same file. If it should only
  be fetched when needed, add it to `NOT_PRECACHED` in
  `tab/scripts/check-rules.mjs` with the reason. `npm run check` checks
  both rules.
- **The site's scripts are ES5**: `var` and `function`, no arrow
  functions, classes or `let`. That keeps them working on the browsers
  current in September 2021 with no build step. `npm run lint` checks
  it. Dynamic `import()` is allowed.
- **No build step, frameworks or npm packages in the site.** Libraries
  the site uses are copied into `website/assets/` as published.

The rest of the house rules (the design system, the copy, the commit
messages) are in the root `CLAUDE.md`.

## Deploying

- **Website**: Netlify publishes `website/` from the production branch,
  and builds a preview for each pull request. Its build command deletes
  every `CLAUDE.md` and `tests/` folder first (`netlify.toml`).
- **Tab worker**: in `tab/`, in this order, so new code never runs
  against a database or secrets that are behind it:
  1. `npm run secrets` uploads `secrets.json`.
  2. `npm run db:migrate` brings the database up to date.
  3. `npm run deploy` deploys.

  `npm run secrets:check` says which secrets the live worker has, and
  `npm run db:check` what the live database is missing against
  `schema.sql`.
  [`tab/README.md`](tab/README.md#updating-the-bot-once-its-live) has
  the detail and the known errors.
- **Check-in worker**: see [`checkin/README.md`](checkin/README.md).
- **Rolling back**: on Netlify, publish an earlier deploy from the Deploys
  page. For a worker, `npx wrangler rollback` in its folder. A rollback
  does not undo a database migration.
- **Backups**: `npm run backup` in `tab/` (see the Backups section of its
  README).

## Accounts and services

| Service | What it holds |
|---|---|
| Cloudflare | The three workers (`scs-tab-bot`, `scs-checkin`, `scs-tiles`), the D1 databases (`scs-scores`, `scs-checkin`), the R2 buckets (`scs-submissions`, `scs-checkin-qr`, `scs-tiles`), the `andyrew.space` DNS, email sending and Turnstile. |
| Netlify | The website. |
| Discord | The bot's application. |
| Google | The sheet registrations are copied to, through an Apps Script web app (`SHEETS_WEBHOOK_URL`). |
| Resend | Only if Cloudflare's email sending is not set up (`EMAIL_API_KEY`). |
| GitHub | This repo and its checks. |

Keep a note of who can sign in to each, outside this repo. Every key and
password is a worker secret: `tab/secrets.example.json` and
`checkin/secrets.example.json` list them, and the filled-in
`secrets.json` files are never committed.
