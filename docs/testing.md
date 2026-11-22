# Testing

The tests are plain Node scripts, one file a suite, with no test
framework. Each prints a line per check and exits non-zero when one
fails.

## Where the suites are

| Folder | What | Count |
|---|---|---|
| `tab/tests/verify-*.mjs` | worker suites: the real handlers against a real SQLite database | 38 |
| `tab/tests/verify-*.cjs` | browser suites: the site and the dashboard in Chromium | 28 |
| `checkin/tests/` | `verify-migrations.mjs` (the database) and `verify-board.cjs` (the board page) | 2 |

`tab/tests/` also holds the helpers the suites share: `d1-shim.mjs`
(Node's built-in SQLite dressed up as a D1 binding, running a batch as
one transaction), `console-signin.mjs` (how a suite signs in to the
dashboard), `ledger-fixture.mjs` (putting points on a team the way the
worker does), `pretend-r2.mjs` and `exif-sample.mjs`.

**Worker suites** import the worker's own modules and call its handlers
directly. Each builds a database from `schema.sql` and the seed, then
drives requests through `fetch` or the module's functions. Totals are
checked against figures worked out separately from the CSVs. They need
Node 22 or later for `node:sqlite`.

**Browser suites** use Playwright with Chromium. Each starts
`python3 -m http.server 8123 --directory website` and loads pages from
it. The worker's API and the tile hosts are stubbed with `page.route`,
since the test machine may have no network.

## Running them

Everything runs from `tab/`:

```
cd tab
npm install
npx playwright install chromium
```

| Command | Runs |
|---|---|
| `npm run test:affected` | only the suites your uncommitted change can reach |
| `npm run test:affected:list` | the same list, without running it |
| `npm run test:workers` | every worker suite, about 15 seconds |
| `npm run test:browsers` | every browser suite, about eight minutes |
| `npm run test:all` | both, before a release |
| `node tests/verify-<name>.mjs` | one suite |
| `npm run check` | the cache bump and `PRECACHE` rules |
| `npm run lint` | that the site's scripts are ES5 |
| `npm run typecheck` | the worker's TypeScript, then the site's and the dashboard's scripts against the names they share (`tab/types/`), in about a second |

**Run what the change can reach, once, after the last edit.**
`scripts/affected.mjs` reads `git` for what has changed and maps it to
suites. A change to the worker runs every worker suite. A change to one
page runs that page's suites and the two that walk every page. A change
to `assets/site*` or `sw.js` runs every browser suite. A change under
`website/` never runs the worker suites, and `docs/` reaches nothing. `--since=<ref>` compares against another commit.

Browser suites take `CHROMIUM_PATH`. Without it they use
`/opt/pw-browsers/chromium` where it exists and Playwright's own
Chromium otherwise. Playwright is pinned to 1.63.0 in `tab/package.json`
to match that browser. The parts of
`verify-compress.cjs` and `verify-encoder-orientation.mjs` that make
real video clips run only where `ffmpeg` is installed.

## CI

`.github/workflows/checks.yml` runs on pull requests and on pushes to
`main`, not on every branch push. A change to Markdown files, `text/`
or `.claude/` alone runs nothing.

- **Quick job**, about two minutes: the cache rule over the commits in
  the push or pull request, the lint, the type check, every worker
  suite, and the check-in worker's `verify-migrations.mjs`.
- **Browser suites**, about ten minutes, only when asked for: Run
  workflow on the Actions tab, or the `browser tests` label on a pull
  request. This also runs the check-in board's suite.

`[skip ci]` at the end of a commit message starts no run for that
push.

## What gets a check

- **A check is for something other code could break.** Worker behaviour
  qualifies: what a route refuses, what a key opens, which copy is
  served, what a counter does, what a cache keeps. So does anything the
  page and the worker must agree about.
- **A drawing does not**: which element is green, the order of columns,
  the words in a sentence. Those change because somebody decided they
  should.
- Design faults are caught generically. `verify-redesign.cjs` walks
  every page at two widths in both themes for text off the page, text on
  text, type under 10.5px, invisible text and page errors.
  `verify-one-site.cjs` holds the type ladder, the label style and the
  square corners. A new page goes in their lists rather than getting
  assertions of its own.
- Prefer one check over three that read three fields of the same
  answer.

## Writing a browser suite

- Serve `website/` itself on 8123, not the repo root: the site's
  relative paths only resolve from its own root. The suites keep `ROOT`
  for the repo and `SITE` for the folder served.
- Pretend to be the installed app with `navigator.standalone = true` and
  sessionStorage `scs2-launched`.
- Drive gestures in steps about 40ms apart. Code that listens to touch
  events (pull to refresh, the quest sheet) needs hand-built
  `TouchEvent`s. Code that listens to pointer events (the photo viewer,
  slide to confirm, the home slideshow) needs `PointerEvent`s or CDP's
  `Input.dispatchTouchEvent`, since a dispatched `TouchEvent` fires no
  pointer events.
- Assert on classes, on `getAnimations()`, and on canvas pixels for the
  map.
- A full-page screenshot captures only the first screen, because the
  body is the scroller.

## Where to read more

- Root [`CLAUDE.md`](../CLAUDE.md#testing-conventions): the testing
  conventions.
- [`tab/scripts/affected.mjs`](../tab/scripts/affected.mjs): which
  change runs which suites, and roughly how long each takes.
- [`README.md`](../README.md#tests): the commands in brief.
- Each suite's opening comment says what it covers.
