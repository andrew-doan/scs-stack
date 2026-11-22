# SCS.2 — Sydney Challenge Scramble, Season 2

The full stack for a student-run, city-wide points race across Sydney:
the event website + installable PWA, a Discord scoring bot with a tab
console, a check-in worker, and the Cloudflare backend. One repo for
everything. The visual design and interaction feel are the product and
are settled: treat them as protected.

## Layout

```
/website            the website (static, no build step)
  index.html (the thanks page since the day; the page before it is
  `home-before-the-day.html`, which nothing links to), questlist/ (+ questlist/full/ — every quest on one page: descriptions, points, code tables, files; no page links to it, and the list's Full quest information switch shows the same blocks in place; #KEY lands on a quest), info/, welfare/, scs1-tab/, tab/, messages/ (OrgComm announcements; the nav bell links here), submit/ (sending proof in; links to the compressor from a line under the file field, the nudge on a large file and, signed out, a line under the sign-in card; /submit/#compress, the old address, goes on to compress/), compress/ (the compressor, a page of its own so that it alone is cross-origin isolated — `netlify.toml` sends COOP and COEP on `/compress/*` and nowhere else — which lets ffmpeg.wasm run multi-threaded (`assets/ffmpeg-mt/`), falling back to the single-threaded core where the page is not isolated; the browser's own codecs through WebCodecs (webcodecs.js, with mp4box and mp4-muxer) come first and need neither; picture size 1440p/1080p/720p/480p by short edge with a predicted size each, target size in MB and in percentages, options that would upscale/not shrink/starve the bitrate are hidden), gallery/ (team-only + slideshow), albums/ (photo and video albums made on the dashboard's Files tab, shown as a waterfall or in rows, narrowed to some people's or everyone's but theirs with by=/not= in the address so a link carries it: on the list, at a link only (?k=, random) or organisers only, which the dashboard opens at ?pass= for a day; an album can merge others, to show every photo in one; teams add with their submit code or anyone does, as each album says, videos go through the proof encoder, one can show the gallery's photos, and one photo can be shared on its own at the worker's /photo/<id>, a page Discord previews as the picture; nothing links to it, the dashboard gives each album's address; Slideshow runs the shared slideshow over the album), plan/ (the route planner: one of the quest list's lists put in order, with straight-line distances, a drawn route and transit directions for each leg; linked from a picked list on the quest list), rego/, terms/ (the terms and waiver; opened from a confirmation email with ?k= it says who the link is for and takes that one person's acceptance), recap/ (the day in numbers, after the event) and tab/team/ (one team's page, linked from the leaderboard after the event; both behind dashboard switches),
  ticket/ (the check-in QR from the confirmation email. /ticket/?<blob>: first byte 2 = version, token length, the check-in token's raw bytes, then utf8 name\nteam — the page redraws the QR itself (ticket/qrcode.js, scs2:<token>, EC M, offline); errors E1–E3), 404.html (Netlify serves it; rotating puns)
  assets/           site.css + the shared script in five parts every page loads in order: site.js (the helpers on window.scs), site-viewer.js (the photo viewer), site-chrome.js (bars, menus, settings, theme), site-input.js (confirm slider, leave guard, loading bar, haptics) and site-app.js (offline map, service worker, push, countdown; it runs all five), photo-strip.css + photo-strip.js (the row of event photographs on the sign-up page and the gallery's gate), slideshow.css + slideshow.js (the full-screen slideshow the gallery and the album page share), video-sizes.js (which copy of a video plays — Auto and a menu of the encoded sizes and Original — for every player: the site's viewer, the gallery slideshow, the dashboard preview and the worker's /view/ and /photo/ pages, which load it from the site), share-image.js (a team's receipt and the standings drawn as pictures to paste into a chat, for the team pages, the live tab once the results are out and the dashboard, which loads it from the site), photo-view.js (a photo on the whole screen for the worker's file pages, which load it from the site; its zoom is a copy of the lightbox's), push.js (a team's page and the recap pushed over the tab, a quest's page over the recap: the slide in and the swipe back on a phone) and photo-details.js (a photo's details as rows, for the album viewer and those pages), fonts/ (SCS Heros, the stand-in for Helvetica on devices without it, with its licence), vendored libs, transit.geojson
  sw.js             service worker — PRECACHE pages and assets from the cache until the next version, everything else stale-while-revalidate
/tab                Cloudflare Worker: the tab — scores, quests, submissions, the public API the site reads, push, registration, the dashboard, and the Discord commands
/checkin            Cloudflare Worker: QR check-in — own D1 + R2, organiser pages
/phone              Cloudflare Worker: Twilio's webhook for the payphone quest — checks each request is Twilio's, asks the tab what the call does next and answers in TwiML; no database
/text               every word the site says, in one CSV, with the scripts that take it out (extract.py) and put an edited CSV back (apply.py). Not published; not part of the site
/tracks             the GPS quest's routes: clean.mjs turns the GPX files teams sent into cleaned GPX for OrgCom, filling in rides underground along the rail lines, with the same cleaner the dashboard's Routes tab runs to save the replay's routes; a teams.json beside it says whose each file is. That file and the GPX files stay out of the repo. Not published
```

Hosting: Netlify publishes `website/` and nothing else — `netlify.toml`
sets that, and a file in the repo beats the UI settings. **That folder
is not only the site, so the deploy prunes it**: `netlify.toml`'s build
command deletes every `CLAUDE.md` and every `tests/` directory before
publishing. Those are notes beside the code, and they were being
uploaded and served — `/assets/CLAUDE.md` answered 200. They come out of the deploy
rather than out of the repo, because beside the code is where they are
useful and Netlify publishes a copy in a checkout it throws away; it is
not a build step for the site, since nothing is compiled, bundled or
installed. Anything new under `website/` that is not the site goes in
that list. It also lets the dashboard read the site's map files from
another origin (CORS headers on `/assets/maplibre/*` and
`/assets/transit.geojson`, for the dashboard's Map tab), and the
worker's file pages load PDF.js from `/assets/pdfjs/*` the same way.
It gives the vendored files a browser cache life: a year for
`assets/fonts/`, the map's glyphs and `assets/pdfjs/`, so **a changed font,
glyph file or PDF.js goes up under a new name**, and a day for MapLibre, its style, the
icons and the haptics library, which have been edited in place. Deploy
previews are `deploy-preview-N--<site>.netlify.app`, production
is `scs.andyrew.space`. Cloudflare: R2 holds `my_area.pmtiles`, a tiles
worker serves it at `tiles.scs.andyrew.space` (the one tile host: it
is named in `TILE_URL` in the quest page and the replay's script
(`website/tab/replay/replay-map.js`), `TILE_HOSTS` in `sw.js`, which
decides whose tiles are kept, and `MAP_TILES` in the dashboard's script
(`tab/src/dash/js/map.js`), so the four are changed together; any site
may load the tiles, the worker answers `Access-Control-Allow-Origin:
*`), the bot worker lives at
`files.scs.andyrew.space` — the name the public reads on, so
attachment links posted in Discord say what they are — with the
dashboard at `dashboard.scs.andyrew.space`. `go.scs.andyrew.space` is the same worker again and is
nothing but short links (`SHORT_HOST`; the dashboard's Files tab makes
them, and a link to a file serves the file there so it embeds).
The check-in worker is `checkin.scs.andyrew.space`. D1
databases `scs-scores` and `scs-checkin`. **One worker, several
hostnames** is now a thing the code has to know: the edge cache is
keyed by the whole URL, so `PUBLIC_API` in the bot's
`wrangler.toml` says which hostname a purge must reach beside the one
the write arrived on (a dashboard
write would otherwise purge nothing the site reads), and the bot builds
its Discord file links from `PUBLIC_API` rather than from whichever
hostname the save arrived on.

## Hard rules

- **Bump `CACHE` in `website/sw.js` on every commit that touches site
  assets** and add new files to `PRECACHE`. The PWA only refreshes on a
  bump, and the bump is what puts the "SCS.2 updated" reload pill on a
  page left open. The number lives in that file and nowhere else — it was written
  down here too and drifted six versions behind within a week.
  `npm run check` in `tab/` checks both (`scripts/check-rules.mjs`, where
  `NOT_PRECACHED` lists what is left out on purpose, with why), and CI
  runs it on pull requests and on main.
- No build step, no frameworks, no npm for the site. ES5-style JS in IIFEs,
  `var`, relative URLs everywhere (GitHub-Pages/Netlify friendly).
  `npm run lint` in `tab/` checks the syntax (`eslint.config.mjs` at the
  root; dynamic `import()` is the one later construct allowed).
  **A page that loads site.js loads all five parts**, each `defer`, in
  this order: `site.js`, `site-viewer.js`, `site-chrome.js`,
  `site-input.js`, `site-app.js`. The last one runs the five, so a page
  missing it runs none of them (`website/assets/CLAUDE.md`). The quest
  page's own script is five parts the same way
  (`website/questlist/CLAUDE.md`).
- The design system is transit wayfinding (Vignelli/MTA): Helvetica
  stack (`"Helvetica Neue", "SCS Heros", Helvetica, Arial` — the
  system's Helvetica Neue, and on a device without it **SCS Heros**,
  a cut of the free TeX Gyre Heros served from `assets/fonts/`; it
  goes before Helvetica in every stack, because Windows answers
  Helvetica with Arial and Android with Roboto, so behind Helvetica it
  is never reached. `website/assets/CLAUDE.md` has the rest),
  a light grey page `--page-bg #f2f3f5` with white bars and cards
  (`--surface #ffffff`), and `--tint #e7e8eb` a step darker for a box
  that has to show on either: a hover, code, a track / dark via
  `html[data-theme="dark"]`,
  **black signage objects** (`--sign-bg`/`--sign-ink`, the same in both
  themes — the home page's board, the quest sheet's head, the messages
  page's urgent board, a code chip, a picked chip; those are drawings
  and have to read as the same object whichever theme the page is in.
  On the dark page that black is within a few steps of the ground, so
  there `--sign-edge` draws a code chip's or a plate's edge and
  `--pick-edge` puts an ink edge on a picked chip, which otherwise read
  as the one switched off) and **chrome that follows the
  theme** (`--bar-bg`/`--bar-ink`/`--bar-muted`, white over the grey
  page in the light theme and a shade lighter than the page in the dark
  one,
  with a `--bar-edge` hairline along the edge where the five-route
  stripe used to run: the top bar, the footer and the app's bottom bar,
  and nothing else. site-chrome.js writes the colour along the top of the
  screen into `meta[name="theme-color"]`, read off the custom property
  rather than written down twice, so the browser's chrome follows. The
  five-line `--stripe` is still defined and is still the mark on the
  paper things — the ticket and the confirmation email — where it is
  the only colour on the page; it is off the screen chrome),
  the `--line-*` route palette (MTA colours; `--alert-ink` is red as
  *words* rather than as a route — the line red on paper, lifted to a
  coral on the dark ground where the line red buzzes; `--tab-yellow` is
  the same move for the app bar's fifth route, which at 1.6:1 vanishes
  on the light bar; `--glow-fill`
  is a flat translucent amber for something asking to be looked at,
  painted *inside* a box with `--glow-edge` warming its border, never
  a shadow around one and never a gradient — how strong the light is
  may change, where it is may not),
  **nothing painted over the page** (the
  print grain is gone — it read as a dirty screen, worst in dark mode;
  neither page-wide slot is free: **`html::after` is the band over the
  notch in the app layout, and `body::after` is the quest page's sheet
  dim**), accent green `#00933c`, square
  corners (radius 2px, the web's floating top bar included) — round is
  reserved for `.bullet` route discs (nav dots, hero letters,
  leaderboard ranks) — and **a hard offset shadow on what is off the
  page**: a banner, a pop-up, a toast, a control over the map, the
  web's floating top bar once the full bar has scrolled away (its
  hairline ring and `--shadow`, as the map's buttons carry), and a
  button, where the shadow is what `:active` presses
  into. The install prompt is the one pop-up without it, carrying its
  hairline alone, because a shadow there read as out of place. It
  stays on the things drawn as objects rather than as
  containers too — a sign bar, a ticket, a split-flap module.
  **That list is the whole of it. A shadow is never the default**: the
  question to ask a new box is whether it is genuinely off the page,
  and almost nothing is. **A container in the flow carries a hairline
  and nothing else**: `.card` and `.stat` are the pattern, and a box
  beside them lifting itself off the same paper is what this rule is
  here to stop. A list of results under the box that filters it is in
  the flow. A menu or drawer the page dims behind (the settings menu,
  the quest filters) carries a hairline and no shadow either — the dim
  is what says it is off the page, and a shadow under something already
  lifted that way is a second answer to a settled question. Uppercase
  0.72rem muted labels at 0.08em tracking for a word beside a figure (a
  form field's name is not one of those: it is sentence case, bold, at
  the small size), O/I rocker
  switches for every toggle. Text size runs on a ladder of stops
  (`FONT_STOPS` in site-chrome.js, 33% to 200%, bunched around 100 because a
  step that reads as small at 100% is a third of the whole thing at
  33%); 100% clears the root font size rather than setting it, and
  every page's boot script clamps to the same range, so widening the
  ladder means widening those too. No webfonts but that stand-in, no
  other rounded corners, no soft shadows.
- **An open menu says so itself**: the gear goes solid while the menu
  is open (`.settings-toggle.is-open` swaps in the filled gear), and the
  bell goes solid on a tap and stays solid on the messages page
  (`.is-filled`). Neither relies on `:hover` for this, because on a
  phone the invisible haptic switch over the control takes the pointer. At rest
  both draw nothing — the border is `transparent` rather than removed,
  so it stays in the box model — and a fine pointer's hover fills
  them with a grey box (`--bar-hover`) and nothing else. A nav link's
  hover is the same grey box with its route colour in a 3px rule under
  the name. The page you are on keeps that rule, in ink; it is not an
  inverted black block.
- **The rocker is one block that travels**, not two cells cross-fading:
  `.settings-switch` is an `inline-grid` of two `1fr` columns so both
  halves are the same width (O is a much wider glyph than I, and equal
  tracks are what let one block land squarely on either side), and
  `::before` is a half-width block that slides on `--duration-fast`
  `--ease-bounce`, grey on the O side and accent green on the I side.
  The switch's own edge clips the overshoot. The letters never move —
  they are position labels — and flip colour 140ms in, as the block
  arrives over them, on the quick clock going back. The check-in
  worker's pages carry their own copy of the same rules
  (`checkin/src/pages.js`); the dashboard has plain tick boxes and no
  rockers. `tests/verify-switch.cjs` covers it.
- **No eyebrows, kickers or subtitles that restate the title.** Every
  page's name is a `.hero` set in ink on the paper (the markup keeps
  `h1.sign-bar`), the same distance under the top bar on every page;
  it is not reversed out of a black band. The home page's board (its
  name and its photos) and the 404's notice are the black signs left at
  the top of a page. Section titles are
  `h2.section-heading`: one size (`--t-head`) on every page, under a
  rule of `--rule-w` (2px) in `--rule-ink` — ink on paper, a mid grey
  in the dark theme, where an ink rule was the brightest thing on the
  screen. Every rule over a section, a table head or a list uses that
  weight and colour; the 6px black bar it replaced chopped every page
  into stripes and turned white in the dark theme.
- **One button.** 48px tall, the body size at 800, a 2px keyline:
  filled green (`--accent-solid`) for the one action a screen is for,
  with white type on it in both themes (`--on-accent`; the dark theme
  had near-black, which reads better by the numbers and was asked to
  go), the keyline on the surface for anything beside it. `.btn`, the quest
  page's `.ql-button` and the sign-in bar share the numbers, and a
  button carries no shadow at rest — only the hover lift and the
  `:active` press. Prose lives directly on the page; `.card` is
  for things that are actually a unit (a form, a stat, a link card, a
  member card), never a box around a paragraph or a single table.
- Write user-facing text plainly — short sentences, no emoji, no
  "simply", no hype, no hints that only make sense if you wrote the
  code, nothing that calls the data a draft or a preview. Same rule for
  the READMEs.
  **Before phrasing a string, ask whether it should be on the screen at
  all**: the `clean-copy` skill (`.claude/skills/clean-copy/`) is the
  cut that comes before the edit — a caption that says the label again,
  a hint that answers a question nobody asked, a warning that is scar
  tissue from a bug since fixed. Editing one of those for tone only
  makes the wrong thing read better.
- **No mannered prose, anywhere** — user-facing text, READMEs, code
  comments, commit messages, replies in chat. Mannered prose swaps a
  direct statement for metaphor and flourish: "a dial worth turning"
  for "a parameter worth varying", "this point earns its keep" for
  "this point still matters". The phrases exist to display the writer,
  not to convey the idea; they make the reader work harder, and the
  metaphor drags in connotations the writer did not choose and cannot
  control. Say what you mean. When a literal phrase is available, use
  it.
- **A comment in a page under `website/` is public**: View Source shows
  it. Inline in an HTML page, an HTML, CSS or script comment is a short
  label saying what the block is or does, plus a reason only where the
  code would look wrong without one (a browser quirk, an order that
  matters, something another file depends on). What it used to be, why
  a design won and which bug it fixed go in the commit message or a
  CLAUDE.md, never beside the markup.
- **Every dashboard account is made by an admin**, with a password of
  its own, the tabs it may use (or admin: every tab and the Accounts
  tab), the quests it may score if not all of them, and whether it
  needs the six digits from the organiser's own authenticator app, set
  up at its first sign-in. The worker checks
  the account on every request; the page only leaves out the tabs it
  cannot use, and an action not given a tab in `tab/src/dash-access.ts`
  is admin only. The actions an admin ticks also ask for the second
  password (PUSH_PASSWORD). The shared CONSOLE_PASSWORD only makes the
  first admin on an empty database and signs in accounts from before
  admins made them. Ten printed backup codes stand in for a dead phone,
  and sign-in attempts are throttled per address — never worker-wide,
  because a lock everybody shares is a lock any stranger who finds the
  dashboard can put on the committee at 9am. Written up in
  `tab/CLAUDE.md`.
- Never put API keys or tokens in the repo. Both workers take every
  per-account value as a secret: `secrets.example.json` lists them,
  `secrets.json` (gitignored) holds them, `npm run secrets` uploads
  them (`wrangler secret bulk`) and `npm run secrets:check` says which
  of them the live worker actually has; a value still reading `PASTE…`
  counts as unset (`configured`). `wrangler.toml` holds only settings that
  are the same everywhere (`VAPID_SUBJECT`, `EMAIL_FROM`,
  `EMAIL_REPLY_TO`; check-in: `TAB_API`) plus a placeholder
  `database_id` that `npm run deploy` (`scripts/deploy.mjs`) fills from
  `wrangler d1 list --json` by name into `wrangler.deploy.toml`
  (gitignored) before `wrangler deploy --config`. A KV namespace is
  written `id = "PASTE-KV:<name>"` and filled the same way from
  `wrangler kv namespace list`, but only by the deploy, and one the
  account lacks is left out of the deploy with the command to make it. A secret must not
  share a name with a `[vars]` entry.
- **The deploy scripts are one file each, copied into both workers**:
  `scripts/deploy.mjs`, `migrate.mjs`, `db-check.mjs`, `d1-run.mjs`,
  `secrets-check.mjs`, `backup.mjs`, and `tests/verify-migrations.mjs`
  with them. The
  check-in worker is a separate package and cannot import from
  `tab/`, which is the same reason it has its own copies of the
  small helpers. `dbName()` reads each worker's own `wrangler.toml`, so
  nothing in them names a database; edit one and copy it across, or
  `verify-migrations` fails in both.

## Where the rest is written down

The detail lives beside the code it describes, in a `CLAUDE.md` in each
directory. Those load when a file in that directory is read, so this
file stays short enough to be read every time. Anything that has to be
true *before* a file is opened belongs here, in Hard rules.

- `website/assets/CLAUDE.md` — the shared chrome: helpers, the bell and
  messages, app layout, scroll, the floating button, the back-layer
  stack, the image and tile caches, haptics and the motion system.
- `website/questlist/CLAUDE.md` — quest data and the live-quest extras, the
  list, the sheet, quest search, the map and the fullscreen map.
- `website/submit/CLAUDE.md` — answer boxes and renaming a file before it
  goes up.
- `website/compress/CLAUDE.md` — the compressor: its isolation and the
  multi-threaded engine, the browser's own codecs, and when it falls back
  to ffmpeg.
- `website/tab/CLAUDE.md` — the live tab, and the team pages and recap
  that open after the event.
- `tab/CLAUDE.md` — the worker: slash commands, the public
  API, freezing the tab, messages and the pulse, submissions and the
  gallery, the proof lightbox, push, registration, the dashboard, and
  the migration runbook.
- `checkin/CLAUDE.md` — the QR check-in worker.
- `phone/CLAUDE.md` — the phone worker for the payphone quest; the
  quest itself is in `tab/CLAUDE.md`.
- `text/CLAUDE.md` — the CSV of every word the site says, what is in it
  and what is not, and how an edited CSV is applied back.
- `docs/` — the reference pages for people, starting at
  `docs/README.md`: how each part works now, linking back to these
  notes. A change to how something works updates both.
- `tracks/CLAUDE.md` — cleaning the routes teams recorded.

## Testing conventions

Playwright (`CHROMIUM_PATH`, below) against
`python3 -m http.server 8123 --directory <repo>/website` — the site's
own root, so its relative paths resolve exactly as they do on Netlify
(serving a subdirectory *of the site* instead is a recurring,
confusing failure; the suites keep `ROOT` for the repo and `SITE` for
the folder the server is pointed at). Simulate the PWA via
`navigator.standalone=true` + sessionStorage `scs2-launched`; drive
gestures in steps paced by ~40ms sleeps: hand-built `Touch`/`TouchEvent`
sequences for code that listens to touch events (pull to refresh, the
quest sheet), and `PointerEvent`s or CDP `Input.dispatchTouchEvent` for
code that listens to pointer events (the lightbox, the slide-to-confirm
thumb, the home slideshow), since a dispatched `TouchEvent` fires no
pointer events. Assert on classes, WAAPI `getAnimations()`, and canvas pixel
scans for map rendering; stub external hosts (the tile workers, the
tab API) with `page.route`, so a suite needs no network.
Full-page screenshots only capture the first viewport because
the body is the scroller. Bot tests run the real handlers against
`node:sqlite` through `tests/d1-shim.mjs`, seeded with the real schema
+ seed, with totals cross-checked independently from the CSVs.

**Run the suites the change can reach, once.** `npm run test:affected`
in `tab/` reads what git says has changed and runs only what covers it
(`test:affected:list` to see the list without running, `test:all` for
the lot before a release). The browser suites are about seven and a
half minutes end to end and the worker suites about fifteen seconds,
and most of that is spent on files the change could not have touched: a
welfare edit needs 31 seconds of generic checking, a quest-list edit
needs 146, and only a change to `assets/site*` or `sw.js` — the chrome
on every page — needs the whole browser set. A change under
`website/` cannot reach the worker suites at all. Run it after the last
edit, not after each one.

**The tab worker is TypeScript** (`tab/src/*.ts`), in erasable syntax
only, so Node runs the suites on the source and wrangler bundles it
with no build step of ours. `npm run typecheck` in `tab/` checks it
under `strict`, then checks the browser's JavaScript as it stands: the
site's scripts (`tsconfig.site.json`, the service worker in
`tsconfig.sw.json`) and the dashboard's script parts and spinner
(`tsconfig.dash.json`), about a second for the lot; run it after any
edit under `tab/src/` or to a script under `website/`. Those stay plain
JavaScript with no type comments. What they share through `window`
(`window.scs`, `scsSite`, `scsQuestList`, `dash` and the rest) is
declared in `tab/types/`, so **a new shared name or a changed
signature goes there too**, or the check fails where it is used. It is
not strict (why is at the top of `tsconfig.site.json`): it catches a
name nothing defines, a shared member that is not declared, a call
with too many or too few arguments, an API newer than ES2021,
unreachable code and a name declared and never read. `console-page.js`
and the vendored QR encoder are not checked.

**Fixing a bug is not a reason to write a check.** The bar is whether
other code can break this: a check earns its place when someone editing
a different file could break it without noticing. Worker behaviour
clears that bar — what a route refuses, what a key opens, which copy is
served, what a counter does, what a cache keeps. So does anything the
page and the worker have to agree about. A drawing does not: which
element is green, what order the columns are in, where a number is
centred, how many frames an animation takes, the words in a sentence.
Those change because somebody decided they should, and a check on one
only means the next person has to edit the test to make the change they
were asked for. Design faults that ARE worth catching are caught
generically and already are: `verify-redesign.cjs` walks every page at
two widths in both themes for text off the page, text on text, type
under 10.5px, invisible text and page errors, and `verify-one-site.cjs`
holds the type ladder, the label voice and the square corners. A new
page goes in those lists; it does not get assertions of its own.

Prefer one check over three. Three checks reading three fields of one
answer is one fact, and it reads as three when it fails.

**CI** (`.github/workflows/checks.yml`) runs `npm run check`, `npm run
lint`, `npm run typecheck` and every worker suite in one job on pull requests and on main,
and every browser suite only when asked for (Run workflow, or the
`browser tests` label on the pull request), not on every branch push,
and a change to notes alone runs nothing (`npm run
test:workers` / `test:browsers` are `affected.mjs --all` with
`--workers` or `--browsers`). Playwright is a
dev dependency of `tab/`, pinned to 1.63.0. Every browser suite takes
`CHROMIUM_PATH` and otherwise uses `/opt/pw-browsers/chromium` where it
exists and Playwright's own Chromium where it does not. The root `README.md` is the front door for people.

## Workflow

Verify with the test approach above before committing; describe what
changed and why in plain prose commit messages.
