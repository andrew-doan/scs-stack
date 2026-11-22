# The website

`website/` is the whole site: static files, no build step, published by
Netlify as they are in the folder. The same pages are the installable
app. This page lists the pages, the shared scripts, the service worker,
the settings, the two layouts and the design rules in short.

## Rules for the site's code

- No build step, no frameworks, no npm packages. Libraries are copied
  into `website/assets/` as published.
- ES5: `var` and `function` inside IIFEs, no arrow functions, classes or
  `let`. Dynamic `import()` is the one later construct allowed.
  `npm run lint` in `tab/` checks it.
- Relative URLs everywhere, so a deploy preview and a local server work
  the same as production.
- It has to run on the browsers of September 2021: Safari 15.0, Chrome
  and Edge 93 and 94, Firefox 92, Samsung Internet 15. No visible layout may
  depend on `:has()`.
- A comment in a page is public (View Source shows it), so it is a short
  label, not history.

## Pages

| Path | What it does | Reached from |
|---|---|---|
| `/` | Home, since the event: the home slideshow, thanks for playing, the day's numbers, the top five on the leaderboard and links to look back. The home page from before the event (the board, the countdown, sign-up) is `/home-before-the-day.html` | menu |
| `/home-before-the-day.html` | The home page as it was up to the event: the board with the headline, the four facts and the countdown, sign-up, the schedule and the quest kinds. Its links are written for the root of the site, so it can go back to `index.html` as it is | unlinked |
| `/questlist/` | The quest list, the quest sheet, search and the map | menu |
| `/questlist/full/` | Every quest on one page; `#KEY` lands on a quest | unlinked |
| `/tab/` | The live tab: standings refreshing every 10 seconds; ices over when frozen | menu |
| `/tab/team/` | One team's page after the event, with its recorded route once Replay is on | leaderboard names, once Team pages is on |
| `/tab/replay/` | The routes teams recorded for the GPS quest, played back on the map with their quests | live tab, once Replay is on |
| `/recap/`, `/recap/quest/` | The day in numbers, and one quest's numbers, after the event | live tab, once Recap is on |
| `/submit/` | Sign in with a submit code, send proof, see the team's score | menu, app bar |
| `/compress/` | Make a video smaller before sending it; the only page isolated from other origins, so the ffmpeg fallback can run multi-threaded | the submit page |
| `/gallery/` | Proof teams chose to share, for signed-in teams, and its slideshow | submit page |
| `/albums/` | Photo and video albums made on the dashboard | the addresses the dashboard gives out |
| `/messages/` | Organiser announcements | the bell in the top bar |
| `/rego/` | Team sign-up | home page |
| `/terms/` | Terms and waiver; with `?k=` from an email it takes one person's acceptance | confirmation email |
| `/ticket/` | A person's check-in QR, redrawn in the page from the link | confirmation email |
| `/info/`, `/welfare/` | The information pack; welfare and safety | menu |
| `/scs1-tab/` | Season 1's tab | a short link |
| `/404.html` | Netlify's not-found page | |

## Shared scripts

Every page loads `assets/site.css` and the shared script, which is five
files loaded in this order, each with `defer`:

| File | Holds |
|---|---|
| `site.js` | the helpers on `window.scs`: the layout test, `scs.fetch`, the quest list, the pulse, times, pictures, HEIC and EXIF, markdown, the motion helpers |
| `site-viewer.js` | the photo viewer (`scs.lightbox`) and pull tabs |
| `site-chrome.js` | the bell, the urgent pop-up, pull to refresh, the theme, the settings menu, the bars, toasts, the install pop-up, the burger menu |
| `site-input.js` | slide to confirm, the leave guard, the loading bar, the bottom bar's taps, haptics, the settings rockers |
| `site-app.js` | the offline map, the service worker, the update notice, push, the countdown |

Each file only adds its part to `window.scsSite.parts`. `site-app.js`,
last, runs the five in order. **A page that loads `site.js` must load
all five, in this order**, or nothing runs. `window.scsSite` is the
parts' own namespace; the API for pages is `window.scs`.

The quest page's script is cut the same way, after the shared five:
`scs-2-questlist.js`, `-sheet.js`, `-controls.js`, `-map.js` and
`-screen.js`, which runs them. They share `window.scsQuestList`.

What the parts and pages share through `window` is declared in
`tab/types/site.d.ts`, and `npm run typecheck` checks every script
against it, so a new shared name goes there too.

Other shared files in `assets/`: `photo-strip` (the row of event
photographs), `slideshow` (the full-screen slideshow the gallery and
albums share), `video-sizes.js` (which copy of a video plays),
`share-image.js` (a receipt or the standings as a picture to paste),
`photo-view.js` and `photo-details.js` (used by the worker's file
pages), `push.js` (a page sliding over another on a phone). Vendored
libraries: MapLibre, ffmpeg.wasm, the HEIC decoder, mp4box, mp4-muxer,
PDF.js and the haptics library. `fonts/` holds SCS Heros, the stand-in
for Helvetica.

## What the pages read

Pages read the tab worker at `TAB_API` through `scs.fetch`, which asks
again when a request is dropped. The quest list is fetched once a visit
and its last good copy kept in localStorage. Freshness comes from the
pulse (`GET /api/pulse`): the quest list's version, the newest messages'
numbers, the urgent message that went live last, and the
after-the-event switches. A page fetches the quest list again when the
version differs from the one it has, lower as well as higher, since the
dashboard can set it back. The bell lights while the pulse names a
message the device has not read, and the urgent pop-up opens for an
urgent message it has not put away; the device keeps the messages it
has read and the urgent ones it has put away, rather than a highest
number. A signed-in team reads its own copies
through `scs.readAs`, falling back to the public read on a 401. The
endpoints are in [api.md](api.md).

## The service worker

`website/sw.js` serves pages and the site's own files from its cache.
What `PRECACHE` lists is fetched when a new version installs and not
again until the next one; anything else is refreshed in the background.
It also keeps map tiles and images in caches of their own
([architecture.md](architecture.md#caches)).

- **Bump `CACHE` in every commit that changes a file the site serves.**
  An installed app only fetches new files on a bump, and the bump is
  what puts the "SCS.2 updated" reload notice on a page left open.
- **A new file goes in `PRECACHE`**, or in `NOT_PRECACHED` in
  `tab/scripts/check-rules.mjs` with the reason it is fetched only when
  needed (the 31MB video engine, the HEIC decoder, the font, PDF.js).
- `npm run check` in `tab/` checks both rules, and that every
  `PRECACHE` entry exists. CI runs it on pull requests and on `main`.

`docs/` is outside `website/`, so editing it needs no bump.

## Settings

The gear opens the settings menu. Everything is kept in the browser.

| Setting | Stored as | Notes |
|---|---|---|
| Appearance | `scs2-theme` (`light` or `dark`) | nothing stored follows the device |
| Text Size | `scs2-font-scale` | stops from 33% to 200% |
| Push Notifications | a subscription on the worker (`push_subs`) | linked to the team once it signs in |
| Offline Map | `scs2-tile-cache`, and the `TILE_CFG` cache the service worker reads | on by default |
| App Layout | `scs2-app-layout` (`0` is off) | shown only on a handheld at 840px or less, not installed |
| Haptic Feedback | `scs2-haptics` | phones only |
| Full Screen Map | `scs2-map-full` | under Optional Visual Settings |
| Sharper Map | `scs2-map-sharp` (`1` is on) | the quest and replay maps at the screen's full density rather than at most 2x |
| Group Map Pins | `scs2-map-groups` (`0` is off) | on by default: pins close together on the quest map drawn as one disc with their count |
| Hide Checklist | `scs2-hide-checklist` | quest list only |
| Hide Dates | `scs2-hide-dates` | |
| 24-hour Time | `scs2-clock` | |
| Quest Panel Animation | `scs2-anim` | |
| Justified Text | `scs2-justify` | prose marked `data-justify` |

Other keys the site keeps include the submit session
(`scs2-submit-session`), the last good quest list
(`scs2-questlist-cache`), the quest list version taken
(`scs2-quests-seen`), the messages read (`scs2-msg-read`) and the urgent
messages put away (`scs2-urgent-dismissed`)
and the size and look of the quest map's last picture (`scs2-map-shot`,
the picture itself in a cache of the same name), which stands in the
map's place on the next visit until the map has drawn.

## The app layout and the web layout

- **App layout** (`html.is-pwa`): a handheld device (`pointer: coarse`
  or `hover: none`) at 840px wide or less, unless the App Layout setting
  is off. Each page's boot script sets the class before the first paint.
  It has a bottom bar of Home, Quests, Submit, Info and Tab, with Submit
  in the middle; Welfare becomes a heart in the top bar; page zoom is
  locked; there is pull to refresh and an install pop-up.
- **Installed** (`html.is-installed`): launched from the home screen.
  This is a fact, not a layout. An installed app wider than 840px gets
  the desktop page.
- **Web layout**: everything else. A full top bar that gives way to a
  smaller floating bar once it has scrolled away, and a footer at the
  end of the page. Below 840px every page is one centred column.

The body is the scroller (`html { overflow: hidden }`), so full-page
screenshots only capture the first screen.

## The design system in short

The full set is the root `CLAUDE.md`'s
[Hard rules](../CLAUDE.md#hard-rules), with the detail in
[`website/assets/CLAUDE.md`](../website/assets/CLAUDE.md).

- Transit wayfinding (Vignelli, MTA). Type is the Helvetica stack:
  `"Helvetica Neue", "SCS Heros", Helvetica, Arial`. No other web fonts.
- A light grey page (`--page-bg`), white bars and cards (`--surface`),
  a dark theme through `html[data-theme="dark"]`. Black signs
  (`--sign-bg`) stay black in both themes.
- The `--line-*` route colours; accent green `#00933c`.
- Square corners (2px). Round is only for the route discs (`.bullet`).
- No shadow by default. A hard offset shadow only on things off the
  page: a banner, a pop-up, a toast, a control over the map, a button
  (which its press pushes into). A box in the flow has a hairline.
- One button: 48px, bold, a 2px keyline; filled green for the one
  action a screen is for.
- O/I rocker switches for every toggle.
- Every page's name is a `.hero` in ink on the paper. Section titles are
  `h2.section-heading` under a 2px rule. No eyebrows or subtitles that
  repeat the title.
- Plain, short copy. No emoji, no hype, no mannered prose.

## The site's words

Every string the site shows is in `text/site-text.csv`. `extract.py`
writes it from the files and `apply.py` puts an edited CSV back,
bumping `CACHE` when it changes the site. See
[`text/CLAUDE.md`](../text/CLAUDE.md#editing).

## Where to read more

- [`website/assets/CLAUDE.md`](../website/assets/CLAUDE.md): the shared
  chrome, starting with "The shared script is five files"; "App layout
  on the web", "Scroll", "The settings menu's two pages", the caches,
  haptics and motion.
- [`website/questlist/CLAUDE.md`](../website/questlist/CLAUDE.md): the
  quest page, its five files, the sheet and the map.
- [`website/submit/CLAUDE.md`](../website/submit/CLAUDE.md): the submit
  page.
- [`website/compress/CLAUDE.md`](../website/compress/CLAUDE.md): the
  compressor.
- [`website/tab/CLAUDE.md`](../website/tab/CLAUDE.md): the
  live tab, team pages and the recap.
