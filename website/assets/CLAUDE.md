# The shared chrome: site.js and its parts, site.css and sw.js

Everything every page gets — the helpers, the bars, the menus, the
caches and the motion. The quest page, the tab pages and the submit
page keep their own notes beside their own code.

The proof lightbox (`scs.lightbox`) lives in site-viewer.js but is written
up in `tab/CLAUDE.md`, beside the submissions it shows.

- **The shared script is five files**, loaded by every page in this
  order, each `defer`: `site.js` (the helpers on `window.scs`: the
  layout test, `scs.fetch`, the quest list, the pulse, times, pictures,
  HEIC and EXIF, markdown, the motion helpers), `site-viewer.js` (the
  photo viewer, `scs.lightbox`, and `scs.pullTab`), `site-chrome.js`
  (the bell, the heart, the urgent pop-up, pull to refresh, the splash
  and zoom lock, the scroll memory, the theme, the back-layer stack,
  the settings menu, the scroll-linked bars, the keyboard, toasts, the
  install pop-up, the burger menu, the chrome's spacing and the floating
  top bar), `site-input.js` (slide to confirm, leaving a busy page, the
  loading bar, the bottom bar's taps, haptics and the settings menu's
  rockers) and `site-app.js` (the offline map, the service worker, the
  update pill, push and the countdown). They were one IIFE cut at its
  section headers, in its own order, so listeners still register in the
  order they did. **Each file only adds its part to
  `window.scsSite.parts`; `site-app.js`, last, runs the five in order in
  one go.** That keeps the run the page sees exactly the one the single
  file made: a promise callback or a timer set up while one part runs
  still fires after all five have run, as it did, rather than between
  two files. A page that loads `site.js` loads all five, in this order,
  or nothing runs. `window.scsSite` is the parts' own namespace, not an
  API for pages (that is `window.scs`): a name one part needs from
  another is handed over there — a function at the top of the part that
  declares it (it was hoisted, so it is there from the start), a value
  read only by later parts at the end of its part, a value an earlier
  part reads (from a callback) where it is assigned, and a variable
  that is assigned again after it is declared lives only there, as
  `site.name` in every part. A later part copies what it uses into
  locals at its top. Code moved from one part to another has to have its
  names handed over again: a name that is not shows up as a global the
  part did not use before, and as a ReferenceError when that line runs.
  `npm run typecheck` finds it before then, as a name nothing defines;
  every name on `site`, `ql` and `window.scs` is declared in
  `tab/types/site.d.ts`, so one handed over for the first time goes
  there as well. The HEIC loader finds its folder from the `site.js` script tag, so
  the first part keeps that name. Where a note below says site.js without naming a
  part, it means the five together. The quest page's own script is cut
  the same way (`questlist/CLAUDE.md`).
- **The browsers of September 2021 still have to work**, when iOS 15
  came out: Safari 15.0, Chrome and Edge 93/94, Firefox 92, Samsung
  Internet 15 (Chromium 90). What one of them does not know is dropped,
  often more than the one thing. A selector list holding `:has()` or
  `:focus-visible` loses the whole rule in Safari before 15.4, so either
  goes in a rule of its own. `:has()` itself is missing from all of them
  (Chrome 105, Firefox 121), so nothing visible may depend on it: the
  layout ones (the app's pinned row, the back button's bar, the
  footer's room) have classes site-chrome.js sets (`has-app-pin`, `has-back`,
  `has-footer`) under `@supports not selector(:has(a))`, and the page
  ones are written without it (the home photos pull up over the board's
  gap, the countdown box gets `is-over`, the gallery hides its empty row
  and the albums page its empty line from their scripts, and the tab's
  update time comes before its marks in the markup so `:empty ~ .ic`
  reaches them). Two cosmetic ones are left: the submit page's focus
  ring on an answer tile and an indent in the settings menu. `svh` (15.4,
  Chrome 108) has a `vh` line before it; `color-mix()` (16.2) a plain
  colour; `overflow: clip` (16) `hidden`. The `translate`, `scale` and
  `rotate` properties (Chrome 104) carry only nudges and the bell's and
  heart's wobble, never a position something depends on. Firefox 92 has
  no `backdrop-filter` (nothing here leans on it), no
  module workers (ffmpeg.wasm starts a classic one), no `ClipboardItem`
  (share-image.js saves the file instead) and no `inert` (set as a
  property, which it ignores). Safari still needs `-webkit-user-select`,
  and `-webkit-backface-visibility` until 15.4. The site's own scripts
  call nothing newer than these; MapLibre did, and is patched
  (`website/questlist/CLAUDE.md`, under Map), which also covers Samsung
  Internet 15, older than `Object.hasOwn` and `.at()` there too.
- **Shared helpers**: `window.scs` in site.js (`TAB_API`, `fileUrl`,
  `normQuest` (upper-case, spaces dropped, **hyphens kept** — same as
  the worker), `questList()` (one fetch of `/api/questlist` per visit,
  last good copy in localStorage `scs2-questlist-cache`),
  `markdown(text)` (the same renderer as the console page, escaped
  first), `rocker(className, text)` for O/I switch markup,
  `postJson(url, body, token)` resolving `{status, data}`,
  `chartStep(box, key, onPick)` for a submissions chart's step picked in
  its heading (the recap and a team's page; `tab/CLAUDE.md`), and
  the motion helpers, `fmtTime`). `questList()` is
  cache-first: the localStorage copy resolves at once and the network
  copy is fetched behind it and stored as last-good, **only when the
  pulse has moved off the copy**: the worker's list carries `version`
  (the quests counter it was built at, read before the list) and the
  copy keeps it with `keptAt`; `listCurrent` takes the copy as current
  while `version` is the pulse's `quests`, it is under half an hour
  old, and no quest in it asks a question with a closing time (one
  that closes leaves the list without moving the counter). A pulse
  below the copy's version is the counter set back on the dashboard and
  is fetched like one above it; it used to count as current, so a
  device that had taken a number set too high kept a stale list until
  the counter climbed back past it. Otherwise it
  fetches `/api/questlist?v=<pulse.quests>`: the query is a copy of its
  own at the edge, so a data centre that missed the purge cannot hand
  back the list from before that version. With no copy it fetches at
  once, without the query. One request per version is in flight at a
  time (`listFetching`), since the page's own check and the update
  banner can ask for the same one together. The public reads (`readAs`, the live tab, the
  slides, `/api/quests`) are fetched with `cache: 'no-cache'`, not
  `no-store`: the browser keeps the answer and sends its `ETag` back,
  and an unchanged answer is a 304 with no body that the page reads as
  the stored copy. A header the page set itself would make each request
  cross-origin preflighted, which is why the tag goes by the browser's
  cache. It no longer
  announces on a payload diff (`onQuestListUpdate` remains but nothing
  fires it): the worker's edge cache is per-colo with a per-colo
  purge, so a stale colo could re-overwrite the fresh copy and loop
  the update banner. Freshness is version-driven instead:
  `scs.pulse()` (one no-store fetch of `GET /api/pulse` per visit,
  re-checked when the page returns after >60s hidden and when a team
  signs in or out, and by the live tab once a minute through
  `scs.pulse(true)`, null on failure; every answer is also sent as a
  `scs-pulse` event on `window` with the pulse as its `detail`, for a
  page that has to follow it after its first look) answers `{quests, messages,
  message_seqs, urgent, team_pages, recap}` —
  the quests counter, the newest message seqs the reader can see, the
  urgent message that went live last, and the
  after-the-event switches (see **After the event**). **A signed-in
  team asks its own copy** (`/api/pulse/team`, and the messages and
  the urgent pop-up `/api/messages/team`), because some messages are
  for some teams only: `scs.readAs(publicPath, teamPath)` is the one
  way in, sending the submit session and falling back to the public
  read on a 401, and the quest list goes through it too. Its
  `messages` is the newest message that reader can see and
  `message_seqs` the newest fifty, so the app icon counts unread
  messages the reader can actually open. `scs.reader()` names whose
  copy a page would be shown, and a page that keeps a copy keeps that
  beside it and paints the copy only for the same reader (the messages
  page's `seenBy`, as the quest list's). **What the device has seen**
  is one number for the quests and a set each for the messages and the
  urgent pop-up.
  The quests counter is `scs.seen`/`scs.markSeen`
  (localStorage `scs2-quests-seen`), written as given in either
  direction: the counters normally only count up, but the dashboard can
  set one to any value, and the site follows any change rather than
  only a rise (the owner's call). A pulse below the stored number makes
  it the stored number and fetches the list again with no banner; from
  there a rise shows the banner as usual. Before that a lower number
  was ignored, which is what a stale colo serves for up to 30 seconds,
  but it also left a device that had taken a number set too high with
  no banner and a stale list until the counter climbed back. A stale
  colo now costs a quiet refetch, and a banner for the rise back.
  The messages and the urgent pop-up keep sets
  (`scs.seenSet`/`scs.addSeen`, a JSON array oldest first, capped):
  `scs2-msg-read`, the seqs of the messages read (200), and
  `scs2-urgent-dismissed`, the urgent ids put away (50). A single mark
  could not say that a device which read public seq 20 signed out has
  not read the team's seq 15 it finds on signing in, nor follow a
  counter set back; a set does both, and a stale colo naming an older
  message cannot bring back one already read or put away. Each set is
  built the first time it is needed, from the single number kept before
  it (`scs2-msg-seen`: every seq the pulse names at or below it;
  `scs2-urgent-seen`: that one id), and the old key is not read again.
- **Messages**: the nav bell (`.bell-toggle` before the gear on every
  page; pinned to the left end of the app-layout bar so the centred
  title stays clear; `.bell-dot` shows when the pulse's `message_seqs`
  holds a seq not in `scs2-msg-read`; a first visit with nothing stored
  has read nothing, so the dot shows for whatever is posted until the
  messages page has been opened; two faces in one grid cell like the gear —
  `.icon-bell-outline` rests, a tap adds `is-filled` and the solid
  `.icon-bell-fill` cross-fades up on the way over; the tap also adds
  `is-ringing`, a decaying swing on the separate `rotate` property so
  it composes with the cross-fade's `transform`;
  the messages page's own markup carries `is-filled` +
  `aria-current="page"`, it finishes the swing on arrival when
  sessionStorage `scs2-bell-rung` says a tap sent us (the page switch
  cuts the tap's swing short), its own bell rings in place on a tap
  instead of reloading, and a bfcache return strips both classes)
  links to `/messages/` — messages from
  `GET /api/messages` (title, `fmtTime`, markdown body, photos one
  to a row at the column's width and their own shape (`.msg-shots` is
  one column; imgs `height: auto`, capped 62vh with cover, 34vh on the
  board) opening
  into `scs.lightbox`, plain link rows for other files; the payload's
  array order IS the display order; last-good copy in localStorage
  `scs2-messages-cache`; the page is three edges, one job each
  (`.msg-row` in messages.css: the time, the reading measure, then
  what the message brought with it — its photos, then its files with
  their sizes; two tracks under 940px, one column under 700 with the
  time as a stamp above the headline). **The newest message is drawn
  on the black board at the top when it is flagged urgent**
  (`.msg-notice`, the page's largest type, Urgent in `--alert-sign`
  because the paper red buzzes on a sign) and the rest read under an
  Earlier heading; the board only ever takes the *first* message the
  payload carries, so it is a place on the page rather than a
  reordering. No cards: a message is a time, a headline, a body and
  rows of what came with it, on a hairline. Bodies render through `scs.messageBody` —
  markdown plus quest embeds: a line of its own reading
  `[[quest:SQ40]]` becomes a card with the quest's chip, name, points
  and location, an Open quest link to `questlist/#KEY` and a Submit
  proof link to `submit/#KEY`; the card is built at once with working
  links and `questList()` fills the name behind it; the urgent pop-up
  renders bodies the same way, and any link tap inside it dismisses
  it), and the site's own O/I rocker near the top of the page on
  `scs.pushSub` (`.msg-set`, a plain `.sub-check` label rather than a
  card of its own, the bell beside its name and no word for the state:
  a change that went through says so in a toast, "Push Notifications
  for Announcements On" or "… Off", and one that failed puts the switch
  back and says why in the hint under it;
  `{supported, state, enable, disable, hint, label, platform, paint}` — the
  settings-menu rocker is rebuilt on the same helper. **Where push
  cannot be had, the wording depends on the phone** (`platform()`:
  `ios`, `android` or `other`): the settings menu tells an iPhone to
  install the app with Share and Add to Home Screen, with the Share
  icon drawn into the line (`[share]` in the hint, drawn by `paint`),
  and an Android phone to open the site in Chrome and install it; a
  desktop keeps "This browser does not support notifications." The
  messages page on a phone only points at the settings menu, so the
  instructions are written once; the page's own
  control is `msg-push`, never `set-push`. **One change at a time across
  the two**: `enable`/`disable` count as busy (`busy()`) until they land
  and then send `scs-push-changed`, on which the other switch reads the
  state again; a tap while one is busy puts its box back, since the
  browser has already flipped it. `unlink()` is the team signing out
  (below). `label()` is a first guess
  at what this device is, from the user agent, `'<device> app'` under
  `html.is-installed`, sent with the subscription by `enable()` and by
  the submit page's `linkPush`: all the worker otherwise holds is an
  opaque endpoint, so without it the dashboard's device list cannot
  tell two phones on the same team apart. The worker never writes a
  guess over a name an organiser chose). **The page marks read exactly
  the messages it drew** (`scs.readMessages(seqs)`, from the cached copy
  and again from the worker's): each message in `/api/messages` carries
  its `seq` (0 for a silent one). It used to mark the pulse's
  `messages` after drawing the list, but the pulse and the list are
  separate edge-cache entries, so a newer pulse marked read a message
  the page never drew. A list with no `seq` on it at all is from a
  worker older than that, and then what the pulse names is marked, as
  before. `syncBell` also sets the installed app's icon badge
  (`navigator.setAppBadge`, count = the seqs in `message_seqs` not in
  the set, cleared at zero; browsers without the API skip it silently).
  An `urgent` pulse id not in `scs2-urgent-dismissed`
  shows a dismissible site-wide pop-up (`.urgent-*`, z1450,
  back-layer armed once, Escape/backdrop/Dismiss/link all add the
  id; waits for load + a beat so it cannot fight the splash, and for the
  slideshow (z1600, above it) to end; reads the set again as it
  opens, so a check started before a dismiss cannot reopen it; on the
  messages page it only adds the id). It used to show only an id above
  a forward-only mark while the worker named the newest id, so a
  message that went live after a newer one was written (a scheduled
  publish, a draft published, an edit to urgent, an unarchive) never
  popped up; the worker now names the one that went live last, by seq
  (`tab/CLAUDE.md`). The `#ql-update` banner is
  version-driven too: `pulse.quests` beyond `scs2-quests-seen` shows
  it (nothing stored = store silently, no banner), close stores
  seen, tap refetches the list at the pulse's version
  (`scs.fetchQuestList(pulseQuests)`), stores it + seen, reloads;
  on failure nothing changes and a toast says so. `pulse.quests` below
  the stored number stores it, takes the banner down if it is up, and
  fetches the list at that version without reloading.
  `tests/verify-bell.cjs` covers all of it. Every page script uses them; the quest list
  still has its own `TAB_API` constant for the stats call. Pull to
  refresh: `main[data-pull]` (quest list, submit, live tab, messages)
  on phoneish devices: the page itself follows the finger down
  (`html.is-pulling main[data-pull] { transform: translateY(--pull) }`,
  `240·d/(d+240)`, transform only while pulling so the fullscreen
  map's fixed layers are untouched) and the `.ptr` arrow rides with
  it: it is the page's first child, `position: absolute; top: -44px;
  z-index: -1` inside `main` (`position: relative; z-index: 1`, opaque
  under `html.has-pull`), so at rest it is wholly in the strip the
  fixed bar covers and a pull carries it out from under the bar into
  the gap above the content — it can never be drawn over content. The
  first downward touchmove at the top of the page is cancelled before
  the browser can start its own pan (once a native pan has begun no
  later cancel stops it, and iOS then dragged the page a second time);
  an upward or sideways first move leaves the page to the browser but
  the touch is still watched (`pullNative`): if it scrolls back to
  the top and keeps pulling, the browser's own bounce carries the
  arrow out, the arrow arms from the finger alone, and the release
  still reloads — without this an up-then-down gesture showed the
  arrow (the bounce) but could never arm it. The body keeps
  `overscroll-behavior-y: contain`, so the page bounces at both ends.
  **A row under the bar holds still** — the quest list's chips
  (`.app-pin` in the markup). In the
  app layout on a phone it is `position: fixed` under the bar rather
  than sticky, and the page makes room with its top padding, `--pin-h`
  (site-chrome.js, a ResizeObserver on the row, skipped while the chips are
  away in the full-screen map's search panel). Sticky, it was part of
  what scrolls, so the bounce at the top dragged it down with the page;
  fixed, the page bounces under it. Turning the bounce off at the top
  instead was tried and taken back: a flick up to the top of the quest
  list stopped dead where every other page bounces. A pull moves
  **everything in `main` but the row** (`translate: 0 var(--pull)` on
  `main[data-pull] > :not(.ptr-still)`), not `main` itself, because a
  moved `main` carries its fixed children with it; `translate` rather
  than `transform`, so the arrow keeps the transform that centres it.
  At the start of each touch at the top, `measurePtr` marks a sticky or
  fixed child of `main` whose top is the page's top `.ptr-still` and
  writes how far down it ends into `--ptr-lift`, where the arrow parks,
  so a pull or the bounce brings it out from under the row. A sticky
  row further down, under the web layout's title band, moves with the
  page. The arrow flips at 72px of finger travel; release past that
  eases the page back (`html.is-pull-settling`) while `.ptr-bar` runs
  650ms, then `location.reload()`; an early release eases it back too.
  With a leave guard up (an upload) the reload goes through the same
  slide-to-confirm a link does, and the pull settles; a reload the
  browser's own question stops puts the pull back after ten seconds
  rather than leaving the bar running.
  Touches starting on the map, sheet, search panel, menus, sliders or
  any layer over the page (`pullSkip`: `.confirm-overlay`, the
  lightbox, the urgent pop-up, the install nudge, the update banner,
  toasts) are ignored — the slide-to-confirm taught this: its drag also
  fed the pull, which moved the page under the overlay and could
  reload, so the slider's class and that list change together. Forms
  share `.sub-field/.sub-hint/.sub-status/.sub-check/.pill` in
  site.css, and the team sign-in card (`.sub-signin`, `.sub-bar-btn`)
  is there too because the submit page and the gallery both draw it;
  page CSS holds only page-specific rules.
- **App layout on the web**: a handheld browser gets the app chrome by
  default. **A handheld, not a narrow window**: `handheld()` in site.js
  is `(pointer: coarse)` or `(hover: none)` — what the device points
  with, which is a better question than the user agent (iPadOS calls
  itself a Mac, any UA string can be changed, and a touchscreen laptop
  with a trackpad answers these two honestly: fine, and it hovers).
  Width alone used to decide, so dragging a desktop window narrow put
  the app chrome on, locked page zoom and offered to install the app.
  The per-page boot script stamps `is-pwa` when `handheld()` **and**
  `(max-width: 840px)` match and localStorage `scs2-app-layout` is not
  `'0'`, so there is no flash; a real standalone launch stamps
  `is-installed`, and `is-pwa` up to the same 840px whatever the
  setting says. **Wider, the installed app is the desktop page** (an
  iPad on its side, a large phone turned): the app layout's rules all
  sit under `max-width: 840px`, and an installed app stamped `is-pwa`
  at 1180px got the desktop bar over a page spaced for the app's, the
  page's name under the bar, the phone's search bar and camera button
  floating over the desktop page and no bottom bar. `syncAppLayout()`
  follows the width for the installed app too, and the chrome is
  measured into `--nav-h` whenever the installed app is not in the app
  layout (in it, the property is taken off and the CSS sizes the bar).
  `verify-app-layout.cjs` opens an installed app at 1180px. Keep the two apart: `is-pwa` is the *layout*
  (chrome, tab bar, paddings) and `is-installed` is the *fact* — the
  splash and `storage.persist()` key off `installed`, never the class.
  **The session scroll restore is the exception**: it runs in the app
  layout whether installed or not (`installed` or `is-pwa` at load, and
  both boot-script branches veil `main` with `scroll-restoring` for it),
  because switching pages from the bottom bar is the same thing in a
  phone's browser; it was installed-only, and there the quest list came
  back at the top every time. It skips a URL with a `#` (a link to a
  place on the page goes there), tries again every time `main` changes
  height (a ResizeObserver — the quest list builds its list in a script
  that runs after site.js, and the load event waits for the map, so
  tries at fixed moments fell between the two on a phone), and gives up
  at 900ms, the boot script's own veil timeout. The settings menu's **App layout**
  rocker (`set-app-layout`) writes the key and calls `syncAppLayout()`,
  which toggles the class live; the row hides itself under
  `html.is-installed`, above 840px, and under
  `(hover: hover) and (pointer: fine)` — the CSS mirror of the same
  test. site.js keeps the class in sync as the window resizes *and* as
  the pointer changes (a mouse plugged into a tablet), and the ordinary
  chrome measures `--nav-h`/`--footer-h` whenever the page is *not*
  installed (either layout), so switching back needs no reload. A **turn is
  not one resize**: iOS fires one partway through the rotation and the
  browser's own bars — one row or two, depending which way round it is
  — settle after that, so the height measured during the turn is not
  the height the bar ends at, and the content was left spaced for the
  old one. `orientationchange` measures again at 120ms and 450ms.
  The rules that stop a phone's history swipe and its page zoom below
  840px (`overscroll-behavior-x: none`, `touch-action: pan-x pan-y` on
  `html:not(.is-pwa)`) are scoped to a handheld by the same two media
  features, in site.css: on width alone they took
  a narrow desktop window's trackpad back and forward swipe away.
  The zoom lock appends `maximum-scale=1` ONLY — never
  `user-scalable=no`, which home-screen apps on older iOS honour
  fully and which has kept the keyboard from rising on a focused
  input there. The boot script's `show-splash` and `scroll-restoring`
  veils each carry their own inline setTimeout removal (4000/900ms)
  in the page HTML, so a site.js that never runs cannot leave the
  splash or an invisible `main` up — that was the quest page's
  intermittent "frozen, nothing loads".
  `tests/verify-app-layout.cjs` covers it.
- **Scroll**: `html{overflow:hidden}`, body is the scroller. `.site-nav`
  is `position: fixed` and the content is spaced by `--nav-h`, measured
  in site-chrome.js. **The footer is in the flow at the end of the page**: it
  was pinned to the bottom of the screen with the page sliding off it
  at the end of a scroll. `main` has a `min-height` of the screen less
  `--nav-h` and `--footer-h` (both measured), so on a short page the
  footer still sits at the foot of the screen. `main` keeps
  `position: relative; z-index: 1` from then, because the page's own
  fixed pieces are stacked inside it, under the bar. Chrome hides on scroll down, returns on a firm
  upward flick (`phoneish` in site.js = the app layout, or a handheld
  at ≤840px — it gates page-zoom locking, the edge-swipe cancel,
  pull to refresh and the install nudge, none of which belong to a
  small desktop window). One document
  click listener closes the settings menu on an outside tap; Escape
  closes it too.
  **Two gesture guards cancel touchmoves, and both have to let a
  side-scroller through** (`scrollsSideways(node)` in site-chrome.js). The pull
  claims the first downward move at the top of
  the page outright, because once the browser has begun its own pan no
  later cancel stops it — and it cannot yet tell how far sideways the
  finger is going. The edge-swipe killer cancels *every* horizontal drag
  anywhere on the page, because iOS runs its history swipe from a press
  that began nowhere near an edge. Between them they made the quest
  list's chip row unscrollable on every phone, on the page and in the
  fullscreen search panel alike: the row is a horizontal scroller, and a
  scroller's pan IS a horizontal drag. The guards used to skip a
  hardcoded list of class names, which went stale the day the chip row
  was built; they measure instead — an ancestor that overflows sideways
  with `overflow-x: auto|scroll` owns the touch. The map and text fields
  are still named (`PANS_SIDEWAYS`), because they pan without being
  scrollers. `verify-questlist.cjs` holds it: a guard in one file
  silently disabling a control in another leaves nothing on the page to
  show for it.
- **Submit in the bottom bar**: in the app layout the middle of the
  bottom bar is Submit — a tab like
  the other four, the floating button's camera, filled and lit in the
  purple the desktop menu gives Submit a Quest when you are on it —
  Welfare moves to the top bar as a heart hard
  against the bell (`.welfare-toggle`, solid on its own page via
  `is-active`), and the floating button is not drawn. The heart does
  what the bell does: its two faces share the bell's cross-fade rules,
  a tap adds `is-filled` and `is-beating` (two beats on the separate
  `scale` property), sessionStorage `scs2-heart-beat` has the welfare
  page finish the beat on arrival, and there a tap beats in place. Its
  glyphs are lifted 1px (`translate`), because the bell's weight is its
  dome and a heart centred on the same line read as sitting lower. It
  used to be a setting (`scs2-bar-submit`, with `html.submit-float`
  putting Welfare's tab and the floating button back); the committee
  took the setting out, so this is the only arrangement and a stored
  `'0'` is ignored. Every bar still holds **six links and shows five**
  (Welfare's tab is the hidden one), and the tabs are coloured by page
  (`.tab-home` … `.tab-tab`) rather than by `nth-child`. The iPhone tap
  switches are placed over the shown five only. With the heart in, a
  centred page title loses 188px rather than 108, and below 440px the
  home page's bar is the mark without the season's name.
- **The bottom bar's icons are drawn to one set of proportions**, the
  keylines a balanced icon set keeps on a 24 box with a 2-unit line:
  the info circle is 20 across, the pin 16 by 20, the camera and the
  heart 20 wide and about 17 to 18 high, the house about 18.7 square
  and the trophy 19 by 20, each centred on the middle of the box to
  within 0.15. They drifted apart one icon at a time — the house was
  20 by 20 and read as the biggest thing on the bar, the trophy sat
  half a unit low with its cup floating over the stem — and nothing
  but the eye catches that, so a new icon is measured against these
  rather than drawn to fill the box. **A tab lit up must not change
  size**: the filled face is the outline's own drawing, filled and
  still stroked 2 (the pin, camera, heart and trophy; a hole in it is
  drawn a unit wider to allow for the line), or a fill scaled to the
  same box (the house, whose door has to reach the ground). The fills
  used to be the bare shapes and came out up to 2 units smaller than
  the outlines, so a tab visibly shrank when you landed on its page.
  **Centred on the box is not centred to the eye**: the trophy and the
  pin carry their weight high and the house low, so in the bottom bar
  each glyph is moved by its viewBox (house `0 0.75`, pin `0 -0.55`,
  trophy `0 -0.95`, both faces) until the midpoint of its box and its
  ink's centre of weight sit on 12. A viewBox keeps the drawing on the
  pixel grid, where a CSS transform of under a pixel blurs it. The
  camera's lens sits at 12.5 rather than the body's middle, 13, which
  read as too low.
- **There is no floating submit button.** A green Submit a quest
  button used to sit in the bottom corner of every page (`.fab-wrap`).
  The web has Submit a Quest in its bar or burger and the app layout
  has Submit in the bottom bar, so it had been `display: none` in every
  layout while its markup shipped in every page, its rules in site.css
  and `liftFab` measured `main` on every scroll for it. All of that is
  deleted; where these notes still mention the floating button they are
  describing how something came to be. The one thing that read its
  numbers, the quest page's search bar, measures the footer for itself
  (`--ql-pill-lift`, `placePill` in the quest page's controls).
- **While the keyboard is up** (`html.kb-up` and `--kb-inset`,
  `syncKeyboard` in site-chrome.js). A phone's keyboard
  takes the bottom of the screen and the app's bottom bar was left
  sitting in the gap between it and the field being typed into — a row
  of places to go, in the way, while somebody is typing. The class is
  set whenever a text field (or a textarea, or anything
  contenteditable) has focus on a handheld; the bar slides out, and
  the floating button and the quest page's search bar drop into the
  space it leaves. **Browsers differ about the viewport and both are
  covered**: the installed app and Android resize the view, which puts
  a fixed bottom above the keyboard already, so `--kb-inset` is 0;
  Safari in a tab leaves the layout viewport at its full height and
  lays the keyboard over it, so `--kb-inset` is `innerHeight` minus the
  visual viewport's height and offset, and everything pinned to the
  bottom adds it. `focusout` waits a beat before re-reading, so moving
  between two fields of one form does not flash the bar back between
  them.
- **The chrome's own colours** (`--bar-bg`/`--bar-ink`/`--bar-muted`/
  `--bar-edge` in site.css).
  Three things take them and nothing else does: `.site-nav`,
  `.site-footer` and the app's `.tab-bar`. The lightbox had a bar of
  them too and now has none: its name and buttons float over the photo.
  They follow the theme — white over the grey page in the light theme,
  a shade lighter than the page in the dark one — with a `--bar-edge`
  hairline as the boundary. A hover in the bar is `--bar-hover`, the
  grey `--tint` in the light theme and a grey lighter than the bar in
  the dark one. **The hairline is a `border`, not a layer
  under the bar**: site-chrome.js measures `--nav-h`/`--footer-h` off
  `offsetHeight`, so a border rides along and the content below starts
  clear of it with nothing written down, where the old absolutely
  positioned stripe did not and overhung the page by its own ten
  pixels. `--sign-bg`/`--sign-ink` are a different thing and did not
  move: they are the black *objects* — heroes, plates, the quest sheet,
  the submit board, a picked chip — and stay the same in both themes.
  The app bar's five route colours light the active tab, and
  `--tab-yellow` is the one that could not come across: the line yellow
  is 1.6:1 on the light bar, under the 3:1 a solid glyph needs, so it
  takes a darker gold there and the line yellow in the dark theme.
  `syncThemeUi` writes `--bar-bg` into `meta[name="theme-color"]`, so
  the browser's own chrome is the bar's colour. It runs again when the
  layout changes.
- **On the web the full bar gives way to a floating one**
  (`html:not(.is-pwa)`, `syncFloatNav` in site-chrome.js; the app layout keeps
  its full-width bar). At the top of the page the bar is the ordinary
  full-width one, and as the page scrolls it goes up with it
  (`--nav-scroll`, the scroll up to the bar's height, read as a
  `translateY`). Once the page has scrolled past the bar's height,
  `html.nav-float` turns it into the floating bar: `.site-nav` becomes
  only the gap, 8px above and 12px either side, transparent and
  `pointer-events: none` so a tap in the gap reaches the page, and
  `.site-nav-inner` is the bar, `--bar-bg` with an inset hairline ring
  (`--bar-edge`, `--sign-edge` in the dark theme), square corners and
  the hard offset `--shadow` the map's buttons and the PDF page's
  controls carry, since it sits off the page, 1220px at most so
  the brand lines up with the page's 1180px
  column. On a phone it keeps the old behaviour: scrolling down hides it
  (`nav-up`, which also floats it straight away if the full bar was
  only just leaving), scrolling up drops it in. Back at the top it widens
  into the full bar again; if it was hidden when the page came back
  within the bar's height, it goes back to the full bar there rather
  than dropping in as the floating one for a moment. `--nav-h` stays
  the full bar's height throughout, so the page is spaced the same
  either way and nothing jumps when the bar changes. `syncChromePad`
  does not measure while it floats; a text size or layout change made
  then is measured once the full bar is back (`padStale`). Near the top
  `syncFloatNav` alone moves the bar: the phone's hide-on-scroll leaves
  it be within the full bar's height. A menu or the settings panel
  open holds the bar as it is. The burger menu inside the floating bar
  is pulled 12px left and made 12px wider, so it sits 8px in on both
  sides; pulled without widening it sat 8px from the left and 20px from
  the right. The quest list's stuck chip row paints its ground 16px up
  behind the floating bar (a `box-shadow`, since the row clips
  anything drawn outside it), or the page showed in the strip between
  the bar's foot and the row.
- **The cutout, once the bar has gone** (`html.is-pwa::after`). The bar
  covers the notch while it is there — its `padding-top` IS
  `env(safe-area-inset-top)`. The strip painted on the body's
  background is only there to stop a paper flash on a page switch: a
  background sits behind the element's own content, so it covers
  nothing, and text scrolled straight up under the notch once the bar
  slid away. `html::after` is the band that does cover it — the height
  of the inset in whatever colour is under the notch (`--cutout-bg`,
  below), faded in on `html.nav-up` at z1099, under the bar and over
  the page. On a screen with no inset it has no height and draws
  nothing. `body::after` is the quest page's sheet dim and must not be
  taken for this.
- **Back-layer stack** (`window.scsBackLayer` in site-chrome.js): every transient
  layer (settings menu, fullscreen map, quest sheet, map search,
  camera review) arms one history entry; system back closes layers one at
  a time. UI dismissals call `disarm(layer)` which does `history.back()` —
  the popstate does the single stack pop. Never pop twice. **The popstate
  reads the entry it lands on**: each entry carries its depth and a mark
  of the page load that pushed it (`{scsLayer, scsMark}`), and every layer
  above that depth closes; an entry that is not one of this load's layers
  (the page, an entry left by an earlier load) is below them all. A fragment link, which lands on an address the
  top layer was not opened at (each layer keeps `href`), still takes the
  top layer only. It used to pop the top layer on any
  popstate, so a page's own step back closed the settings menu and a
  closing menu's step undid the page's. A page that keeps entries of its
  own asks `ownPop(e)` (the step a `disarm` caused) and waits on
  `after()` before pushing or going back. **A page that rewrites its
  address passes `history.state` through** (`replaceState(history.state,
  …)`, the info page's fold links and the albums page's filters): `null`
  there wiped a layer's `{scsLayer, scsMark}` when the settings menu was
  open, and back then no longer closed it.
  **Only the top open layer answers a key**: a keydown reaches every
  listener and the layer opened first hears it first, so one Escape
  closed every layer at once. Each layer's handler returns unless
  `isTop(layer)` and the event is not `defaultPrevented`, and
  preventDefaults the Escape it takes; `isOpen()` says whether any layer
  is up (push.js stops a swipe on it). The quest page's own handlers are
  in `questlist/`.
- **Slide to confirm** (`window.scs.confirmSlide` in site-input.js,
  `.confirm-*` in site.css): the two-step panel in front of something
  that cannot be undone. Step one is a thumb that has to be slid the
  whole way across and **released past 92% of the run** — letting go
  earlier, or after sliding back, eases it home and decides nothing,
  and the arrow keys walk it for a keyboard. Step two is a plain
  button, red as words (`.btn-danger`), with Cancel holding the focus
  so a stray key press is safe. Options: `title`, `copy`, `slideLabel`,
  `confirmTitle`, `confirmCopy`, `confirmLabel`, `cancelLabel`,
  `onConfirm`, `onCancel`; every one has a default, and it returns
  `{close}`. The question sits on the card's own sign bar rather than
  under an eyebrow repeating it — one black object, three type sizes,
  the track's label in the site's uppercase label voice. It arms one
  back layer and dismisses through `disarm`, and a click on the ground
  is ignored for the first 400ms so the tap that opened it cannot close
  it again. The quest list's Reset progress is the first caller.
  `.confirm-overlay` is in `pullSkip`; rename one and change the other.
  **Step one becomes step two in the same card** (`step()`): the panel
  that arrives raises itself out of a blur (`.is-stepping`) while the
  card is tweened between the two heights from script, because the
  height it is going to is only known once the new panel is in. It used
  to be an outright replacement and the box jumped, which is the one
  moment in the flow where the reader has to look again to work out what
  changed. **`copy` says a consequence or nothing.** It carried "Slide
  all the way to the right and let go there." on every caller, which is
  the track's own label saying itself again a size larger — the thumb,
  the arrow and the word Slide are the instruction.
- **Pull tabs** (`window.scs.pullTab(panel, opts)` in site-viewer.js, `.pull-tab`
  in site.css): a pane that came in from an edge of a phone's screen
  slides back off it by a tab, the way the quest sheet does, and the tab
  is the quest sheet's: two halves hinged in the middle that fold into a
  v pointing the way the finger is going, and lie flat and stretch with
  the rubber band when it is pulled against the way that closes. A
  finger on the tab (or `opts.handle`) drags the pane either way; one
  anywhere else on it drags it only if its first move is the closing
  way with the pane's content already at that end, and is otherwise
  left to scroll the content — the decision is made on the first move,
  because once the browser has begun its own pan nothing stops it.
  Released past a third of its height or flicked, it slides out and
  `opts.close()` runs once it is gone; short of that it springs back on
  the quest sheet's overshoot. A mouse drags it by the tab alone. The
  viewer's Details sheet is the one pane with it (under 761px at any
  pointer, where it replaces the close cross for a finger and the photo
  grows into the room the sheet gives up). The settings menu, the quest
  filters and the install pop-up had it for a day and lost it again:
  nobody expects to drag those.
  `verify-app-layout.cjs` slides the Details sheet shut by its tab.
- **Leaving a busy page** (`window.scs.guardLeaving(fn)` in site-input.js):
  while `fn()` returns a reason string, a click on any link that would
  leave the page opens that same confirm instead, and the page only
  changes once the reader has slid across and confirmed. `''` or null
  lets them go, and the call returns a function that takes the guard
  off. Two listeners, both capture-phase on the document so they are
  ahead of everything on the page: one for clicks (nav, footer, bottom
  bar, floating button) and one for touch releases, because the bottom
  bar navigates on the *release* of a tap made mid-scroll before any
  click arrives — that one stops the event and preventDefaults the
  click that would follow, and only ever fires on a tap that travelled
  less than 10px, which is inside the pull's own 12px slop, so no pull
  is left half done. In-page `#` anchors, `javascript:`/`mailto:`
  hrefs, anything with a `target`, downloads, the page itself and
  modified clicks (ctrl/cmd/shift/middle) are all let through. The
  first guard also arms a `beforeunload` as the backstop for closing
  the tab, typing an address or a reload, which is the one place the
  browser's own dialog cannot be avoided; confirming a guarded link
  stands that down so the reader is not asked twice. A question asked
  while a slide-to-confirm is already up is refused rather than opened
  behind it, since that panel would never answer. The submit page, the
  compress page and the albums page (while a file is being added) guard.
- **HEIC and WebP become JPEG before they go up, with their EXIF**
  (`scs.needsConverting(file)`, `scs.toJpeg(file)` in site.js; the
  dashboard page has its own copy, since it does not load site.js:
  `jpegPicks` makes the same JPEG with the EXIF copied in for proof and
  album photos, with the EXIF reader copied from here, and `pngPicks`
  makes a PNG of the pixels for everything else, which keeps a
  transparent picture transparent; a fix to the reader goes in both). An iPhone
  photo is HEIC, which only Safari can show, and WebP is a picture the
  worker's metadata stripper cannot read, so neither could be served
  back to anyone else. `toJpeg` resolves a JPEG `File` at quality 0.92,
  drawn over white so a transparent part does not come out black, with
  the same name ending in `.jpg`; a file that is neither comes back
  untouched, and one nothing can decode rejects, so the callers send the
  original. It made PNG until a 24 to 48 megapixel photo turned out to
  be 30 to 60MB as one: over the 32MB the worker then read whole to
  make its cleaned copy, so those photos never had a full-size public
  copy.
  **The EXIF is copied across** (`scs.exifOf(file)` resolves the
  original's TIFF block, or null). A WebP keeps it in an `EXIF` chunk of
  a VP8X file whose header has the EXIF flag set (some writers start it
  with `Exif\0\0`; both are read). A HEIC keeps it as an item: the
  top-level `meta` box's `iinf` has the entry whose type is `Exif`,
  `iloc` gives that item's extents (in the file, or in the meta box's
  `idat`), and the item's first four bytes give the distance from there
  to the TIFF header. Only the bytes needed are read, with `File.slice`:
  the head of the file, the chunk or box headers on the way, the meta
  box and the item. The block goes into the JPEG as an `APP1` segment
  straight after the SOI, with Orientation (`0x0112` in IFD0) set to 1
  because the canvas has already turned the picture upright; nothing
  else in it is changed. The worker then treats the photo like any
  camera JPEG: the public copy loses the block, `.x` keeps it, and the
  dashboard's "where was this taken" panel reads it. **A failed copy
  never stops an upload**: an EXIF that is missing, unreadable or too
  big for one segment (64KB) leaves the JPEG without it, exactly as
  before. Decoding is `createImageBitmap`, then an `<img>`, then for
  HEIC the vendored **heic-to 1.6.5** (`assets/heic/heic-to.js`,
  LGPL-3.0, global `HeicTo`, asked for an `ImageBitmap` so its picture
  goes through the same canvas), found beside site.js and **loaded on
  demand, not precached** — it is 3MB and only a phone that is not
  Safari ever needs it, the same reason ffmpeg-core is not. A HEIC is
  known by its type or, when a browser gives none, by its extension. A
  picture over 16 megapixels is scaled down to that (iOS's canvas
  limit). `verify-submit-page.cjs` converts a WebP carrying GPS and
  reads a synthetic HEIC's EXIF.
  **The file as picked goes up too**, beside the JPEG, and the worker
  keeps it at `<key>.p` (`tab/CLAUDE.md`, The file a photo was picked
  as). `scs.pickedType(file)` says what it is, from its type or, where a
  browser gives none, its extension, and the pages send it under that
  type (`file.slice(0, file.size, type)`), or with no type at all when it
  goes straight to R2. The submit page hangs it on the JPEG as `.picked`
  (`convertPicked`); the album page keeps it on the job, so a Try again,
  which starts from the JPEG, still has it. It carries the location, so
  the viewer offers it only where the original is offered: an album
  showing details gives Download a menu of the JPEG and the original
  (the lightbox's choice of file, in `tab/CLAUDE.md`).
- **PDF.js** (`assets/pdfjs/`, 4.10.38, Apache-2.0: `pdf.min.mjs`, its
  worker and the licence) is not used by any page of the site. The tab
  worker's file pages load it from here to draw a PDF page by page and
  lay each page's text over it with its `TextLayer` (`tab/CLAUDE.md`),
  which is why `netlify.toml` sends that folder with an open CORS header
  and a JavaScript type. A new copy has to keep `TextLayer` and its
  `--scale-factor`, which the page's zoom runs on, and the link
  annotations' checked `url` and `dest` with `getDestination` and
  `getPageIndex`; `verify-gallery.cjs` draws a PDF through this folder,
  selects its text and follows its links. Not precached:
  the site's service worker never sees those requests.
- **ffmpeg.wasm**, for the compress page (`website/compress/CLAUDE.md`).
  `assets/ffmpeg/` is `@ffmpeg/ffmpeg` 0.12.15's UMD build (`ffmpeg.js`,
  global `FFmpegWASM`, and its class worker `814.ffmpeg.js`) and the
  single-threaded `@ffmpeg/core` 0.12.10
  (`ffmpeg-core.js` and its 31MB `.wasm`); `assets/ffmpeg-mt/` is
  `@ffmpeg/core-mt` 0.12.10 (the core, its 31MB `.wasm` and
  `ffmpeg-core.worker.js`, the thread script), the UMD files as
  published except one value: `ffmpeg-mt/ffmpeg-core.js` starts 18 worker
  threads where it shipped with 32 (`pthreadPoolSize`), which
  `website/compress/CLAUDE.md` explains; a new copy of the core needs the
  same edit. Both cores are GPL-2.0-or-later builds of FFmpeg with x264
  and ship no licence file of their own; the source is
  github.com/ffmpegwasm/ffmpeg.wasm. Neither core is precached: only a
  run needs one, and the service worker keeps it the first time. The
  threaded core runs only on a cross-origin isolated page, which is why
  `netlify.toml` sends the isolation headers on `/compress/*` and
  `require-corp` on `814.ffmpeg.js` and everything in `ffmpeg-mt/`.
  Both folders are left out of the lint and the type check.
- **The compressor's demuxer and muxer**, loaded by `compress/webcodecs.js`
  when a run starts (`website/compress/CLAUDE.md`, Two ways to compress).
  They are not precached: together they are about 400KB and only a run
  needs them, so the service worker keeps them the first time one loads
  them, like any same-origin file. **mp4box 2.4.1** (`assets/mp4box/`, BSD-3-Clause): the
  published ES module build, three files, taken by `import()`; it is only
  shown a moov, for the tracks and sample tables. The 0.5 line has a
  classic-script build but cannot find the AAC setup inside a QuickTime
  sound description, which an iPhone-style MOV has. **mp4-muxer 5.2.2**
  (`assets/mp4-muxer/`, MIT): the published IIFE build, global
  `Mp4Muxer`. Both are the files as published, `sourceMappingURL` lines
  included, with their licences.
- **A page pushed over another** (`assets/push.js`, `window.scsPush`,
  styles under `.push-*` in site.css): a team's page and the recap over
  the tab, a quest's page over the recap (`tab/CLAUDE.md` has which
  and why). The page it came from keeps its `main` as the link is tapped:
  any `a[data-push]` in the app layout makes site-input.js write sessionStorage
  `scs2-under:<the pushed page's path>` with that page's path (`from`),
  its `main`'s `outerHTML`, its rectangle on screen, the window's width
  and the time. **push.js is loaded at the top of the body, not
  deferred**, so its work is done before the first frame: straight
  after such a tap (the copy under eight seconds old, the navigation an
  ordinary one, the referrer the kept page, the same width, motion
  allowed) it builds `.push-under` (fixed, the copy at the kept
  rectangle, so it is where that page was scrolled, `inert`) and
  `.push-sheet` (paper with a hairline down its left edge that moves with
  the page) and puts `push-in` on `<html>`, which holds `main` off to the
  right from the first paint; once `main` is parsed it slides in on
  `--duration-slow` while the copy moves a third left, and
  `scsPush.ready` resolves when it has. **The copy is a `main` too**, so
  it is moved to just after the page's own as soon as that is parsed
  (a MutationObserver), and push.js finds the page's own as `body > main`:
  built first, the copy was what every `document.querySelector('main')`
  found, and the slide moved the copy. A swipe in from the left edge
  (within 24px, the first move deciding, released past 35% or flicked)
  and the arrow, the web's line over the name and the bottom bar's link
  to the parent go back: through history when the referrer is the page
  the copy is of or the parent the arrow names, to the arrow's address
  otherwise, the page sliding off first in the app layout. A swipe is
  ignored while the viewer or a pop-up card is open. **Nothing here uses
  view transitions**: a cross-document one draws the arriving page live,
  waiting on its main thread, and on an iPhone that stalled the slide
  half way while the page was loading.
- **A photo on the whole screen for the worker's file pages**
  (`assets/photo-view.js`, `window.SCSPhotoView`). The tab worker's
  `/photo/`, `/view/` and file pages do not load site.js, so they cannot
  open `scs.lightbox`; they load this from `SITE_URL` as a plain script
  (no CORS needed) and a tap on the photo opens it. `open({src, alt,
  caption, ratio, origin, buttons, onClose})` answers `{swap(url),
  close()}`: it grows out of `origin` and shrinks back into it, fits the
  photo to the screen with container units as the lightbox does, puts
  `buttons` (`{label, icon, onClick}` or `{label, icon, href, download}`)
  beside its Close, and `swap` puts a larger copy in without moving the
  zoom. **Its zoom is a copy of the lightbox's `armZoom`** — rubber band,
  momentum, the edge spring, the two-finger pan, the size band past 1x
  and 5x, double tap, a mouse click about the point clicked, the wheel
  and + / - / 0 — so a change to how one moves goes in the other. A swipe
  up or down closes it, one tap puts the photo alone on black, and it
  pushes a history entry so back closes it rather than leaving the page.
  It injects its own styles, always dark, at z15 so the page's own
  sheets (z20) come up over it, and ignores a key a layer over it has
  marked used. Not precached: nothing on the site loads it.
  **A photo's details as rows** (`assets/photo-details.js`,
  `window.scsPhotoDetails.rows(info, video)`), from the answer
  `/api/albums/info` gives: when it was taken (on the clock where it was
  taken when the phone wrote its zone), the camera and its settings, the
  file, where with a Maps link, and who added it. The album page and the
  worker's file pages both draw it; it reads the site's 24-hour setting
  and `scs.fmtTime` where site.js is on the page and the device's own
  clock where it is not. Precached, since the album page loads it.
- **The slideshow** (`assets/slideshow.js` + `slideshow.css`,
  `window.scsSlideshow`: `start(slides)`, `stop()`, `isOn()`). The
  gallery's full-screen slideshow, moved out so the album page runs the
  same one. A slide is an object the page builds, `{type, alt, photo(),
  video(), sizes(), plate()}`, with the plate `{code, name, right}`, so
  the slideshow never reads a gallery submission or an album item
  itself. Written up with the gallery in `tab/CLAUDE.md`. Precached.
- **The install pop-up** (`.install-nudge`, site-chrome.js): once a session on a
  handheld that is not the
  installed app (the session counts it once it has shown, 1.2s after
  the page, not when the page loads), never on a page marked `data-no-install` (the ticket,
  which is held up to a scanner), and "Don't show again" sticks. It
  arms a back layer, so back puts it away. Titled
  Install SCS.2 App; its line says what installing gives and then how —
  Share and Add to Home Screen on an iPhone, with Safari's Share icon
  and its square with a plus drawn in by `pushSub.paint` (`[share]` and
  `[add]` in the text; the settings menu's iPhone hint carries both
  too), and Chrome's Install app on everything else. In
  the app layout it sits above the bottom bar (`--tabbar-h` plus 12px)
  rather than over it.
- **Cached images** (`FILE_CACHE` in sw.js, exempt from the
  activate cleanup): the four tab-worker file endpoints
  (`/api/submit/file`, `/api/quests/file`, `/api/messages/file` and
  the home page slideshow's `/api/slides/file`) serve cache-first —
  keys are immutable, so a hit is final, and the slideshow opens
  without fetching its pictures again. `keepableImage` stores only
  whole readable responses: status 200, type cors/basic (an opaque
  response is unreadable and quota-padded), content-type image/*, a
  known length ≤2.5MB (thumbs and viewing copies, never originals or
  videos) — ≤12MB for a slide or a message's picture
  (`WHOLE_PATHS`, `SLIDE_BYTES_MAX`), which are shown as they were
  uploaded — and no Range on the request, and nothing the worker sent
  `no-store` (a still standing in for a video the encoder has not
  finished, `tab/CLAUDE.md`). The messages page shows a
  picture's thumbnail first and swaps in the whole picture once it has
  loaded (`sharpen` in messages.js), since a 480px thumbnail across the
  column read as blurred. Capped at 400, oldest 40 trimmed. The key is
  the address without `again=` (`fileKey`): that parameter only steers a
  retry past a failure the browser kept, and only good pictures are kept
  here, so a picture that needed a retry is found again on the way back
  up instead of being asked for afresh. **Batched thumbnails**
  (`THUMB_CACHE` `scs2-thumbs-v1`, also exempt from the cleanup, capped
  at 1500, oldest 100 trimmed): the worker answers `/api/thumbs` itself
  (`thumbsResponse`), from each part kept under the address it would
  have on its own (`thumbParts`), and asks the network only for the
  parts it lacks, as a smaller batch, keeping each that comes back. A
  failure goes back to the page as it came, so the page's own waiting
  decides when to ask again. Every `<img>` that
  loads from these endpoints sets `crossOrigin = 'anonymous'` (the
  endpoints all send `access-control-allow-origin: *`) so the worker
  can read what it keeps — a new image site must do the same.
  **Tests must pass `serviceWorkers: 'block'` to
  newContext/newPage**: a live worker would answer these requests
  itself, past the page.route stubs (this broke a whole suite once).
  `tests/verify-offline.cjs` covers the cache rules.
  **Every lookup names its cache.** `caches.match(request)` with no name
  walks every cache this origin has, in the order they were created, and
  two of them are big — up to 800 map tiles and up to 400 images. Bumping
  `CACHE` makes the new page cache the newest of the four, so it is
  searched last: every page switch and every asset paid for a scan of
  both of those first, on a worker that had just been woken to answer
  it, which is what "the first tap in a while takes a second or two"
  was. `siteResponse` and its offline fallback open `CACHE` by
  name; the tile and file handlers already did.
- **One page load is one build** (`siteResponse` in sw.js). A file in
  `PRECACHE` with a stored copy is answered from it and never fetched
  again in the background; it changes only when a `CACHE` bump installs
  a new worker, which precaches every file fresh. It was
  stale-while-revalidate for everything, which wrote the server's copy
  of every file asked for into the current cache behind the answer.
  Between a deploy and the new worker taking over — a long time when its
  install keeps failing on a weak signal — the old cache filled with the
  new build's files one request at a time, and a page ran new shared
  scripts beside its own old ones. Every change to a site file comes
  with a bump (`npm run check`), so nothing is lost by not refreshing.
  A precached file with no stored copy is fetched and stored. Files not
  in `PRECACHE` (the camera, the Season 1 tab, the on-demand libraries,
  the font, the video engines) stay stale-while-revalidate: shown from
  the copy, refreshed behind it. The match is by full address, a page by
  `pageKey` (no query), so `/ticket/?<blob>` is the precached `ticket/`.
  **Navigation preload is off** (`disablePreload` on activate; an
  earlier worker turned it on and the setting outlives the worker):
  stored pages are answered with no request, so a preload would be a
  page downloaded and thrown away on nearly every navigation. The pages
  it would help are the two not precached, which now wait for the
  worker to start before their request goes. `verify-sw-update.cjs`
  deploys a build whose worker cannot install and checks the page keeps
  being answered with the build in charge.
- **Offline, a page never stored is sent to the home page by a
  redirect** (`toHomePage`), not handed the home page's HTML at its own
  address: there its relative `assets/` links resolved against the wrong
  folder and it drew with no styles or scripts. The home page itself
  missing gets the browser's own error, so it cannot loop.
  `verify-retry.cjs` opens a page never stored with no signal.
- **The service worker asks the server, never the HTTP cache**
  (`fromServer` in sw.js: `cache: 'no-cache'` on every file it installs
  and every file it refreshes; a page's own navigation goes as the
  browser sent it). Something in front of the site can give a script
  hours of life in the browser's HTTP cache — Cloudflare does, four
  hours by default, for a proxied domain — and a new worker used to
  fill its new cache through it: it installed (the browser always
  fetches the worker's own file fresh), then served the old `site.js`
  on every load however many reloads, while a private window, with no
  HTTP cache, ran the new code. The quest list kept asking for the
  public list after the team lists shipped, which is how it showed up.
  `no-cache` still sends the conditional request, so an unchanged file
  is a 304 and not a download. A browser stuck that way recovers on its
  own once a worker with this fix is deployed: one reload installs it,
  the next runs the new code. `tests/verify-sw-update.cjs` deploys a
  second build over a first at the same address with four-hour files
  and **no request interception** — Playwright switches the HTTP cache
  off whenever it intercepts, which is why no other suite could see it.
- **The worker is registered three seconds after `load`** (site-app.js):
  a first install fetches everything in `PRECACHE` (52 files, about
  1MB gzipped, most of it the map), and the page's own pictures and
  API reads go first. A page already under a worker loses nothing, since
  the browser checks for a new `sw.js` on navigation either way.
  **`PRECACHE` is what a phone needs with no signal on the day**: the
  home page, the quests and their map, the tab, submit, messages, info,
  welfare and the ticket, with the shared files. It was every page, 90
  files and 1.2MB, and the install is all or nothing (`cache.addAll`), so each
  file not needed is one more request that can fail the lot on a weak
  signal. Sign-up, the terms, the gallery and albums, the compressor
  and its engine wrappers, the pages that open after the event (recap,
  team, replay) and the pages no menu links to are stale-while-revalidate
  like any other file, kept once opened, and `NOT_PRECACHED` in
  `tab/scripts/check-rules.mjs` lists them with why. A version bump
  empties the cache, so one of those pages is fetched fresh after a
  deploy and never runs beside shared scripts from another build.
  `verify-retry.cjs` and `verify-sw-update.cjs` wait for
  `navigator.serviceWorker.ready` rather than a fixed time.
  **It registers from the page's `link[rel="manifest"]`**, and so does
  the update pill, so every page carries one, the ticket included: a
  phone that only ever opens the ticket link in its confirmation email
  still gets the worker, and so the ticket at the door with no signal.
  The ticket page had none and never registered. It keeps
  `data-no-install`, and ticket.js turns away the browser's own install
  banner (`beforeinstallprompt`), which the manifest makes possible
  there. `verify-retry.cjs` opens the ticket link alone in a new browser.
- **A page open across a deploy offers a reload** (site-app.js, after the
  worker's registration; `.site-update`, the quest list's
  `.update-banner` pill with its own words): "SCS.2 updated. Tap to
  reload" and a close. The bump of `CACHE` is the signal: a new worker
  installs, `skipWaiting` and `clients.claim` hand it this page, and the
  page hears `controllerchange` while it is still running the build it
  loaded with. A page with no worker when it loaded is a first visit,
  and the worker taking it over then is no update. The browser looks
  for a new `sw.js` on every page load; a page left open (the installed
  app, the live tab) also calls `reg.update()` when it comes back into
  view after a minute or more and every half hour while it is on
  screen. The tap reloads, through the leave-page question when a guard
  is up (`askBeforeLeaving` takes a function for that), so an upload in
  progress is not cut off without asking. The close only puts the pill
  away: the next page opened is the new build anyway. With the quest
  list's own pill showing, this one sits under it.
  `verify-sw-update.cjs` deploys a third build
  under an open page and taps the pill.
- **Pictures that come back** (`scs.keepPicture(img, url, opts)`): every
  grid of pictures on the site — album tiles and covers, the gallery,
  the submit page's sent files, message attachments, a quest's files and
  the photo strip — hands its img to this rather than setting `src`.
  The img gets `url` (kept in `data-src`) once it is within a screen and
  a half of being seen, through one IntersectionObserver whose root is
  the body, since the body is the scroller and a margin on the viewport
  does not reach past its edge; `letGo` takes the `src` off again beyond
  that, for a long grid (albums, the gallery), and `near: false` asks
  at once with the browser's lazy loading, for an img inside a scroller
  of its own (the quest sheet, the photo strip) that the body's observer
  cannot see into. A picture that fails is hidden (`is-missing`) and
  asked for again after 1, 3, 8, 30 and 60 seconds with `again=` on the
  URL so no cache answers with the failure. **Six or more failing within
  three seconds** is the server turning requests away rather than a
  dropped connection (Cloudflare's per-minute limit, `tab/CLAUDE.md`), so
  those skip the quick tries, wait at least 30 seconds and are spread
  out by a quarter either way (`retryAfter`): every tile on screen asking
  again a second later was more requests into a limit that lasts a
  minute. **`opts.instead`** is asked on a failure before any retry: a
  function answering a promise of another address to use (the img takes
  it and its failures start again from nothing), `''` for none (the
  retries go on), or a rejection, which is asked again on the next
  failure. The album page passes one for a video's tile: an img cannot
  say why it failed, so it asks for the still again with `fetch`, and
  on a 404 takes a frame from the video's smallest copy with
  **`scs.videoFrame(url)`** — a hidden muted video seeked a second in
  (half way in a shorter one; played for a moment where a browser will
  not seek a video nobody has played), drawn to a canvas at 480px on the
  long edge, answered as a `blob:` address. Two at a time, each address
  once, never revoked, and given up after 20 seconds. `askPicture`
  leaves a `blob:` address without `again=`. A single failure still gets its first try at exactly a second, and every picture near the screen
  that is not there is asked for afresh when the page is looked at
  again, comes back from the back-forward cache or the device comes
  back online. Phones that put the browser away let go of pictures and
  fail the requests in flight; pages used to ask once more and then
  take the picture out for good, so coming back to Safari and scrolling
  left grey tiles until a reload.
- **Thumbnails in batches** (`opts.batch` on `scs.keepPicture`, site.js;
  the album page's tiles and covers and the gallery's tiles). One
  request per thumbnail meant a fast scroll through a long album was
  one request per tile it passed, which met the Cloudflare rate limiting
  rule in front of the worker (`tab/CLAUDE.md`), and every tile a
  refusal sent back for `again=` was a new address that no cache held
  on the way back up. Now a tile that comes near is queued, not asked
  for: every 60ms the queue goes to `/api/thumbs` (`thumbs.ts`), up to
  24 a request, nearest the middle of the screen first, and with two
  requests out it waits, so a tile flung past before its turn is never
  asked for at all. Each picture that comes back is kept for the page as
  a blob address (`batchMade`, the newest 1000, the oldest let go first
  unless a tile is showing it), so `letGo` still frees what is decoded
  but a tile scrolled away and back is drawn again with no request. A
  part the batch lists as missing (a video with no still, anything the
  single route would not hand out for good) is asked for on its own, as
  is a blob that will not draw. A refused or dropped batch is sent again
  after 3, 10, 30, 60 and 60 seconds, spread a quarter either way, and
  after that its tiles go on their own with the usual retries. **A 404
  or a 400 from the route turns batches off for the page** and every
  tile is asked for on its own, so a site deployed ahead of the worker,
  and the suites' stubs that answer 404 to anything they do not know,
  work as before. On a 400-photo album a fling to the bottom and back
  was 72 requests one by one and 7 in batches. The service worker keeps
  each part on its own (`THUMB_CACHE`, below), so a later visit answers
  the thumbnails it has seen from the phone.
- **A dropped request is asked again** (`RETRY_DELAYS`, 250 to 8000ms:
  up to six more tries over about sixteen seconds). A phone that
  has just woken or changed networks often loses its first request and
  gets the second, which read as "the site failed to load and a reload
  fixed it". It tries again when no answer came back at all and on 502,
  503 and 504. **`scs.fetch` also gives up on a try that has had no
  answer in eight seconds** (`ANSWER_WITHIN`, or a call's own `timeout`)
  and asks again: a phone can hold a request on a connection that is no
  longer there, and with no limit the page waited on it for good — the
  album page sat on Loading until it was reloaded by hand. The limit is
  on the answer arriving, not on its body, and a caller's own abort still
  reaches the body; any other answer or an abort goes straight back.
  It used to stop when `navigator.onLine` was false, and a phone says
  that for a moment while it changes networks, which ended a load that
  the next try would have got. Two places, covering different requests:
  **sw.js** for the site's own pages and files, and only those with no
  stored copy (one with a copy is already on screen); **`scs.fetch`**
  (site.js) for reads from the tab worker, which the
  service worker never sees. `scs.fetch` is GET only — a POST that
  failed may still have arrived. Every page's API read goes through it;
  the home page's slideshow, which runs before site.js, waits for
  `DOMContentLoaded` so it can, and `photo-strip.js` falls back to plain
  `fetch` where site.js is not on the page. Same-origin files are left
  to the service worker so the two never retry one request between
  them, except the few a page cannot do without on a first visit, when
  no service worker controls it yet: the quest map's style and transit
  file, the replay's, and the compressor's worker scripts. Each try
  there is cut off at eight seconds, so the two together still end.
  **A load that ran out of tries is asked again later**
  (`scs.again(key, fn)`, `scs.gotIt(key)` in site.js): fn runs after 3,
  10, 30 and then every 60 seconds, not while the page is hidden, and at
  once on `online`, on the page being shown again and on a `pageshow`
  from the back-forward cache. A load that fails again calls
  `scs.again` again and one that works calls `scs.gotIt`. The messages
  page, the gallery, the recap, a team's page and its route, a quest's
  recap page, the replay, the sign-up form's status read, the quest map
  and the chrome's pulse (the bell and the urgent pop-up) use it, so a
  page that said it could not load fills in on its own; before, each
  kept its message until a reload. `scs.needScript(src)` is the same for
  a script from another site (the human check on the sign-up form and
  the album page), and MapLibre's script is asked for again by its two
  loaders (three or four tries). **A video whose connection dropped**
  (`MEDIA_ERR_NETWORK` in video-sizes.js) loads the same copy again from
  where it was, five times at most; it used to be read as a format the
  browser cannot play, which switched the saved choice to Auto. **A page is stored under its address without the query**
  (`pageKey`): every page is a static file that reads its query in the
  browser, and keyed with it a ticket link this phone had not opened
  before fell back to the home page with no signal. `tests/verify-retry.cjs`
  covers all three against servers that drop requests on purpose.
- **Last-good copies**: the live tab keeps its whole payload in
  localStorage `scs2-tab-cache` ({lb, stats, at}) and paints it at
  boot before the network answers — the "Updated …" line says how
  old the copy is (the ticker shows minutes past 90s) and the fresh
  table's rows FLIP into place over it. The quest page keeps the
  team-stats payload in `scs2-tab-stats-cache`: `fetchTabStats`
  answers from the copy at once and refreshes behind it, so the
  sheet's "N of M teams" line renders without waiting and survives
  the API being away. `tests/verify-tab-cache.cjs` covers both.
- **Offline map tiles**: sw.js keeps every tile it has served in its
  own cache, `scs2-tiles-v1` (config flag cache `scs2-tiles-cfg`) —
  both exempt from the activate cleanup, so a version bump never
  throws the map away. `isTileRequest` matches every host in `TILE_HOSTS` +
  a `/z/x/y(.ext)` path regex (built from a string — no escaped
  slashes) and no query. **A kept tile is answered with no request**:
  tiles change only when the
  archive is replaced, so one is fetched again behind the map only once
  it is a week old (`TILE_REFRESH`). It was stale-while-revalidate, which
  drew the kept tile and downloaded it again on every page open, every
  tile on screen, on a phone that might be on the venue's signal. **The
  age is the worker's own stamp** (`x-scs-kept`, written by `keepTile`,
  which stores the tile as a response of its own): a cross-origin answer
  does not let script read its `Date` header, so read from there every
  kept tile looked older than a week. A tile URL with a query goes
  to the network. 200s only, capped at 800 tiles
  with the oldest 80 trimmed behind the response. The settings
  rocker (`set-tile-cache`, localStorage `scs2-tile-cache`, on every
  page) drives it: site-app.js `decideTiles()` — a stored choice wins;
  the first visit asks `navigator.storage.estimate()` and starts OFF
  when less than 250MB is free, ON otherwise (no API = on) — and
  mirrors the choice into the cfg cache as a `/__tiles` Response
  ('on'/'off'; the worker cannot read localStorage; it re-reads at
  most once a minute, missing flag = on). Turning it off deletes the
  tile cache, and the page tells the active worker with a message
  (`{type: 'scs-tiles', on}`), which takes the new value at once and
  deletes the cache too: it held on to `on` for up to a minute and
  filled the cache again. A tile is stored only while the switch is on.
  `tests/verify-offline.cjs` covers it.
- **What time a stamp is** (`scs.fmtTime`, `scs.fmtDay`, `scs.isToday`,
  `scs.hideDates`): the one formatter behind every time the site prints
  — the messages page, the submit page's sent list and its score, the
  live tab's last-scored column, the team pages and the recap.
  **A stamp read on the day it was made carries no date.** SCS.2 runs
  inside one day, so on the day every time on the site is today's and
  the date beside it is a word nobody reads; anything from another day
  still says which, because "14:21" would otherwise be read as today,
  which is the whole reason the date is there. The live tab had this
  rule as its own copy (`whenText`) and now calls the shared one.
  The settings menu's **Hide dates** rocker (`set-hide-dates`,
  localStorage `scs2-hide-dates`) takes the date off whatever the day.
  Nothing on a page redraws itself, so flipping it dispatches
  `scs-dates-changed` and the pages that print times redraw from what
  they already have — the live tab from `lastPaint`, the messages page
  from the payload `showing` holds, the recap and the team page from
  the answer they last drew (`shown` in each), the submit page by
  fetching its sent list again. Everything else takes it on its next
  render. **The organisers can take the date off too** (the dashboard's
  Recap card, Times without their date): rules of `{kind: 'on' | 'from' |
  'until', date}`, any one enough, ride the pulse as `date_rules`, are
  kept in localStorage `scs2-date-rules` so the first paint follows them,
  and `fmtTime` drops the date for a time on a day they match
  (`ruledOut`, the day in the device's zone). A change sends
  `scs-dates-changed`. **The tab's own public reads never send that
  date** (the leaderboard, the stats, a team's page, the recap and a
  quest's page; `undated` in `tab/src/recap.ts`): a time on a matched day
  goes out as `HH:MM` on Sydney's clock and nothing else, so `fmtTime`
  and `fmtHour` print a bare `HH:MM` as it is, with no move into the
  reader's zone (there is no date left to move it with), and `fmtDay`
  answers '' for one. The messages and a team's own submit list still
  carry whole stamps and lose the date on the page only.
  `fmtDay` is the date on its own and is never dropped, because
  a date is what that caller asked for (the recap's busiest hour). **It
  reads a stamp with a time as a moment**, and gives the day the device
  was in then: the worker's hours are UTC, and 9am in Sydney is the
  evening before in UTC, so the date part of the stamp was the wrong day
  for every morning hour of the event. A bare date is that calendar day.
  `verify-recap.cjs` asks the recap in Sydney.
  **24-hour time** (`set-24h`, localStorage `scs2-clock` = `'24'`,
  `scs.hour24()`) makes both `fmtTime` and `fmtHour` write `14:05`
  rather than `2:05 pm`, and flipping it sends the same
  `scs-dates-changed` the Hide dates rocker does, so the same pages
  redraw.
- **The cutout cover's colour** (`--cutout-bg`, `readCutout` in
  site-chrome.js). `html.is-pwa::after` is the band under the notch, and its
  only job is to stop the page scrolling into the strip once the bar
  has gone — so it has to be the colour of whatever is behind it.
  Written down it is wrong on any page with a full-bleed black object
  at the top: the home page's board is under the notch for its whole
  first screen, and the page's own paper painted across it was a pale
  band on the black, white in the light theme and grey in the dark one.
  It asks the page instead — one `elementFromPoint` just under the
  inset, walking up for the first background that is not transparent —
  rAF-throttled, only while `nav-up` (the only time the band is drawn)
  and only written when the answer changes, so the ordinary scroll is
  one hit test and no style write. The band's height is
  `env(safe-area-inset-top)`, which is not readable from script; the
  bar's own `padding-top` IS that inset and is what the read uses.
  `var(--page-bg)` is the fallback and is right on every page whose top
  is paper.
- **The settings menu's two pages** (`.settings-page`, `showSetPage` in
  site-chrome.js). With everything in it the menu was nine rows long, which on
  a phone is a list that has to be scrolled to reach its end. Appearance
  and Text size stay on the first page with the two On-the-day switches
  and the two Phone ones; the eight that say how the site *looks* — Full
  Screen Map, Sharper Map, Group Map Pins, Hide Checklist, Hide Dates, 24-hour Time,
  Quest Panel Animation, Justified Text — are behind a
  row named Optional Visual Settings with a chevron, and a back button at the head of the second
  page comes home. The panel is the window: the leaving page comes out
  of the flow (`.is-leaving`, positioned at the panel's own padding) so
  both occupy one box while they cross, the arriver raises itself out of
  a blur (`.is-arriving`), and the panel's own height is tweened from
  script because the two pages are different lengths. `--page-dir` is 1
  going in and -1 coming back. Closing the menu resets it to the first
  page — the gear always opens the same thing — and every switch
  re-places the invisible haptic switches, because the rows have moved.
- **Sharper Map** (`#set-map-sharp`, localStorage `scs2-map-sharp`,
  wired in site-input.js, off by default). A map draws `devicePixelRatio`
  pixels per point unless told otherwise, so on a 3x phone the
  full-screen map was 1170x2532, 2.25 times the pixels of 2x, and opening
  it, panning and every resize paid for them. `scs.mapPixelRatio()` in
  site.js is what both MapLibre maps are built with (the quest list's and
  the replay's): at most 2, or the screen's own density with the setting
  on; a flip dispatches `scs-map-sharp-changed` and a map on screen calls
  `setPixelRatio` there and then. The row is in every page's settings
  menu like the others, since the menu is the same everywhere.
- **Group Map Pins** (`#set-map-groups`, localStorage `scs2-map-groups`,
  `'0'` off, wired in site-input.js, on by default and checked in the
  markup). Off, the quest map draws every pin on its own at every zoom.
  A flip dispatches `scs-map-groups-changed` and a map on screen calls
  `setClusterOptions` on its pins source there and then
  (`syncPinGroups`); the kept picture of the map is dropped, and its look
  key carries the setting so one taken the other way is never shown.
- **A custom property written on the root restyles every element on the
  page**, because custom properties inherit and the root is where every
  element inherits from. The quest page wrote four of them while the map
  went full screen (the button lift on every frame of the morph, the
  safe-area insets, the floating search's offsets and a chip height
  nothing read any more), and each was a restyle of about 1,600 elements;
  `website/questlist/CLAUDE.md` has where they live now. Write a value
  on the element whose subtree reads it. `--pull`, `--sheet-dim` and
  `--fab-lift` are still written on the root on every frame of a pull, a
  sheet drag and a scroll at the end of the page.
- **Appearance** (`.theme-toggle`, the moon and the sun, localStorage
  `scs2-theme`). Nothing stored is the device's own setting: the boot
  script takes `prefers-color-scheme` before the first paint, and
  site-chrome.js keeps listening to it, so the page changes with the device
  while it is open. A press stores `'light'` or `'dark'`, and from then
  on the device is not followed.
- **The menu's link to the submit page says Sign In** while no team is
  signed in on the device, and Submit a Quest once one is. **The link
  carries both names** (`.menu-signin`, `.menu-signed`) and
  `html.team-signed-in` picks one in site.css, which every page's boot
  script sets from `scs2-submit-session` before the first paint: the
  script used to change the link's text after the page had drawn, so on
  every page the menu showed Submit a Quest for a frame and then Sign In,
  and the links beside it moved. `syncSubmitLink` in site-chrome.js keeps
  the class in step afterwards and still rewrites a bare link on a page
  from an older build. The submit page, the gallery and the albums
  sign a team in and out through `scs.setTeamSession(token, team)` (and
  read it with `scs.teamSession()`), which sends
  `scs-session-changed`; they had a copy each, and the gallery's could
  not sign out, so a session the worker had dropped stayed on the
  device. A team signing out also unlinks the device from it
  (`scs.pushSub.unlink`, `POST /api/push/unlink`), so a shared phone
  stops getting that team's verdicts; a session that ran out does not,
  since the team's own phone should keep them. Another
  tab doing it arrives as a storage event, so the label changes without
  a reload. The page's own title, the app bar's Submit tab and the
  floating button keep their names. The same sync puts
  `team-signed-in` on `<html>` (the home page also sets it in an inline
  script before first paint), which the home page uses to leave out its
  Sign up buttons in the app layout: a team that is signed in has
  signed up.
- **Justified text** (`html.justify-text`, the `set-justify` rocker,
  localStorage `scs2-justify`). Off by default. The class goes on
  `<html>` from each page's boot script as well as from site-input.js, so
  there is no reflow at the first paint, and what it reaches is
  whatever a page has marked `data-justify` — the running prose on the
  home, info and welfare pages and nothing else. A rule reaching for
  every paragraph would take in labels, captions and table cells, and a
  justified narrow cell opens rivers of white space through itself.
  Hyphenation is not optional with it: justify stretches the spaces
  between words, and with no way to break a long word the stretch lands
  in one or two gaps. `text-wrap: pretty` keeps the last line from being
  one word. **A package was tried first and could not be used**:
  `@kitlangton/justice` measures a line and distributes the slack across
  word spacing and tracking rather than word spacing alone, which is the
  better answer, but it is published `UNLICENSED` with no grant in the
  package, the README or a LICENSE file, so it cannot be vendored into a
  public repo. The setting and the class are the same either way, so it
  could be swapped in if that changes.
- **Hide Checklist** (`html.hide-checklist`, the `set-hide-checklist`
  rocker, localStorage `scs2-hide-checklist`). Off by default. It reaches
  the quest list and nothing else, so only that page's boot script
  stamps the class; site-input.js toggles it on a flip and sends
  `scs-checklist-changed`, which the quest page redraws on
  (`questlist/CLAUDE.md`).
- **The event's photographs, twice more** (`assets/photo-strip.css` +
  `photo-strip.js`, `data-photo-strip` on a `ul.photo-strip`). The
  sign-up page was a column of prose asking people to commit with
  nothing to look at, and the gallery signed out was a heading, a
  sentence and an empty screen. Both now carry a row of the pictures
  the organisers put on the home page — the same public `/api/slides`
  the slideshow reads, so nothing is handed out that was not already —
  painted at once from the copy the home page keeps in localStorage and
  refreshed behind it. It never writes that key: the home page owns it,
  and two writers of one cache is how the two disagree. With no
  pictures uploaded the element stays hidden and both pages are what
  they were. Its own pair of files, and the gallery's script takes the
  row away with the gate.
- **The home page's slideshow**, page side (the last IIFE in
  `index.html`; the worker half is in `tab/CLAUDE.md`). It cross-fades
  on its own every three seconds unless the dashboard says otherwise —
  `/api/slides` carries `step_ms`, kept with the list in
  `scs2-slides-cache` as `{slides, step}` so the first paint after a
  reload runs at the right pace rather than changing speed once the
  worker answers. **A picture's time starts when it has loaded**, not
  when it was asked for: the clock is one `setTimeout` per picture, set
  by `rest()` only once the picture on screen carries `is-loaded` (its
  own load event, `landed`, sets it going otherwise), so the deck does
  not move until the first picture is up. When a picture's time is up
  and the next has not loaded, `advance` marks the change `due` and the
  deck stays where it is; the next picture's load makes the change at
  once. A load that fails counts as landed, so a broken picture cannot
  stop the deck. A mouse resting on the stage holds it (`hovered`, set
  from mouse pointers only, so a tap does not), and so does a hand
  moving it: `rest()` stands down while a drag, a settle or a trackpad
  swipe is under way. **A drag is a different question from the automatic
  change and is left as one**: a finger or a pointer held down moves
  the picture under it the whole way with the next one coming, through
  pointer events so a mouse and a finger are the same gesture. The
  three slides in play are the current one and its neighbours, placed a
  stage-width either side and moved together; with two pictures both
  neighbours are the same box, so it goes on the side the hand is
  already moving. Released past a fifth of the stage, or flicked more
  than 44px in under 300ms, it carries on across; short of that it goes
  home. `touch-action: pan-y` on `.hs-well` is what hands the sideways
  gesture over — the browser has to stand its own pan down before the
  first move, because once one has begun no cancel stops it. It is not
  enough on its own: Safari still scrolls the page by a sideways drag's
  vertical drift, so the page crept up or down under a swipe. `steer()`
  decides the drag once the finger is 8px out (mostly vertical lets go
  to the page, anything else is a swipe) from whichever of the
  pointermove and the touchmove arrives first, and a non-passive
  `touchmove` on the well cancels every move of a swipe from then on;
  it has to decide before Safari's pan starts, which is why the call is
  made that early. And
  `pointerdown` preventDefaults, because a mouse press on a picture
  otherwise starts the browser's own drag-and-drop and the pointer is
  taken away a frame later (the symptom is a drag that cancels
  immediately and a picture that never moves). A settle caught part-way
  by a second drag is finished rather than abandoned, or the picture
  and the dots disagree about which one is showing.
  **A tap that is not a drag opens it in the site's photo viewer**
  (`openViewer`, `scs.lightbox` — written up in `tab/CLAUDE.md`), the
  same one the gallery and the messages use: on a phone a sideways swipe
  moves between the photos, a tap puts the photo alone on black, a pinch
  or a double tap zooms, and a swipe up or down closes it; on a computer
  the arrows, the arrow keys, a click to zoom and Escape. It opened a
  full screen of its own once (`.hs-full`, the frame moved to the end of
  the body), which had none of that. The viewer is given the
  slideshow's pace (`advance: STEP`, none under reduced motion), so it
  keeps playing; the slideshow under it stops its own clock while it is
  open (`viewing`) and follows the viewer's photo (`onShow`), so closing
  shrinks the photo back into the slide it is on (`originFor`). A new
  list from the worker while the viewer is open waits until it has
  closed (`listAfterViewer`): the viewer counts in the old list's places.
  `verify-countdown.cjs` opens it on a phone, swipes once and closes it
  with back.
- **The logo** (`assets/icons/`, all exported from the
  event's logo drawing): `logo-64/128/256.png` are the mark on
  a transparent ground (the top bar, the footer and the launch splash,
  which takes the 256 at 2x); `favicon-32`, `apple-touch-icon`,
  `icon-192/512` and `icon-maskable-512` are it on a white square, as an
  icon has to be opaque. Transparent, its black edge disappears against
  a dark ground, so in the dark theme the bar's and the footer's copies
  sit on a white square of their own (site.css), and
  so does the splash, which is always dark.
- **The stand-in for Helvetica** (`assets/fonts/`, family `SCS Heros`).
  Every stack names the system's Helvetica Neue first, and an iPhone, an
  iPad and a Mac have it; Windows, Android and Linux do not, and they
  answered `Helvetica` with Arial, Roboto or Liberation Sans. Helvetica
  itself cannot be served: Monotype owns it, the copy on an Apple device
  is licensed for use on that device, and Monotype's web licence is
  paid and priced by page views. So the site serves **TeX Gyre Heros
  2.004**, the GUST e-foundry's free Helvetica design built on URW's
  Nimbus Sans, under the GUST Font License — the LaTeX Project Public
  License, which allows serving a changed copy as long as the licence
  goes with it and the change is stated (`fonts/GUST-FONT-LICENSE.txt`
  and `fonts/README-SCS-Heros.txt`, both served). Renaming a changed
  copy is asked for and not required, and is done. **How the files were
  made**: the OpenType files from Ubuntu's `fonts-texgyre` package
  (`apt-get download fonts-texgyre`, `dpkg-deb -x`), fontTools to rename them —
  name IDs 1, 3, 4, 6 and 16 and the CFF table's font name, full name
  and family name to SCS Heros, with a description in name ID 10 —
  then `pyftsubset <renamed>.otf --unicodes=<range> --flavor=woff2
  --name-IDs='*'` twice per face, with the two `unicode-range`s in
  site.css. About 16KB a file. Regular, italic, bold and bold italic;
  800 and 900 land on bold, as on Helvetica Neue, which has nothing
  heavier either. **The Latin Extended file is its own** so a page
  fetches it only when it shows one of those letters (a name with a Ł),
  and the Latin rules come second in the stylesheet so they win where
  the two ranges overlap. **It goes straight after Helvetica Neue,
  before Helvetica**: Chrome treats Helvetica and Arial as each other's
  alternative on every platform, Windows maps Helvetica to Arial, and
  Android's font configuration maps it to Roboto, so behind Helvetica
  the stand-in is never reached on exactly the devices it is for. **A
  device with Helvetica Neue downloads nothing**, since a browser
  fetches a webfont only when text needs it (checked by installing a
  font under that name). For the same reason it is **not in PRECACHE**:
  there every iPhone would download it when the service worker installs.
  The service worker keeps it the first time a page uses it, like any
  same-origin file. `font-display: swap`; Heros has Helvetica's widths,
  which Arial copied, so the swap changes the letters and not the
  line breaks. **Every face carries Helvetica Neue's vertical metrics**
  (`ascent-override: 95.2%; descent-override: 21.3%;
  line-gap-override: 2.8%`, the same in sharepage.ts and in the
  pictures' `FontFace`): Heros's own are 1.148 and 0.284, which put
  every line's text a sixteenth of its size lower in the line box than
  on a Mac, where the spacing was set by eye, and made a `line-height:
  normal` line a fifth taller. **The pictures** (`share-image.js`) are drawn on a canvas,
  which uses whatever has loaded at that moment, so `png()` loads the
  stand-in first when a measure on a canvas says Helvetica Neue is not
  there — regular and bold, the Latin Extended files only for a picture
  with those letters in it — and draws anyway after four seconds; it
  finds the files beside itself (`document.currentScript`), which is
  how the dashboard, loading it from the site, gets them too. **The
  worker's share pages** (`/view/`, `/photo/`; `fontFaces` in
  sharepage.ts) declare the same faces from `SITE_URL`, and
  `netlify.toml` sends `/assets/fonts/*` with an open CORS header for
  them and the dashboard. The dashboard's own pages, the check-in
  worker's pages and the emails keep the system stack.
  `verify-one-site.cjs` asks the browser which face every page's text
  is drawn in: the test browser has no Helvetica, as a Windows or
  Android phone has none, so a stack without the stand-in or a missing
  file fails there, where on a Mac it would look right.
- **Pictures to paste into a chat** (`assets/share-image.js`,
  `window.SCSShareImage`): a team's receipt and the standings, drawn on
  a canvas so they come out the same from any page or width. The logo
  with the title beside it, the 2px rule opening and closing the table
  with labels in the label voice, a place as a route disc (medals for
  the first three), a TOTAL line, and the site's address as a line at
  the foot. Nothing is filled black, which was the first version's
  footer band and table head and read as out of place; the route stripe
  that ran along the top was taken off too. The design went through
  three rounds of studio-style critique to a 9 of 10, judged at phone
  width (390px), where most people see it. **A picture takes the theme
  of the page it is made from**: `dark: true` in the data draws it on
  the dark theme's surface with its ink, muted grey, hairlines and rule
  (`THEMES`, `useTheme`), and puts the logo on a white square as the
  site does, since its black edge needs white beside it; the medals are
  the same in both. `receipt(d, logo)` takes `{team, total, place,
  site, dark, detail, quests: [{key, name, times, held: [{code, amount,
  label, worth}], worth}]}` (no row with `times` leaves the submission
  counts out; `detail` is `compact`, a row its code, name and points,
  `standard`, a line under each quest with its submissions and codes, or
  `detailed`, each code on an indented line of its own with its points,
  adding up to the quest's; `compact: true` still reads as `compact`; an
  `amount` of null is a mystery part mark and shows the code alone) and
  `leaderboard(d, logo)` takes `{title, site, dark, teams: [{rank, name,
  points, quests, dnf}]}`. Neither carries a time: the "as of" line under
  the title went, and the receipt's line under the name is only the place
  where there was no room for its disc ("Did not finish" is never a disc),
  a title with nothing under it sitting level with the logo; both answer
  a canvas at twice its size. `png(kind, data, logoSrc)` loads the logo
  (`logo(src)`, once per address, given four seconds and allowed to
  fail) and answers a promise of the PNG, drawn again without the logo
  if the canvas will not give it up. `copy(blob, filename)` must be
  called inside the tap with the PNG still a promise, since that is
  what Safari accepts, and answers `'copied'` or `'saved'` (where the
  clipboard is refused it downloads the file). The team page and the
  live tab load it as a script; the dashboard loads it from the site
  the first time a picture is wanted, the way it loads video-sizes.js,
  and keeps its own copy of the clipboard step because the click cannot
  wait for the script. The logo is cross-origin for the dashboard, which
  is why `netlify.toml` sends `Access-Control-Allow-Origin` on
  `/assets/icons/*`.
- **A page's name is on the paper** (`.hero` in site.css): ink type
  30px under the top bar, not reversed out of a black band. The band was
  the heaviest thing on every page while saying only what the menu
  already underlines, came out a different height on four pages,
  stacked against the red band on Welfare and the Submit/Compress row on
  Submit, and in the dark theme was a black stripe on a black page. The
  quest list, submit and messages pages put `hero` on their own title
  blocks so they sit in the same place; the messages page's urgent
  notice is a black board of its own under the name
  (`.msg-notice-slot`). The home page's board is the black sign left at
  the top of a page, the photos edge to edge with its name centred under
  them, the same in both
  themes; the 404 keeps
  its notice on a black plate of its own (`.nf-hero`), since it is a
  notice rather than a page's name.
- **The top bar stops at the scrollbar** (`--sbw`, site-chrome.js): the body is
  the scroller, so its scrollbar is inside
  the body, and the fixed bar ran across the top of it — on a desktop
  with visible scrollbars the top of the scrollbar was hidden. The width
  is `body.offsetWidth - clientWidth`, re-read on resize and by a
  ResizeObserver on the body (a scrollbar appearing shrinks it); overlay
  scrollbars measure 0 and change nothing. Headless Chromium hides
  scrollbars unless launched without `--hide-scrollbars`.
- **The burger menu and the settings menu close each other**: opening
  either sends `scs-close-panels` (through `scs.closePanels` in site-chrome.js),
  so the cog folds the menu away as
  the settings come down rather than opening under it.
- **Below 840px every page is one centred column** at the home page's
  measure, 36rem (site.css, after the page shell's own rules: padding on
  the web, a width in the app layout). Pages used to cap their content
  at different widths and leave it on the left, so a narrow desktop
  window showed a gap down the right that was a different size on every
  page, and the title jumped as you went from one page to the next.
  Now the title starts in the same place on every page at every width,
  the quest list and the live tab included; the quest list's floating
  search keeps to the column too. Inside the column the prose measure
  (31em) is lifted, since the column is the measure. The home page is
  the exception: its board runs edge to edge and only the content under
  it takes the column (`margin-inline: auto` in index.html). **The
  column is `--col`**, which the home page and the quest list's search
  bar read as well, and from 700px it is 44rem: an iPad held upright
  (744 to 834px) had 36rem down the middle of the screen and an eighth
  of it empty on each side. Paragraphs keep 36rem inside the wider
  column, and the app layout's pinned row (the quest list's chips)
  starts where the column does.
- **The home slideshow on a tablet**: up to square when it is held
  upright, and no wider than 3:2 on its side, centred on the board's
  black (index.html, scoped to a handheld so a
  computer keeps the full-width stage).
- **One gap under a page's name** (`--after-title` in site.css, 32px
  wide and 24px under 560px). The title's own bottom margin is the gap
  and `main > .hero + *` gives up its top margin, so it is one number on
  every page rather than 28, 29, 40 and 48 on five of them; a section
  heading first under the title stops pulling itself up into a margin
  that is no longer there. In the app layout the name is in the bar
  and the title is not drawn, and the same 24px is the shell's top
  (`html.is-pwa .page-shell { --shell-top }`). The home board has its
  own single rhythm, `--board-gap`, between everything on it.
  **The name in the app bar is a title, not a link home** — the bottom
  bar has Home, and a tap on the page's own name taking you away was
  left over from when it was the brand. `.site-brand` takes no pointer
  events there (≤840px under `html.is-pwa`) and site-chrome.js stops a key
  press on it; the web layout's brand still goes home.
- **When the bar slides away** in the app layout, the body's top strip
  of the bar's colour (there for the page-switch flash) is taken to
  zero height: the body's background is the screen's, and the strip
  stayed at the top as a white band over the paper, and as a white
  square either side of the submit page's content. The quest list's
  chip row carries the bar's ground above itself while it rides up
  (`box-shadow` steps, since the row clips pseudo-elements), because
  the bar travels further than the row on the same clock.
  **Under the settings menu** the floating button and the quest list's
  search bar step back to 0.4 and take no taps, so a tap on either
  closes the menu; coming back both ride the veil's clock
  (`--dropdown-close-dur`), not the chrome's half-second.
- **The home slideshow's other inputs**: a trackpad's two-finger swipe
  arrives as sideways wheel events. The picture follows the fingers and
  **the change is made as soon as the swipe has gone a fifth of the
  stage or 90px**, not when the events stop: a trackpad keeps sending
  them for a second or more after the fingers lift (momentum), and
  waiting for the end of that made a swipe land a second late and
  folded any swipe made in the meantime into the first, which was
  already a stage across and so did nothing — one swipe worked and the
  rest did not. After the change the rest of that swipe's events are
  ignored until they stop for 100ms (`WHEEL_GAP`) or speed up again
  after slowing down (under 60% of their peak, then double the lowest
  since, and at least 3px): momentum only slows, so that is fingers back
  on the trackpad. A swipe that stops short goes home. And a
  picture is held at opacity 0 until it has loaded, then faded up, with
  a short bar running along the foot of the stage while the one on
  screen is still coming — Firefox paints the part of a picture not yet
  downloaded as white. The end of a swipe takes its transforms off with
  the transitions held off and a reflow between, or the picture just
  dragged away faded out over the new one.
- **The countdown** (site-app.js, the home page's `[data-countdown]`
  section): a run of stops in time order, not one date. The page counts
  to the first still ahead and moves to the next as each passes, the
  heading (`[data-cd-label]`) taking that stop's name. Three sources,
  in order, and only the last touches the network: the date and heading
  in the markup, the copy kept in localStorage `scs2-countdown`, then
  `GET /api/countdown`. **Nothing here ever shows a loading state** —
  the markup is already counting at first paint, a worker that cannot
  be reached changes nothing, and an answer that says the same thing
  does not even turn a flap. `stopTime` reads both shapes: the worker
  stores UTC `YYYY-MM-DD HH:MM:SS`, the markup carries an ISO string
  with an offset. No stops saved means the markup's own date, which is
  what a fresh database gives. Past the last stop, `data-countdown-end`
  decides between "is on right now" and "is over", and the clock keeps
  going for that one last change. The "is over" line is the dashboard's
  when it has set one (`over` in the answer, kept in
  `scs2-countdown-over`) and "SCS.2 is over. Results are on Discord."
  when it has not. Dashboard: the Settings tab's
  countdown card (`#cd-rows`, label + datetime-local per row, the whole
  list saved at once through `countdown/set`). `tests/verify-countdown.cjs`
  covers the stops, the storage and the offline fallback.
- **Haptics**: `window.scsHaptic(kind)` behind a capture-phase click
  listener that buzzes for every link, button, checkbox, radio, select
  and summary (the tab bar `selection`, the floating button `medium`,
  everything else `light`), plus the radius slider's detents and the
  pull-to-refresh arm; the settings menu turns it off
  (`scs2-haptics`). Anything with the Vibration API runs vendored
  **web-haptics 0.0.6** (`assets/haptics/`), which buzzes iOS by
  clicking a hidden native switch from script — **and iOS 26.5 patched
  exactly that**, so on a current iPhone the engine cannot work at all.
  The tick there now comes only from a finger landing on a real native
  switch, so `tapHaptics` (`'switch' in input` **and** no
  `navigator.vibrate` **and** `handheld()`) stamps `html.haptic-taps`,
  skips fetching the engine, and lays invisible switches over the
  controls worth a tick: `.haptic-tap` inputs in each `.tab-bar` link's
  grid cell (link and switch both placed by hand with `grid-area`, or
  the added switches flow into new columns of their own and halve the
  bar; counted over the five links shown)
  and over the floating button (the `.fab-wrap` box is exactly the
  button's). The messages bell, the Welfare heart, the settings gear and
  the light/dark button get `.haptic-tap-over` ones instead, appended
  beside the
  control and measured onto it by `placeTapSwitches` from
  `offsetLeft`/`offsetTop` — the untransformed layout position, so the
  nav sliding away on scroll and the settings menu animating open never
  move a switch off its button — **plus a copy of the control's own
  `transform`**, since the app bar's bell is nudged 20px off its layout
  position by one and its switch has to go with it. **Appended means
  last in the parent**, so a rule there reading `:last-child` finds the
  switch: the settings back button's lands after the second page's
  rows, which is why the rows' hairline rule is `:last-of-type`
  (`verify-switch.cjs`). The bar is still
  settling when they are first placed (the app layout lands, `--nav-h`
  is measured), so a `ResizeObserver` on each switch's container
  re-places them, with a rAF and a 400ms timer for browsers without
  one, and `setPanelOpen` calls it because the menu is `display: none`
  until then. Each switch is `aria-hidden` + `tabindex="-1"` and
  forwards the tap with `host.click()` — untrusted, so the buzz
  listener skips it and nothing fires twice; the menus' outside-tap
  listener resolves a switch back to its control through `hapticHost`,
  or the gear's own switch would open the menu and then count as a tap
  outside it. A rocker needs no overlay: its own checkbox takes the
  `switch` attribute and grows from a corner pixel to cover **the
  control**, not the row — a native switch spanning a whole row flips
  when a thumb lands on the words to scroll, and it needs `z-index: 2`
  because the drawn switch is positioned and later in the DOM, so
  without it a finger on the switch lands on the drawing instead,
  and the press squeeze moves up to `.fab-wrap:active` since the tap no
  longer lands on the button itself. **They must stay rendered with
  their native appearance** — `opacity: 0` only, never `display: none`,
  never `appearance: none` — or the tick goes with them. The settings
  menu's Haptic feedback rocker drives this path too (`syncTapSwitches`
  takes the `switch` attribute off every one of them and puts it back);
  the switches stay where they are and keep passing taps on, so nothing
  else about the chrome changes. **A page's own control can ask for one**
  (`window.scs.hapticTap(el)`): the list above is the chrome's, which is
  all site.js knows about, and the submit page's two view tabs are the
  same kind of thing — a button a thumb presses to change what is on
  screen — and nowhere near it. It does nothing where the engine still
  works, since there the ordinary click listener has already buzzed.
  That path gives one system tick and
  nothing else: no patterns, no delayed buzz, and the quest list's tick
  boxes are deliberately left out (ninety of them, rebuilt on every
  tap). None of it can be tested here, only on a real iPhone;
  `tests/verify-switch.cjs` covers the wiring and that Android and
  desktop are left exactly as they were.
- **The bottom bar's own taps**: tapping the tab you are already on
  used to reload the page, so spamming one tab reloaded it over and
  over — the chrome animated in every time, the floating button with
  it, and on a phone the safe area behind the notch flashed between
  paints. A capture listener on the bar catches a tap on the link to the
  page you are on (the same path, `index.html` ignored), stops it, and
  scrolls the body back to the top instead, the way an app does. A page
  further in under a tab — a team's page under the Tab — has that tab lit
  but is not its page, so the tap goes through and takes you back up; it
  used to be caught on `.is-active` alone and did nothing there.
- **Tapping the bottom bar mid-scroll**: iOS spends the first tap of a
  momentum scroll on stopping it, so a tab-bar tap made while the page
  was still flying was swallowed and the page only changed once the
  scroll had run down. The bar is fixed, outside the scroller, so a
  touch there was never meant to stop anything: when a finger goes down
  within 250ms of a scroll event, the *release* navigates (a tap that
  did not travel more than 10px and lasted under 700ms), and a capture
  listener drops the click that follows so the trip is not made twice.
  Every other tap is left completely alone — the ordinary click, its
  haptic and the browser's own handling. Covered in
  `verify-switch.cjs`, both the mid-scroll tap and the ordinary one.
- **The loading bar** (`startLoadBar` in site-input.js, `.ptr-bar.is-going`
  in site.css): a page gives no
  answer to a tap on a link until the next page draws, and when that is
  slow — a weak connection, or Safari slow to start the navigation —
  the tap read as one that had not registered, though the haptic had
  ticked. If the page is still here 250ms after the tap, **the pull to
  refresh's own bar** comes in under the top bar (made on the spot on a
  page with no pull) and its green creeps towards 94% rather than
  running to the end in 650ms; the next page replacing this one is its
  end. With the top bar slid away it runs along the top of the screen
  instead. **App layout only** (`html.is-pwa`, read at the tap, since
  the settings switch changes the layout without a reload): a desktop
  browser already shows a page on its way in its tab and address bar,
  and a second bar there was noise. It was a second, thinner bar of its own at first, and the
  site then had two loading bars that looked different for the same
  thing.
  **Three paths start a navigation and all three call it**: the click
  (one capture listener on the document, which skips a haptic switch's
  own click because the click it forwards to its link follows at once),
  the bottom bar's mid-scroll release and the slide-to-confirm's Leave.
  The click is asked about only once the 250ms are up, so a click that
  a later listener cancelled — the tab you are already on — shows
  nothing, and a second start for the address already on its way is
  ignored rather than restarting the wait. It stops on `pagehide`, on a
  `pageshow` from the back-forward cache (that page comes back exactly
  as it was left, bar and all), and after 20 seconds, for a navigation
  the browser dropped. `verify-app-layout.cjs` checks the 250ms and the
  tab you are on; Playwright cannot read a page whose navigation is
  under way, so the old page writes what it showed to sessionStorage.
  **The photo viewer runs the same bar while the whole picture comes**
  (`sharpen` in the lightbox, `.ptr-bar.lb-load` inside `.lb-overlay`,
  in either layout, along the viewer's top edge under the notch on a
  track that reads on its black). A photo opens as its viewing copy
  and an item's `full` is fetched on the first zoom, or at once with
  `opts.whole` (the album page). It is fetched with `fetch` and read a
  piece at a time, so where the answer carries a `content-length` (the
  file routes send one, and CORS `*`) the fill is how far the bytes
  have got, held under 98% until the last one; with no length it
  creeps the way a page load does (`creepOn`, shared with the page
  bar). The bytes become a blob and its object URL goes into the
  `img`, decoded first so the swap does not flash; the address asked
  for is the same one an `img` would have asked for. **The bar shows
  only if the picture is still coming after `LOAD_WAIT`** (250ms), so
  one from the browser's cache or the service worker's swaps in with
  none. It fills to the end and fades when the picture is in, and fades
  at once when it fails. Moving to another photo or closing the viewer
  aborts the download, takes the bar away and revokes that photo's
  object URL; a whole picture is only ever fetched for the photo on
  screen. A `fetch` refused before any answer (CORS, a policy) falls
  back to loading it the way the viewer always did, through an
  `Image` with `crossOrigin`, under a creeping bar. `showLoadBar` looks
  for `.ptr-bar:not(.lb-load)`, so a page bar is never the viewer's.
  `verify-gallery.cjs` zooms a photo whose whole picture answers late
  and checks the bar runs and then goes with a `blob:` photo in place.
- **Motion** (site.css `:root` carries the full transitions.dev
  token scale — `--duration-*`, `--ease-*`, `--distance-*`,
  `--blur-*` — plus the recipe knobs; skills vendored in
  `.claude/skills/transitions-dev` and `transitions-polish`). Shared
  utilities in site.css: `.t-rise` (an element that just appeared
  rises), `.t-rise-list` (first eight children stagger in),
  `.t-swap` + `.is-swapping` (a status line's new text enters from
  below), `.t-digit-group` (number pop-in), `.is-shaking` (error
  shake). site.js drives them through `window.scs`: `rise(node)`,
  `swapText(node, text)` (unchanged text never re-animates),
  `digits(node, text)`, `shake(node)`, `replay(node, cls)`,
  `ms(token, fallback)`, `reducedMotion`. Page heroes do not animate
  (the `t-stagger` classes in the HTML are inert; they read as lag on
  every page change). Chrome: the scroll-linked bars share
  `--chrome-fade`/`--chrome-slide` (500/450ms,
  cubic-bezier(0.16, 1, 0.3, 1) — fast start, long decelerating tail):
  the top bar slides away, the app's bottom tab bar fades whole to 0.45,
  so the page shows through it the way other apps' bars do, and the
  floating submit button fades to 0.4, smooth in both directions. No
  blur: one was tried under the bar and taken out, since a fade to
  transparency was what was asked for. (The bar once kept a solid ground
  and faded only its icons, which read as dimmed rather than
  transparent.) The quest list's search boxes keep a solid ground and
  fade their contents. The
  settings menu opens as a dropdown from the gear (`settings-open`
  keyframes, close via `.is-closing` + the `settings-closing` veil,
  160ms timer), gear/theme icons cross-fade in one grid
  cell, the face at rest `visibility: hidden` as well as clear —
  **nothing in the two bars fades until the page has loaded**
  (`html:not(.chrome-ready) .site-nav *, … .tab-bar * { transition:
  none }`; site.js sets the class two frames after `load`, or a second
  after the script runs): a style change while a page was still
  arriving played as a fade on an iPhone, on the submit page — the solid
  bell and gear, then an outline round the bell — **the theme switch
  runs as a view transition**
  (`document.startViewTransition(flipTheme)`: the browser snapshots the
  page, the flip happens, and the old picture cross-fades into the new
  one, so icons, the map canvas, images and the browser's own controls
  all change on one clock — `::view-transition-old/new(root)` only set
  the clock, `--duration-fast` on `--ease-in-out`. Interpolating each
  element's colours instead can never reach a canvas or a native
  control, and `color-scheme: light → dark` is not animatable at all,
  which is why enumerating properties was a losing game. The old
  `html.theme-fading` class — colour plus opacity/filter/transform/
  fill/stroke on everything for one beat, then off — is the fallback
  where `startViewTransition` is missing; reduced motion skips both and
  flips outright),
  the burger folds into a cross and the mobile menu grows the
  bar with a WAAPI height tween (`setMenuOpen`; `.is-closing` while
  shrinking), toasts drop in under the top
  bar and fade back up (`.toast-stack` is top-anchored: `--nav-h` +
  10px, 63px + the safe area in the app, 12px over the fullscreen map
  which hides the chrome; `.is-open`, 350 in / 250 out — the bottom of
  the screen belongs to the sheet, tab bar and floating button), the
  install nudge the panel clocks, the countdown is a split-flap
  departure board (`.flap`, one module per digit, built by `setFlaps`
  in site-app.js: two static halves plus two hinged leaves, the old
  numeral falling on `.flap-leaf-a` while the new one waits on the
  static upper, then `.flap-leaf-b` swinging up over the old lower
  half — 130ms each way under `.is-flipping`; only a digit that
  actually changed turns, the numerals are set in `--mono` like the
  quest codes, and reduced motion swaps the faces outright). Quest
  list: the tick is an SVG stroke that draws itself (checkbox check),
  a tick flips the card in place (`tickInPlace` → `.is-just-done`
  pop) and the rebuild waits 420ms (`rebuildAfterTick`); the list
  never staggers in (it read as slowness); the tally pops its
  digits. Live tab: FLIP rows on the medium clock, a new
  team's row rises, "Updated just now" swaps on refresh only. Forms:
  sign-in and rego failures shake the card/button and swap the status
  line; matches, picked-quest bar, file rows, member cards, gallery
  cards and camera/compress panels rise. All guarded by
  `prefers-reduced-motion`. The sheet, morph, fullscreen-map and
  search-panel motion is a separate, hand-tuned system — leave it
  alone and don't fold it into these tokens.
