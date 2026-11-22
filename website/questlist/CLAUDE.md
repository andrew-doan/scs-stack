# The quest list, the sheet and the map

The quest page is the biggest single thing on the site: the list, the
sheet that rises out of a card, the map and the search panel
over it. The shared chrome it sits inside is in `assets/CLAUDE.md`.

- **Its script is five files**, cut the way site.js is
  (`assets/CLAUDE.md`, The shared script is five files) and loaded in
  this order after the site's: `scs-2-questlist.js` (the quests, the
  ticks and lists kept on the device, the list, the anywhere chip, the
  teams' numbers), `scs-2-questlist-sheet.js` (the sheet: its height,
  codes, files, question and standings, opening and closing, its stops,
  the morph and the drag), `scs-2-questlist-controls.js` (location, the
  floating search, the categories, the lists, ticking off, and Init,
  which loads the quests), `scs-2-questlist-map.js` (MapLibre, the
  style, pins, transit, taps, the wheel and the full-screen map,
  `TILE_URL` and `MAP_CENTER` among them) and
  `scs-2-questlist-screen.js` (the whole screen, the chip row, the
  desktop layout and side panel, and the full-screen map's search; it
  runs all five). Each adds its part to `window.scsQuestList.parts`,
  which is also where they hand each other names (`ql.name`), and the
  last runs them in order in one go. That matters here more than in
  site.js: Init's `.then` on the quest list runs as soon as the script
  that set it up finishes, and with a stored copy that is at once, so
  had the parts run as separate scripts it would have drawn the list
  before the map and the search panel existed.

- **Quest data** is the tab worker's D1, nothing else (the CSV is
  gone). `quest_regions` = the categories in display order (groups
  name their region by text; `regionRows` adds any name a group uses
  that the table lacks, so the two never drift; rename/delete/order
  via `quests/regions/*`; a group with region '' shows last on the
  site as "Other quests"). `quest_groups` = a quest as the site shows it (key, name,
  region, description markdown, flavour, location, coords JSON,
  submit_kind none/count/text/pick/choice/codes, prompt, options JSON with
  `@stations`/`@sushi` expanding to `src/data/places.ts`, `questions`,
  sort, hidden); `quests` = the tab's codes (group_id, label, points, sort,
  hidden). Group keys are usually a code (SQ40) but need not be (SQ41
  holds SQ41-H and SQ41-B). **Pins** (`coords`) come in as JSON or
  text, one a line from the dashboard's Map pins box and split by `|`
  in the CSV, each `Label @ lat, lng` (`parseCoords`). The worker once
  split on `|` only, so saving a quest with several pins folded them
  into one whose label held the others; every read goes through the
  parser, which takes such a label apart into its pins again, so those
  quests show every pin and the next save stores them properly. Retired codes end in `-o` and are hidden;
  hidden rows leave every public read but stay in a team's score
  sheet while it holds an entry. `src/quests.ts` owns it all:
  `questListPayload` → `GET /api/questlist` (regions in order, visible
  groups with visible codes, places), `saveGroup` (codes matched by
  `was`, renames re-key completions and submissions in one batch,
  never deletes), `deleteGroup`/`retireAll` (typed confirms),
  `importScs2` (from `src/data/scs2-quests.ts`, skips what exists),
  `setGroupAccess` (`quests/group/access`, who can see a quest — see
  **Who can see a quest** in `tab/CLAUDE.md`;
  the Retire button exists but is hidden),
  `exportQuests` (CSV with multi-line cells / JSON, `GET
  quests/export?format=`), `importQuestsPreview`/`importQuestsCommit`
  (`quests/file/*`, matched by key, codes by code, never deletes, any
  error row refuses the whole file). `upsertGroup` is the one write
  path for a group and its codes; `saveGroup` and the file import
  both go through it — and it is deliberately ignorant of the ask
  columns and `quest_files`, so a save or re-import can never wipe a
  quest's question or attachments.
  **A quest can ask several questions on the submit form**
  (`quest_groups.questions`, migration `2026-10-quest-questions.sql`):
  a list of `{kind, prompt, options}`, up to `MAX_QUESTIONS` (8), each
  a number (`count`), a line (`text`), one answer out of up to twelve
  (`choice`, new, never `@` lists), places from a list (`pick`) or
  which codes were done (`codes`). Every group carries `questions` on
  every read (`questionsOf`), and the first question is also written to
  submit_kind / prompt / options, so a page or a database from before
  the list still sees one answer box; the column holds the list only
  when there is more than one and is '' otherwise. `cleanQuestions`
  puts `codes` first and keeps one of it, since review credits from the
  first answer, and refuses a `choice` or `pick` with nothing to choose
  from (a lone answer box sent the old way is kept as it was). A file
  carries the list in its own `questions` field, a JSON cell in the CSV's
  last column so a sheet laid out before it still lines up; a file
  without it takes its one answer box as the list.
  **A region's colour** (`quest_regions.colour`, migration
  `2026-10-region-colours.sql`; `ROUTE_COLOURS` in quests.ts, the
  site's ten line colours; '' is red, as every region was before):
  set from the Regions card's select (`quests/regions/colour`), carried
  by the list as `region_colours` (region name to colour, only the ones
  picked). The sheet's route disc and the rule along its top take it
  through `--ql-route` and `--ql-route-ink` (`paintRoute`), with a dark
  letter on yellow, lime and grey, where white does not read.
  **Mystery points** (`quest_groups.mystery`, migration
  `2026-10-mystery.sql`): the tab knows and scores a mystery quest's
  codes like any other, and nothing anyone outside the dashboard reads
  says what they are worth. `questListPayload` (public and team) sends
  every code's `points` as null with `mystery: true`, and `/api/quests`
  sends null too. The site shows ??? on the list row, the search panel,
  the sheet's code rows, the page at `full/`, the submit page's code
  rockers and a message's quest card; the tally counts nothing for one
  and writes "+ ???" after the total while one is ticked. It is written
  by the editor's Save (the tick box under the codes), not by
  `upsertGroup`, so a file import leaves it as it was. What a team was
  credited for one still shows on its own score sheet, in its channel's
  post and in `/quest` — its total says it anyway.
  **Live quests** (migration `2026-10-quest-extras.sql`): a quest can
  carry attachments (`quest_files`, R2 keys under `qst/` in the
  SUBMIT bucket, thumbs at `<key>.t`, images + PDF only, ≤8 per
  group; public `GET /api/quests/file?key=` +`&thumb=1`, key-gated,
  immutable) and one question (`ask_kind` on `quest_groups`:
  ''/choice/number/text/wager, plus `ask_prompt`, `ask_options`
  JSON, `ask_open`, and `ask_open_until` — an optional UTC deadline,
  migration `2026-10-day-ops.sql`: `askFromRow` computes `open` as
  `ask_open` AND (no deadline or now before it), so a passed
  deadline answers 409 with nothing written and no one has to
  remember to flip the rocker). **A question that is not open is a
  secret**: it is usually written before the moment it is asked, and
  both public reads are open to anyone — so `questListPayload` only
  carries an ask while it is open, and the ask GET answers a closed
  one with `{kind: ''}` (indistinguishable from no question) unless
  the caller's team has a response on record, in which case the full
  spec + response come back so they can read their answer after the
  close. The POST's 409 for a closed ask stays (the honest message
  for a team mid-answer at the deadline; it reveals existence to a
  session holder, never content). Teams answer from the quest sheet with their
  submit session: `GET/POST /api/quest/ask` (open CORS + OPTIONS,
  no-store, never frozen; one `quest_responses` row per team,
  changeable while open, 409 closed, 401 no session; choice/wager
  need an option verbatim, number/wager integer amounts ≤100000,
  text ≤200 chars into `choice`; hidden groups answer 404). Console:
  `quests/group/files`, `quests/group/file/delete`,
  `quests/group/ask/save`, `quests/group/ask/responses` (a read —
  counts per option incl. orphaned answers, team rows with
  `updated_at` for first-correct judging),
  `quests/group/ask/settle` (wager only: winner picked, every
  response gets a completion of ±stake/points on the lead code and
  the ask closes, one batch, logged `ask-settle`). **A wager settles
  once**: the batch first claims `quest_groups.ask_settled` from ''
  with its own stamp (`{winner, at, by, id}`, migration
  `2026-10-settle-once.sql`) and each credit lands only if that
  stamp is there, so a second press, a retry or a different winner is
  a 409 that moves nothing — it used to pay every stake again. The
  responses read carries `settled`, and the dashboard shows it in place
  of the Settle control; a wrong winner is put right on the Scores
  tab. The dashboard
  group editor carries the attachments block and the ask editor
  (kind/prompt/options/rocker, a Closes at field writing
  `open_until`, responses table, typed-confirm
  settle). The sheet renders files (thumb grid into `scs.lightbox`,
  PDF rows) and the ask box (`#ql-detail-ask`: option buttons POST
  on tap, number/text/wager send explicitly, status line covers
  signed-out with a link to /submit, closed, recorded and errors;
  the GET's `open` and response override the cached list's hint —
  and `loadAsk` can build or tear the box down from the GET alone,
  which `renderDetailAsk` uses when the list carries no ask and a
  team is signed in: a closed question they answered comes back
  with their answer, and one that opened after the list was cached
  appears without a refresh (signed out, nothing is fetched); a team
  signing in or out, here or in another tab, builds the box again on
  an open sheet (`askSessionChanged`); a
  deadline shows as `.ql-ask-until` "Answers close <fmtTime>.";
  height changes go through `glideSheetHeight`). On the list, a
  quest whose ask is open wears a LIVE tag (`.ql-live`, uppercase
  0.72rem `--alert-ink` between the chip and the name) and the
  filter panel's "Live questions only" rocker (`#ql-live-only`,
  `state.liveOnly`) narrows to them; the rocker travels into the
  fullscreen search panel with the other filters.
  `tests/verify-ask.mjs` covers the worker side and
  `tests/verify-ask.cjs` the sheet + dashboard.
  The quest page maps a group to `{id: key, category: region, points:
  first code's points, codes, multi, repeat, …}`; CATEGORY_ORDER and
  the category select fill from the payload's `regions`. Tally (done
  map key `scs2-questlist-done-v2`): a plain quest stores `true` and
  counts its first code's points; a `multi` quest (several codes)
  stores the ticked codes as a list (checkboxes on the sheet's code
  rows, the list tick opens the sheet) and counts their points; a
  `repeat` quest (a per-unit lead code, a `count` answer box, or a lead
  code labelled "Per …", e.g. SQ70 "Per school") stores a number (the
  sheet's − / + stepper) and counts n × points. Every read goes through
  `doneValue`, which reads what was kept against the quest as it is
  now, since a quest can gain or lose codes after it was ticked: a
  tiered quest keeps the ticked codes it still has and reads a tick
  from before it had several as its lead code, and a quest with one
  code reads a list as done only if its code is in it. Ticks made in
  another tab redraw this one (`storage` event). **A part says how it
  scores** (`scoring`, `most` and `bands` on each code of the list, the
  worker's parts.ts): the sheet's points column reads "25 each" for a
  per-unit part and "up to 50" for a judged one, and a tiered or counted
  part shows no figure but a row under it for each band ("10 or more",
  100) and, for a counted one, each place that pays (from
  `rules.tally.awards`, kept on the quest as `places`), the rows in the
  muted ink and never tickable (`bandRows`). The page at `full/` draws
  the same rows in its code table. A mystery quest's bands and places
  show ???. `isComplete` (all codes ticked)
  drives the list's crossed-out `.is-done` **and the map's greyed
  pins** (`renderMarkers` — `isDone` there greyed every location of
  a partly ticked quest); a partly ticked tiered
  quest shows `.is-partial` (yellow box, dot — the box washes yellow
  on the quick clock and the dot springs on after it, `--duration-medium`
  `--ease-bounce` after a `--duration-micro` wait, the same shape as
  the tick drawing itself; going the other way both leave on the quick
  clock. `.ql-check::after` is always there, scaled to nothing, since a
  pseudo-element that exists in only one state has nothing to animate
  from, and `setDone` holds the list rebuild for 420ms whenever the
  card's *mark* changes — not only when it completes, or the rebuild
  replaces the card before the dot can move) and its tick opens the
  sheet — and because opening it on its own looks like nothing
  happened, `flashCodes()` points the sheet at
  `.ql-detail-points`. One class, `is-cueing` on `.ql-detail`, drives
  three things for 2700ms so they cannot drift: warm light breathes
  in the box, the instruction goes red with it, and every other
  direct child of the sheet — **except the grab bar, which never
  dims** — holds at `opacity: 0.42` (the step down is a WAAPI
  animation per child, driven by `flashCodes` — a script animation
  outranks everything in the stylesheet, so no rule or engine quirk
  can mask the fade into a snap; `settleCueDims` finishes them
  before the class comes off, and the way back is the
  `--duration-medium` transition). It starts
  `CUE_WAIT` 340ms after the tap, *after* the sheet's own 320ms open
  morph — beginning inside that morph had the text on its way down
  before the sheet had arrived, so it never showed at full strength
  and read as having been born faint. The light is `--glow-fill` on
  `.ql-detail-points::before`, inset `-1px` with a `--glow-edge`
  border so the box's own edge warms with it; the box is `position:
  relative; isolation: isolate` and the fill is `z-index: -1`, so it
  sits above the box's background and under its content, and its
  **opacity is the only thing that moves** — one flat colour across
  the box, never a gradient. Four
  breaths, each shallower (1, 0.8, 0.6, 0.42) and further apart
  (rests 90, 180, 390ms); the first three lengthen (470, 550, 660ms)
  but the last is the quickest (360ms), so the run ends rather than
  trailing off — each one drawing in over about a third of itself and
  emptying out over the rest, both halves on `--ease-in-out`, so it
  breathes rather than blinks. Nothing is painted outside the box;
  the square hard edge stays a square hard edge. There is no line of
  instruction under the box's label any more ("Tick the ones you did"
  was taken out); the light is the whole cue. The dim's way back is a plain
  *transition*, because a browser hands an element straight back to
  its resting style when an animation is taken away: dropping the
  class is what ends the run (a timer in `flashCodes`) and it eases
  home for free. Clearing every tick (`ql-reset-done`) hands its copy
  to the shared `scs.confirmSlide` (site-input.js, written up in
  `assets/CLAUDE.md`): the thumb must be RELEASED past 92% of the
  track, and the second panel's Clear button is what finally clears.
  `openClearFlow` is now only that call. `stopFlashCodes()` drops
  the class the moment the choice is made (a code row, the stepper,
  the done button, closing the sheet, opening a quest) — the cue has
  said what it was for. Cut short mid-breath, the light would snap, so it writes where
  it had got to into `--cue-from-light` on the sheet and `is-cue-out`
  runs a 340ms release from there, on a timer of its own
  (`cueOutTimer`), and a new cue takes it off before it starts: kept
  with the cue's timers, a second stop within 400ms left it on and
  every later cue showed only the release. On the sheet a ticked code row (`.ql-code-row.is-ticked`: a
  ticked part of a multi quest, or every row of a plain quest that is
  done) is bold and struck through by a red (`--line-red`) line that
  draws itself left to right and pulls back off on un-tick. The line
  belongs to `.ql-code-text` — a box holding the label and the points
  — so it **starts at the words, never across the code chip**; the
  chip marks itself by fading its lettering to `--sign-muted` at 0.7
  instead, and `.ql-item.is-done .ql-code` does the same in the list.
  The list's own strike is a `background-image` line on
  `.ql-item-label` growing 0→100% (`background-size`), which is why
  the quest's name is its own span. The checkbox is `align-self:
  start` so it never lifts the row's top above the chip;
  `syncDetailCodes` toggles the rows in place (called from
  `updateDetailDoneButton`) so the line can animate — rebuilding the
  rows would skip it. The "N of M teams" line renders as a grey placeholder from
  the moment the sheet opens and never changes height, so the sheet
  cannot snap mid-gesture. The `#ql-update` banner (green, outside
  `main`): `[hidden]` is forced `display:none` (the flex display used
  to override it and the off-screen transform was all that hid it),
  and one delegated click listener closes on `#ql-update-close`, else
  updates — so a stale cached page paired with newer script still
  works; the trigger is the pulse version (see the Messages bullet),
  never a payload diff, read again from every pulse the site fetches
  after the first (the `scs-pulse` event: back after a while in the
  background, a team signing in or out), and asked for again every five
  minutes while the page is in view (`scs.pulse(true)`). The sheet renders description through
  `scs.markdown`, the flavour line in italics, and the codes as mono
  chips with labels and points; its actions row carries a Submit
  proof link to `../submit/#<key>`. **The share button** in the head's
  top right (`#ql-detail-share`, floated right inside `.ql-detail-name`
  so only the name's first line makes room for it, and drawn the glyph's
  width with its 44px target on `::before`: a column of its own took the
  longest real name to three lines at 390px) copies `/questlist/#KEY`
  for the quest on screen and toasts "Link copied", falling back to a
  prompt holding the link where the clipboard is refused. **The head
  is pinned** (sticky, under the grab bar on a phone), so the content
  scrolls under its bottom edge. It used to scroll away under the grab
  bar, black under black, which sliced the disc along an edge nobody
  could see. The disc, the name's first line and both glyphs sit on one
  centre line: one line of the name is the disc's height, and with
  `text-box: trim-both cap alphabetic` (where the browser has it) it is
  the capitals that are centred rather than the line box, since a
  face's ascent and descent put them anywhere; the close is the share
  glyph's twin (one SVG drawing size, `--ql-icon`, one stroke) in a
  44px box with negative margins so it adds no height to the row; and
  `--ql-head-y` is the same above and below the row (on a phone,
  measured from the grab bar). A quest opened over another starts at
  its own top. Deep links:
  `/questlist/#KEY` opens that quest's sheet and `/submit/#KEY` arrives with the quest
  picked (both match the group key or any code via `normQuest`, and
  both listen for `hashchange` too — a message embed followed from
  the urgent pop-up on the same page changes only the hash). Codes
  are set in `--mono` (Roboto Mono first; the console loads it from
  Google Fonts non-blocking, the site uses the system stack) via the
  shared `.code` chip.
- **Whose list it is** (`questList()` in site.js, `#ql-more`): some
  quests show only to teams signed in with their submit code, so with
  a submit session on the device the list comes from
  `/api/questlist/team` and holds what that team may see. The copy in
  localStorage carries `seenBy`, the session's first characters, and a
  copy made for a different session (or for nobody) is not painted —
  the list waits for the network instead, so a team's quests never
  show to somebody signed out on the same phone. A session the worker
  refuses gets the public list. The public list's `more` says signed-in
  teams see quests it does not have, and `#ql-more` then sends the
  reader to sign in on the submit page; the submit page asks again on
  sign-in (`questList({fresh: true})`). The update banner fetches
  through `scs.fetchQuestList(pulseQuests)` so it takes the team's list
  too, at the version the pulse named. A kept copy at the pulse's
  `version` is not fetched again at all, and one at any other version
  is, lower included (`listCurrent`, `assets/CLAUDE.md`). A pulse below
  the version this device took is the counter set back on the
  dashboard: the banner takes it as the version taken and fetches the
  list quietly, with no banner, and a rise from there shows the banner.
  `questlist/full/` reads the same `questList()`, so a signed-in team
  sees its own quests there too, under the same rule about whose copy
  is painted. `verify-questlist.cjs` covers it.
- **Anywhere quests**: a group with no `coords` gets no pin, and on
  the SCS.2 list that is 51 of 93 — Clubs, Briefings, Competition and
  Region 11 have none at all, and Mr/Ms SCS are two of the biggest
  scores on the tab. A map read as the whole list hides them, which is
  what test runs found. `isAnywhere(quest)` (no locations) drives
  three things. **Two rockers, one three-way choice**: "Show quests
  without a fixed location" (`#ql-show-unlocated`,
  `state.showUnlocated`, on by default) and "Anywhere quests only"
  (`#ql-anywhere-only`, `state.anywhereOnly`). They are exclusive —
  `setShowUnlocated`/`setAnywhereOnly` are the only way to set either
  and each stands the other down, so the fourth combination (show only
  these, and hide these: an empty list) cannot be reached. Both travel
  into the fullscreen search panel with the other filters. **The
  sort**: the distance comparator in `renderList` reads a null
  distance as 0, so an anywhere quest heads its region instead of
  sinking below every pin the moment location is on — sorting it last
  was what buried half the list. **The chip**, `.ql-map-anywhere`, on
  the map itself: bottom-left in every state, and on a phone in full
  screen it rides above the search panel level with the locate pin
  (`--map-btn-lift`, and it fades with the buttons when the panel
  fills the screen). It has three faces — "N not on the map" (a tap narrows
  the list to them), the same pressed and green while that filter is
  on (a tap undoes it), and "N hidden" in `--alert-ink` when the first
  rocker is off (a tap puts them back) — so it always says what the
  pins are leaving out and a tap always reaches them. N is what the
  other filters leave: `anywhereCount` puts both location flags aside
  and asks `matchesFilters`, so the rules stay in one place. Tapping
  it lands on the list rather than on a map with no pins left: the
  search panel opens to half in full screen, otherwise the list card
  scrolls into view (`scroll-margin-top` clears the fixed bar). An
  ANYWHERE tag on the rows was built and then taken out again after a
  playtest; rows say "No fixed location" as they did before.
  `tests/verify-anywhere.cjs` covers all of it.
- **The desktop layout** (`#ql-side`, `.ql-main`, `html.ql-desk`,
  `placeSide()`): above 930px and outside the app layout the page is the
  shape it started as — the search, the chips and every switch in a
  330px column down the left (280px up to 1100, where the list beside
  it needs the room) that stays put as the page scrolls, the map beside
  it, and the list under the map. The list's quest and place columns
  share what is left 3:2 rather than the place taking a fixed width,
  which at 1024 left a name 30px. A wide screen is not a tall
  phone: the floating search beside the floating submit button is a
  thumb's shape, and on a desktop both were a long way from where the
  eye was.
  **The pieces are moved, not copied.** `placeSide()` puts `#ql-pill`,
  `#ql-chips` and `#ql-filters` into `#ql-side` and records where each
  came from, so the switches keep their state and their listeners and
  there is only ever one of each. It stands down while `travelled` is
  set, because the fullscreen map borrows the same pieces through
  `travel()` — which remembers wherever they happen to be, so the two
  movers cannot disagree. The one case that needs catching is the window
  crossing the breakpoint while they are away, which `travel(false)`
  does on the way back.
  **The chip row folds** (`foldChips()`, `.ql-chip-more`): sideways it
  is as long as it needs to be, but wrapped down a 330px column eleven
  regions are five rows of chips above the search. The first two rows
  stay and the rest open on a button at the end of the row. A chip's row
  is its `offsetTop`, measured with everything showing; the category
  that is on is never one of the hidden ones, because a row that folds
  away the answer reads as nothing being picked, and a hidden chip takes
  no space so the one that is kept moves up beside the last one still
  showing. The button takes a chip's place in the row it joins, so if
  that pushes it onto a third row the last chip before it goes too. It
  runs from `fillCategorySelect`, `pickCategory`, `placeSide`, `travel`
  and a resize, and stands down anywhere the row is not in the side
  panel — the fullscreen search panel shows every chip.
  The rules hang off `html.ql-desk` rather than the media query alone:
  the class is what says the pieces are actually in the panel. The
  column's rules for the chips, the drawer and the switches are also
  held to `:where(.ql-side)` (same weight), because `ql-desk` stays on
  while the full-screen map has borrowed the pieces, and they used to
  follow them into its panel; the full-screen sidebar has rules of its
  own (below). In it the
  pill is `static` and its filters button is gone, because every switch
  is on screen, and the card's shadow goes with it: in the column it is
  part of the page rather than something opened over it, and the map
  card beside it gave its own up for the same reason — the list card
  under it never had one. `filtersArePanel()`
  is what keeps `setFiltersOpen` from closing something no button
  opens — and it asks `onDesk && !travelled`, not the width, because in
  the fullscreen map's search panel the button is in charge again.
  The side column is `position: sticky` at `var(--nav-h) + 16px`, the
  same sum the chips use and for the same reason, with a `max-height` so
  a panel taller than the screen does not hide its own bottom.
  `openPill` does not scroll to the list here: the box is already beside
  it, and jumping the page would only move what the reader is looking
  at. Below 930 the floating search runs the width of the row, as it
  does in the app layout.
- **What narrows the list** (`#ql-chips`, `#ql-filters`, `.ql-filters-btn`):
  the categories are a row of chips with **All** at the head, and every
  switch is behind a button. What they replaced was a black panel under
  the page's name holding a category select, five rockers, the locate
  button and the radius slider — 535px on a phone, so the whole first
  screen was controls and the map began below the fold. The map is the
  first thing on the page now.
  **The chips** are built by `fillCategorySelect` from the payload's
  regions (the name is what it always was; it fills a row rather than a
  select), one `button.ql-chip` each, `pickCategory` sets
  `state.category` and scrolls the chosen one back into view. **On the
  web it is on the paper** (`html:not(.is-pwa) .ql-chips`, the
  Submit/Compress row's answer): in the bar's colour, once the page's
  name was no longer on a black band above it, it floated between the
  name and the map as a strip of its own. Stuck under the top bar it is
  still opaque, with the hairline under it. The app layout keeps the
  bar's ground, since there it is the first thing under the bar. The row is
  sticky: `top: 0` in the app layout, `var(--nav-h)` on the web, because
  a sticky offset is measured from the scrollport and the app layout
  already spaces the body by the bar's height — setting the bar's height
  in both put the row a second bar down the page. `html.nav-up` drops it
  to 0 so it rides up with the bar, **and in the app layout to -53px**,
  because there `top: 0` is already the bar's bottom edge: the row used
  to stay exactly where the bar had been, with a strip of empty page
  above it. The 53 is the body's own padding, which lands the row under
  the cutout cover rather than over the notch. **On a phone in the app
  layout it is not sticky but fixed** under the bar (`.app-pin`, see
  the pull in `assets/CLAUDE.md`), so the page's bounce at the top
  cannot drag it down; there `html.nav-up` takes it to
  `env(safe-area-inset-top)`, the same place the -53px lands the
  sticky row. It sits at `z-index:
  1050`, over the map's own controls at 1040 — the fullscreen button,
  the locate pin and the anywhere chip all scroll up past this row and
  were drawn over it on the way. The side bleed is `calc(50% - 50vw)`
  rather than `--gutter`, which is the grid's column gap (26px) and not
  the shell's inset (16px); using it overhung the viewport either side.
  **The drawer** (`#ql-filters`) is a card, not a sign: paper and a
  hairline, and no shadow because the page dims behind it; the settings
  menu's rows sit
  inside it — a name at reading size, its control beside it, a hairline
  under it and none under the last in a group. It was drawn on the sign
  black when it was the page's whole first screen and had to read as one
  object above the map; as something a button opens over a paper page
  that was a slab dropped on top of it, and five names in the uppercase
  label voice read as five headings with nothing underneath them. That
  voice is for the group titles, which is where the settings menu puts
  it. `.ql-checkbox` sets 44px as a minimum on the content box, so
  padding here adds to it rather than filling it.
  It holds the rockers and the locate row, and opens from `#ql-filters-btn` beside the
  search box — which is what shortened the box — or from
  `#ql-search-filters-btn` at the end of the fullscreen map's search
  row. `setFiltersOpen` drives `html.ql-filters-open` and both buttons'
  state; a tap outside closes it. **Whether the drawer shows is one
  rule**, `syncDrawer`: while it is the side panel or while it is open.
  `setFiltersOpen`, `travel` and `placeSide` each run it after changing
  what it reads.
  **Both travel** (`travel(on)`, still called through `placeFilters`):
  the drawer and the chip row are MOVED into the fullscreen search panel
  and back, so the switches keep their state and their listeners.
  **The radius slider is not in the drawer** (`#ql-radius-group`): once
  location is on it shows straight under the map, and in the full-screen
  map it travels into the chips' host after them (`ql-chips-full`), so
  it sits under the chips and `measureChips()` counts it in the
  collapsed panel's height — which is why locating and clearing call
  `measureChips()`. It carries its own Clear location button everywhere
  (`#ql-radius-clear`, which clicks the drawer's Clear). Hidden in the
  drawer it was a control nobody found after allowing location.
  **The drawer arrives closed.** In the side panel it is always showing,
  because nothing opens it there; in the search panel a button is in
  charge again. `setMapFull` closes it before the move, at which point
  `filtersArePanel()` still sees the side panel and keeps it showing,
  and `travel` runs `syncDrawer` again once `travelled` says otherwise.
  Without that, a desktop opening straight into full screen came up with
  the switches spread across the map.
  **The row gives something back at its ends** (the rubber band in
  scs-2-questlist-screen.js): a sideways scroller that stops dead is
  the same picture as one that is stuck, and on a row whose first chip
  is All there is nothing else to tell them apart. iOS bounces its own
  scrollers and nothing else does, so the row does it itself and every
  phone gets the same thing — past either end the content follows the
  finger at the sheet's own asymptote (90px, approached and never
  reached) and the release springs it back. The touch is only claimed
  while the row has nowhere left to scroll, so an ordinary drag is
  still the browser's and `verify-questlist.cjs`'s sideways-drag check
  is untouched by it.
  **A page rule aimed at `.ql-chips` follows the row into the panel.**
  `html.is-pwa .ql-chips` carries one type selector more than
  `.ql-chips-host .ql-chips`, so its pull-up — the shell's top padding,
  which is right on the page and means nothing in a panel — won: the row
  sat 32px high, hung half off the bottom of the screen, the host
  measured 32px short so the collapsed bar was cut to match, and what
  was left of the row was clipped rather than scrollable.
  `html.is-pwa .ql-chips-host .ql-chips` is what puts it back.
  **Every home is read before anything moves.** Reading them as each
  piece goes loses the order when two of them share a parent: taking the
  drawer out first leaves the chips as the last child, so both come back
  with nothing to sit before and both are appended. It is invisible
  while their homes are different elements, which is what they are
  today — it showed up the day a side panel briefly gave them the same
  one, and it stays fixed because the next thing to share a parent will
  not announce itself. In the
  panel the chips are part of its head, under the box and above the
  results, and the collapsed bar's height is measured with them in it
  (`measureChips` drops the drag's cached height, since the row follows
  the text-size ladder) so both are showing before it is opened. **Closing a layer and arming another in
  one tick is a trap**: `scsBackLayer.disarm` leaves a `history.back()`
  in flight and the stack pops on the popstate, so tapping full screen
  with the drawer open opened the map and the drawer's own pop shut it
  again. `afterDrawerCloses` waits for that pop through
  `scsBackLayer.after` (site-chrome.js) before `setMapFull` runs.
  **Every way out of full screen but the back gesture** — the button,
  Escape, the browser leaving its own full screen — goes through
  `leaveMapFull`, which closes the drawer and then a raised search panel,
  waiting for each pop, so the map's own layer is on top when it goes.
  Escape takes one layer a press in the same order, and only while one
  of the page's own layers is on top (`ql.mapLayerOnTop`, the search
  panel's, the sheet's): the settings menu or the viewer opened over the
  map takes its own Escape (`scsBackLayer.isTop`, `assets/CLAUDE.md`). A quest sheet open
  over the map stays open on the way out and its layer stays on top, so
  the layers under it are still disarmed out of order there.
  `#ql-map-locate` is no longer fullscreen-only: the pin sits under the
  fullscreen button on the page map too. A location found before the
  map exists is fitted when it arrives (`mapArrived`), and Clear or a
  second tap drops the answer to a request still in flight
  (`locateAsk`). The "N of M quests shown" line
  (`#ql-count`) moved out of the sign to sit between the map and the
  list, in `--muted` rather than the sign's ink.

- **Where the search is entered** (`#ql-pill`, `.ql-pill-*`): the page's
  text filter is `#ql-search` as it always was, but it left the panel at
  the top of the page for a bar floating above the bottom bar, to the
  full width of the row. It rests at `--ql-pill-rest`: above the bottom
  bar in the app layout, and on the web 18px off the bottom of the
  screen plus `--ql-pill-lift`, how much of the web footer is showing,
  which `placePill()` measures on scroll and resize (the gap between the
  bottom of `main` and the bottom of the screen; nothing is written
  while the answer is the same). It used to line itself up with the
  floating submit button, which is gone (`assets/CLAUDE.md`). With the
  keyboard up the sums are the keyboard's instead (`html.kb-up`). The
  drawer's bottom is worked out from the same property, so the two
  agree about where the bar is. The bar runs from the gutter to the
  button (or to the far gutter) at rest and does not grow when it
  opens; opening it scrolls `.ql-list-card` to the top of the screen,
  which is the first row under the map. It is hidden while the map is full screen, which has a search
  panel of its own. **The box takes one command**: a value starting
  `/submit` (`SUBMIT_CMD`, `readSearchBox`) sets `state.submitMode`, and
  while that is on a tap on a list row or a search result goes to
  `../submit/#<key>` instead of opening the sheet. Map pins are not part
  of it. The mode is shown twice — the SUBMIT tag in the bar and
  `#ql-mode-line` over the list — and left by the line's own button, by
  the bar's clear key, by Escape, or by deleting the command. **The two
  boxes are one search** (`applySearchText`): what is typed in the
  floating box or the fullscreen panel's (`#ql-search-input`) is written
  into the other, and the mode and `state.search` are read from it, so
  the list, the pins and the panel's results follow the same text and
  the mode belongs to the page rather than to one of the two boxes.
- **Full quest information** (`#ql-full-info`, `state.fullInfo`,
  localStorage `scs2-questlist-full-info`): a rocker in the filter panel
  that folds everything the page at `full/` shows under each row —
  description, flavour, code table, attachments — instead of sending the
  reader to another page. `full/full.js` is the one renderer: it exports
  `window.scsFullQuest.details(group, {location: false})` and the quest
  list loads that file and `full/full.css` alongside its own, so the two
  pages cannot drift into two ways of drawing a quest. The page at
  `full/` still works as a URL and is still in `PRECACHE`; what went is
  the link to it in the tally foot. Blocks are built once per quest and
  kept (`fullBlocks`): the list is rebuilt on every keystroke and after
  every tick, and re-running the markdown and re-fetching the thumbnails
  each time would be felt. A card carrying all of that is taller than
  the sheet it would grow into, so `canMorph()` stands the card morph
  down while it is on and the sheet uses the stock slide.
- **Hide Checklist** (the settings menu's rocker, `assets/CLAUDE.md`;
  `html.hide-checklist`, stamped by this page's boot script and read
  into `state.noChecklist`): for a team that does not use the ticks and
  wants the room for the quests. Every read of the saved ticks goes
  through `doneValue`, which answers nothing while it is on, so no row
  is done or part done, no pin is greyed, the total is nothing and Hide
  Ticked-off Quests has nothing to hide. Nothing writes to
  `scs2-questlist-done-v2` meanwhile, because every control that could
  has gone: the CSS takes away the list's tick boxes and their column
  (the rows and the heads drop to one track, and `.ql-item-full` moves
  to column 1 with them, or it would open an implicit second one), the
  Total section, the Hide Ticked-off Quests rocker (`.ql-done-row`) and
  the sheet's Tick Off button and stepper, and `renderDetailCodes`
  builds no tick boxes on a tiered quest's code rows. With the Total
  gone the list is the end of the page, so `.ql-app` takes the
  clearance the Total kept under the floating search. A flip redraws
  the list, the pins, the search results and an open sheet (through
  `glideSheetHeight`), and turning it off brings every tick back as it
  was. `verify-questlist.cjs` covers it.
- **Lists** (localStorage `scs2-questlist-lists`, `{lists: [{id, name,
  keys}]}`; `state.lists`, `state.list`): a reader keeps quests on lists
  on this device. **Saved** (`id: 'saved'`) is always there and always
  first; the rest are made on a quest's sheet. **A list is also a
  route**: the line over a picked list carries **Plan Route**, to
  `../plan/?list=<id>` (Saved has a line now, with that link alone), and
  the planner is written up at the end of this file. The sheet's **Lists**
  block (`#ql-detail-list-picks`, `renderDetailLists`), between the codes
  box and the actions, is a chip a list, pressed (`is-on`, filled
  bookmark) for the lists the quest is on, so one tap adds or takes it
  off; **+ New List** opens a name box in place, and Add makes the list
  with this quest on it. A name already in use is that list
  (`addList`), names stop at 40 characters (`LIST_NAME_MAX`) and there
  are at most 20 lists. Opening and closing the box goes through
  `glideSheetHeight`. **On the chip row** a list with a quest on it is a
  chip between All and the regions (`.ql-chip-list`, `data-list`, a
  bookmark and a count); picking one sets `state.list` and puts the
  category back to all, and picking All or a region clears it, so a list
  and a region are never picked together. `matchesFilters` reads it, so
  the pins, the count, the map's search panel and the anywhere chip all
  follow. An emptied list keeps its chip while it is picked and loses it
  when something else is. **The line over a picked list**
  (`#ql-list-line`, `renderListLine`, the mode line's look) carries
  Rename and Delete List for a list someone made; Saved has neither and
  no line. Picking another list puts an open rename or delete away; it
  used to stay open, and its next tap deleted the list just picked. A quest on any list wears a small filled bookmark before its
  name on the list (`.ql-saved-mark`). Keys are kept when the quest list
  stops carrying them, so a quest hidden for a while is still on its
  lists when it comes back. Another tab changing the lists redraws this
  one (`storage` event). `verify-questlist.cjs` covers making one,
  picking it and the reload.
- **The rockers' tap target** is the switch, not the row. Each is a
  `div.ql-checkbox` holding the words in a plain span and a
  `label.ql-rocker` around the checkbox and the drawn switch, because a
  label wrapping the whole row flipped it whenever a finger was put down
  on the words to scroll. The invisible checkbox carries `z-index: 2` so
  the drawn switch, which is positioned, cannot bury it. The iPhone tick
  needs a finger to land on a real native switch, so site.css's
  "Direct-tap haptics" grows that checkbox from a corner pixel — its rule
  names `.ql-checkbox > input`, which no longer matches, and the page
  repeats it against `.ql-rocker > input` instead. Narrowing the settings
  menu's and the submit page's rockers the same way is a change to
  site.css; `tests/verify-switch.cjs` still asserts the old rule ("covers
  its row") for this page.
- **Quest search** (`scs.textScore` / `scs.questScore` /
  `scs.questSearch` in site.js; the dashboard carries its own copy,
  `textScore`/`questScore`, since its script cannot load site.js):
  one loose matcher behind the quest list's filter, the map's search
  panel, the submit page's picker and the dashboard's quest filter.
  Codes match anywhere inside (`"18"` finds SQ18, SQ18-1 and SQ118,
  letters or not; exact 300, prefix 250, inside 200) and a query of
  digits alone is a code lookup only — it must not find every
  description with that number in it. Text scores: a substring
  (180 at a word start, 150 inside), else every typed word must land
  on some word — prefix 120, inside 100, one letter off for ≥4
  letters or two for ≥7 (95 at the word's start, 90 anywhere;
  Levenshtein with an early exit), the letters in order inside the
  word 60. Extra text (description, place, region) counts at half.
  **Two letters the wrong way round** ("trian") count as a typo at the
  word's start (95). A filler word typed beside a word that matched
  ("public transport", "food quest"; `SEARCH_FILLER` in site.js) is
  passed over rather than failing the search. **The search matches
  letters, not meaning**: "train" does not find a quest that only says
  tram unless the quest is tagged for it. Two ways round that were built
  and taken out: a list of related words in site.js, which only knows
  the words somebody thought of, and a search by meaning on the worker
  through Workers AI's embedding model, which the committee decided not
  to depend on. Search tags are what is left for a quest people look
  for under another word.
  **Search tags** (`keywords` on a quest, from the list; the worker's
  side is in `tab/CLAUDE.md`, Search tags) count at nine tenths of the
  name, and show on the quest's sheet as chips under the flavour line
  (`#ql-detail-tags`), each closing the sheet and searching for itself.
  They are the organisers' words for a quest, set in the quest editor;
  the organisers' own tags, which decide what opens together, are a
  different thing and never reach the site.
  `questSearch` returns matches best first, ties in the given order;
  `matchesFilters` only asks whether the score is non-zero so the
  list keeps its category order. The submit page lists every match in
  a panel that drops out of its box (`submit/CLAUDE.md`) instead of
  the first eight; grid items there need `min-width: 0` or long names
  run past the edge. `verify-submit-page.cjs` and
  `verify-questlist.cjs` cover the typo, the bare number and the
  scrolling list.
- **What the sheet holds, in order**: the black head with the quest's
  name and nothing else, then the live question, then what the quest IS
  — the description and the flavour line — then where it is and how many
  teams have scored it, then what came with it, then what it pays behind
  its own heading, then the actions. What it pays used to come first, on
  the argument that it is what a team opens the sheet to find out; it
  reads the other way round, because a team that does not know what the
  quest is has no use for the figure. The region line under the name and
  the heading that stood over the description are both gone — the head
  says which region it is with its own route disc, and a heading reading
  "The quest" over the only description on a quest sheet named nothing.
  **The codes box is the last block now, so the cue scrolls to it**
  (`revealCodes`): the cue fires when a tick on the list only opens the
  sheet, and on a phone opened at half height the box starts below the
  fold. It writes the sheet's own `scrollTop` rather than calling
  `scrollIntoView`, which would also walk up and move the page behind.
  `verify-quest-sheet.cjs` holds the order.
- **A desktop browser gets the centred box at any width**
  (`html.ql-pop`, `syncPop()` and `isSheet()` in scs-2-questlist-sheet.js).
  The sheet is a phone's: `isSheet()` is narrow (`sheetMq`, ≤930px) and
  either a pointer that is not fine, or the full-screen map (whose panel
  is the sheet at that width whatever the pointer). Otherwise `ql-pop`
  goes on `<html>` and the quest opens as the desktop dialog, centred on
  the page, the same as above 930px. The stylesheet keys off the class
  rather than the width: the phone sheet's rules sit under
  `:where(html:not(.ql-pop))` inside the 930px block and the dialog's
  under `:where(html.ql-pop)`, so a narrow desktop window no longer gets
  the half-height pane with its grab bar. `syncPop` runs on load, on
  resize, when the pointer changes and when the map goes full screen or
  back, and puts a sheet at its card up to half when the layout stops
  being the sheet (leaving full screen in a narrow desktop window kept
  the card, with no dim and a backdrop that let taps through). In a desktop window under 560px wide the box takes the whole
  window (no padding round it, the full height), since a 520px box with
  room round it does not fit. The name `isSheet` matters: the gesture code already has a
  `var sheetMode` in the same scope, and a function of that name was
  overwritten by it and stopped the list rendering.
- **The rest of a narrow desktop window** (≤930px with a fine pointer
  that hovers, outside the app layout): the page keeps the phone's one
  column, but the chip row wraps inside it rather than running sideways
  off the window with a bleed to both edges, and it is `static` rather
  than sticky, since wrapped it is three or four lines tall and stuck
  under the bar it covered a third of the window. The floating search
  stands on a strip of the page's ground (`.ql-pill::before`, from the
  far left to the far right of the window and down to its bottom, a
  hairline along the top), because without the floating button beside
  it the list showed under and round the bar. **The filters button
  decides on the press** (`openAtPress`, read on `pointerdown`): in
  Firefox the drawer was closing between the press and the click, so
  the click found it shut and opened it again, and a second tap on the
  button never closed it. Chromium never showed it, so it is not in a
  test. **Once the wrapped chips have scrolled off the top a one-row copy
  slides down under the top bar** (`.ql-chip-bar`, the IIFE after the
  rubber band; `chipBarIn`), and it goes back up as the chips come into
  view again: the chips themselves stay in the page and nothing above the
  list changes height while it is being scrolled. The copy is
  `innerHTML` of the row, kept current by a MutationObserver, aria-hidden
  with its buttons out of the tab order; a click on one clicks the chip
  at the same index, so the row is still the one set of buttons and the
  one state. `showPickedChip` stands down while the copy is in, or
  bringing the picked chip into view would scroll the page back up to
  the row. Its padding is the row's own left and right edge, so its
  chips line up with the column; it rides with the top bar on
  `html.nav-up` like the row used to.
- **Quest sheet** (phones, `sheetMq` ≤930px): the whole sheet is the drag
  surface with iOS-style content handover (mode decided on the first
  move, and content scrolling is always done by hand — `handover`,
  never a browser scroll: the first move is cancelled, because once a
  native pan has begun no preventDefault stops it, and a gesture that
  scrolled the content then reversed onto the sheet had both moving
  at once; reaching full height mid-drag with more content switches
  to `handover`, back to `drag` at the content's top or bottom, and
  the release fling `flingSheetContent` stands in for the native
  momentum). The grab bar is `position: sticky` at the sheet's top
  (`top: -18px` cancels its pulled-up margin) over a strip of the
  sheet's background that fades out below it, so on a long quest the
  content scrolls away under the bar and the bar is always there to
  grab. Velocity snaps (full/half/gone;
  the snap transform overshoots ~1.25 and settles; a release that
  changes the size (half ⇄ full) applies the class at once with the
  transform compensated (`sheetShownY` + the height change) so the
  top edge stays under the finger, then only the transform tweens —
  height and position tweening together on two curves wobbled the top
  edge and slid the bottom edge in and out of view; the apron under
  the sheet (`--sheet-apron`: the sheet's box painted again every
  100px down to 900px — a box-shadow offset moves the box rather than
  stretching it, so one big offset paints nothing at all and the steps
  have to be shorter than the sheet; spread would bleed out either
  side of a sheet narrower than the screen) reaches the bottom of the
  screen from any lift, and `body::after`, the dim, carries
  `will-change: opacity` since the drag sets it every move),
  asymptotic rubber band, chevron grab bar, drag-linked dim
  (`--sheet-dim`). **In this form the sheet carries no border but the
  red one along the top**: the bottom one showed as a stray line across
  the apron when the sheet lifted, and the side ones run the height of
  the screen with nothing beside them — and since the head reaches the
  sheet's padding edge but not past its border, what they drew was a
  pale hairline down each side of the black head. In handover the content is scrolled by hand, so a
  release flings it (`flingSheetContent`, rAF, 0.998/ms decay, stops
  at the ends; a new touch cancels it) and the move handler never
  reads layout (`liftDuringDrag` places the map buttons from the
  sheet's start position plus the drag). The grey backdrop is a gesture
  surface too. **Every
  change to the open sheet's natural height must go through
  `glideSheetHeight(mutate)`** — it cancels the in-flight glide and
  re-targets from the current visual height; bypassing it reintroduces the
  bounce. A change that arrives under a finger or during the opening morph
  waits in a queue (`pendingSheetChanges`; one slot lost the question box
  or the standings when both arrived in the morph), and the queue runs
  in one glide when the gesture or the morph ends; opening a quest
  empties it, since everything is drawn and fetched again. Closing the
  sheet during the opening morph ends the morph first, so its finish
  cannot clear the transform origin under the close. **A mouse drags it too**, where the sheet is shown with a
  mouse (a narrow full-screen map, or a touchscreen laptop): a press
  on the grab bar or the head feeds the same start/move/end handlers
  through a touch-shaped object, the body keeps the wheel and text
  selection, mouse events within 800ms of a touch are ignored (a phone
  sends them after a tap), and a drag released over the backdrop is not
  a click on it. Any fine pointer that hovers also gets the close cross
  in the head, at every width; phones still close by dragging or a tap
  outside. Open/close use the container-transform morph (card ⇄ sheet)
  unless the `scs2-anim` setting says `slide`.
- **The map starts after the list** (`startMap`/`startMapSoon` in
  scs-2-questlist-screen.js): MapLibre's script, the style and the tile
  probe are a second of main thread on a phone, and run while the list
  was drawing they held it back. Init calls `startMapSoon` once the list
  is drawn and the veil is off, which waits for the browser to be idle
  (`requestIdleCallback`, 1.5s at most; 300ms where there is none, as
  in Safari). It starts at once when the map is the page (`ql-map-home`),
  when the address names a quest (`#KEY`), and on the full-screen and
  locate buttons, since those ask for the map. Before it starts the pins,
  the radius and the you-are-here dot are kept in `mapData` and drawn
  when the style loads, as they always were. On the stubbed phone at 4x
  the list came up at 1.2s rather than 2.1s on a first visit and 1.1s
  rather than 1.7s on a return. **On a return visit there is no idle
  wait** (`mapDrawnBefore`: a picture of the map is kept and the Offline
  Map setting is not off, so its tiles are on the phone; the setting is
  localStorage `scs2-tile-cache`, `'1'` or `'0'` as site-app.js writes
  it, not the worker's `'on'`/`'off'` flag, and `verify-offline.cjs`
  holds the two files to the same value): it starts as
  soon as the list has painted, one frame and a timer later.
  **The map as it last stood holds its place** (`showMapShot`,
  `watchMapShot`, `takeMapShot` in scs-2-questlist-map.js). The page is
  built afresh on every visit, so the map is too — its script, its style
  and every tile on screen decoded and drawn again, where a one-page app
  with a router would build its map once and keep it. So the first
  time the live map has drawn every tile at its opening view (the
  transport lines in, nobody having moved it, no quest open, no location
  on, our own tiles rather than OpenStreetMap's), the canvas is read the
  moment a frame is drawn (`render`, onto a 2D canvas, since a WebGL
  canvas keeps nothing once the frame is shown) and kept as one JPEG in
  the Cache API (`scs2-map-shot`, kept across a version bump in sw.js)
  with its size and look in localStorage (`scs2-map-shot`: width, height,
  the palette, the transport lines and the pixel ratio). On the next
  visit an `img.ql-map-shot` with it is laid over `#ql-map` at once, when
  the box is the same size and the look the same, under the map's
  buttons (z1 against their 1040; MapLibre's own controls draw over it
  too), and fades on `--duration-quick` the first time the live map is
  idle, or after ten seconds. A hand on the map card, the box changing
  size, full screen, a theme or Light Map flip and the transport lines
  switch take it away at once; a read that comes back under 12KB is a
  blank canvas and is not kept. Only the page's map has one: full screen
  and the map-home setting start without it. On the stubbed phone the
  picture was up 0.2s after a reload and the live map took over at 1.2s,
  with no tile asked of the network.
  **Where it was left** (`keptView`/`keepView`, sessionStorage
  `scs2-questlist-view`): within one tab the map comes back at the
  centre and zoom it was left at, across pages and reloads, and a new
  tab or the app opened again starts at the opening view. An address
  naming a quest opens on that quest instead. The picture above is of
  the opening view, so it is not laid over a kept view and not taken
  from one (`state.viewKept`).
  **It draws at most 2x** (`pixelRatio: scs.mapPixelRatio()`), or the
  screen's full density with the Sharper Map setting on
  (`assets/CLAUDE.md`), which a map on screen takes at once
  (`setPixelRatio` on `scs-map-sharp-changed`).
- **Map**: MapLibre GL 5.24.0 (WebGL), vendored in `assets/maplibre/` with the base style and the
  label glyphs: nothing is fetched from a CDN. The base style
  (`style.json`) is the Protomaps basemap from `@protomaps/basemaps`
  5.7.2 with the sprite and its icon layers (`pois`, `roads_oneway`, the
  locality dots) taken out, and town names (`places_locality`) sized by
  zoom alone with only a `kind_detail: city` larger — the stock style
  sizes them by population rank, which jumps from 12px to 20px at a
  threshold, so a suburb whose data carries a population just over it
  was set like a city beside neighbours at 12px; `{tileUrl}` and
  `{glyphs}` in it are filled
  in by `buildStyle()`. The glyphs kept are the Latin ranges of Noto
  Sans Regular, Medium and Italic (`LOCAL_GLYPH_RANGES`);
  `transformRequest` sends any other range to the Protomaps assets
  site. A device with no WebGL, or a script
  that fails to load, gets the "Map could not be loaded" line, and a
  later ask (the full-screen or the locate button) tries again; an error
  once the map has been made leaves the map as it is. The tile
  host (`TILE_URL`, `tiles.scs.andyrew.space`) is asked for its z0 tile
  first; if it does not answer the map builds an OSM raster style
  instead, with a toast. A base style that will not load does the
  same, with a toast of its own. The same host is `TILE_HOSTS` in
  `sw.js`, which is what decides whose tiles are kept offline, so the
  two change together. MapLibre fetches tiles
  from its web worker, which the service worker still answers.
  **The vendored bundle is patched once**, at its head: `scsCompat()`
  stands in for `Object.hasOwn` and `.at()`, which Safari only has from
  15.4, and the same function is put at the front of the worker's
  source (`workerBundleString`), since the workers are a copy of the
  library and call both too. MapLibre asks `Object.hasOwn` before every
  request, so on iOS 15.0 to 15.3 every tile, glyph and style fetch
  threw and the map stayed empty. **An upgrade has to carry the patch
  across**; `verify-anywhere.cjs` runs its pin check with both taken
  away, workers included, and fails without it. The dashboard's Map tab
  loads the same file.
  Zoom levels count 512px tiles: the map opens at 9, a quest at 13,
  stations show from 11.
  **Everything on the map is a layer of one style**: four GeoJSON
  sources the page owns (`ql-transit`, `ql-radius`, `ql-me`,
  `ql-pins`), written through `setMapData(key, data)`, which keeps the
  latest copy in `mapData` so the style is built with it and the
  sources are refilled on `style.load`. The radius and the transport
  lines go under the basemap's first label layer (`scs:data-before` in
  the style's metadata, `address_label`); stations, pins and the
  you-are-here dot go on top. A pin's colours ride on the feature
  (`fill`, `stroke`, read from the site tokens by `pinInks()`), and
  the open quest's pins carry `lit: 1`, which makes them larger, draws
  them over their neighbours (`circle-sort-key`) and gives each a
  label. Taps are `queryRenderedFeatures` in a box round the point,
  nearest first: 14px for a pin, so a finger hits a dot without the
  dot growing. A label is a `maplibregl.Popup` with the `ql-map-tip`
  class, set as the black sign in the CSS, with `pointer-events: none`
  so it never takes a tap meant for the pin beside it; one follows the
  mouse over a pin, a station or you, and a tap on a station shows its
  name.
  **The map's own colours are the page's**: `MAP_PALETTES.light/dark`,
  applied by `layerPaint(layer, palette)` to every basemap layer by its
  id (flat colours in `FLAT_INKS`, names in `LABEL_INKS`, road casings
  in the land colour so the white ribbon is the road) and to the
  page's own layers from the site tokens. **Quest pins and stations are
  white in both themes** (`pinInks` paper, `stationFill`): the pins were
  the card colour, which in the dark theme is the land's own `#1b1b1b`,
  so on the day a pin was a thin green ring on nothing and the transport
  lines were the only thing to read the map by. The dark palette's
  roads, water and parks were lifted off the land for the same reason
  (roads `#4a4a4a` rather than `#333`, water a dark blue rather than
  darker than the land). A theme flip does not hand
  MapLibre a new style — its diff would compare the whole transport
  network to find nothing changed — but walks `state.styleLayers` with
  `setPaintProperty`, and redraws the pins. Transit lines and stations
  come from `assets/transit.geojson`. Heavy rail is the TfNSW GTFS
  route-shape export (each feature carries its own official line
  colour in `c`, read with `to-color` and falling back to the mode's
  colour); T3 and T7 are each the one standard route, without the
  trackwork patterns, and T2 is its two normal runs — the city to
  Leppington through Merrylands and Liverpool, drawn whole, and the
  Granville to Parramatta branch drawn only where it leaves that line.
  The export's T2 also had runs via Regents Park, out of Bankstown and
  on to Macarthur, which are trackwork and are gone; Leppington, the
  end of the line, had no station point and has one now. T1 is the same
  shape: Emu Plains through the city and over the North Shore to
  Berowra drawn whole, and the Richmond branch only from where it
  leaves that line at Blacktown, rather than six overlapping runs from
  each end to the city. T5 is Richmond to Leppington, its normal run;
  the export also had runs from Emu Plains and one from Macarthur (the
  Campbelltown to Macarthur night shuttle), both left out. **A branch or a
  ferry detour ends on its line**, not near it: these shapes are thin
  (a point every few hundred metres), so the last point of a branch can
  sit tens of metres off the line it joins, which showed as a gap when
  zoomed in. An end within 60m of another piece of the same line is
  carried on, in the direction its last stretch was already going,
  until it meets that piece (within 200m; failing that it goes to the
  nearest point on it). Both shortcuts read as wrong: a link to the
  nearest point made a sideways stub, and moving the end onto the
  nearest point bent the last stretch. **Lines draw in file order**, a
  later one over an earlier one where they share track, so the order
  is kept on purpose: the 611 and 550 buses first, under everything,
  then the export's order (T8 first, T3 last) with T2 moved to just
  above T5, so where they share track T1 is on top, then T2, then T5. A rebuild that appends a line puts it over everything, so
  sort it back into place. **M1 is one line from Tallawong to Bankstown**:
  the export's Tallawong to Sydenham shape, joined to the Sydenham to
  Bankstown track that was already in the file (a shortest path over
  those OSM ways, so it follows one track rather than zigzagging
  between two). Light rail is L1 to L4 from the same export, and the
  buses are the B1 B-Line in its own yellow and the 611 and 550 in the
  bus blue, `#00B5EF` — one shape a route for all of them (the
  full-length one that runs the most trips; drawing both directions
  left doubled lines a few metres apart where they use different
  lanes). **Ferries F1 to F10** take the longest of each route's
  frequent shapes (a quarter or more of its busiest one's trips: the
  longest outright was sometimes a rare variant, F2's ran on to Mosman
  Bay on eight trips) and then only the stretches of the other frequent
  shapes that leave it by more than 50m, so a detour into a wharf is
  drawn without a second copy of the shared water. A wharf is one
  point however many sides it has. Stations are one point each: the
  exports list a stop once per line, and a station is only added where
  nothing on the map already marks the spot within 120m. Names drop
  "Station" and "Light Rail"; a wharf keeps "Wharf". Train station rings
  are neutral ink since a station serves several lines, and so is a
  light rail stop or a wharf marked `shared: 1`; one on a single line
  takes that line's colour. **Transport
  lines** in the filters (`#ql-transit`, localStorage
  `scs2-questlist-transit`, on unless `'0'`) sets the visibility of the
  three transit layers; the overlay is fetched and drawn either way, so
  turning it back on is immediate.
  **Double tap adds up, in one movement** (`installTapZoom`): every tap
  after the first in a quick chain adds a level to the zoom already
  under way. It is one `requestAnimationFrame` loop holding a target
  level and closing part of the gap each frame (`easeTo` with
  `duration: 0` and `around` the spot under the latest tap), not an
  `easeTo` per tap: a new touch stops a running ease, so MapLibre's own
  double tap and a chain of eases froze and then jumped
  when the taps kept coming. The chain is timed from the last lift to
  the next touch (320ms for the first pair, 420ms once going), so a
  finger resting a moment longer does not break it. A pinch, a wheel or
  a tap-and-drag fires `zoomstart` with an `originalEvent` and takes
  over; the loop's own steps carry none. A double click goes through the
  same loop. A tap that just opened a pin starts no chain. Rotation and
  pitch are off.
  **On a phone in the app layout the map is edge to edge** (under
  560px, `html.is-pwa:not(.ql-map-full) .ql-map-card`): the side bleed
  is the chip row's `calc(50% - 50vw)`, `.ql-app` loses its 14px so the
  card starts on the chip row's rule, and the card keeps only its
  bottom border. Wider, it stays a box in the column. Full screen places
  the card itself, which is why the bleed is kept off it.
- **Fullscreen map**: FLIP morph on `.ql-map-card` — always
  `settleMapMorph()` before measuring or re-toggling, or the fixed card
  wedges over the UI. **What opening it costs** was 1.8s of main thread
  on the stubbed phone at 4x and is 0.5s: the map at 2x, the custom
  properties off the root (the button lift goes on the map card, which
  holds every control that reads it; the safe-area insets are always
  set; `placePill` writes nothing while the map is full screen, where the
  floating search is hidden; `measureChips` no longer writes the chip
  height nothing read), the back layer armed 340ms in, once the morph is
  over, since the history entry is a long task (`armTimer`; closing
  before then clears it), and the second resize, 360ms in, only when the
  box is not the size the canvas was drawn at (`resizeMap(true)`), since
  a resize clears and redraws the whole canvas. The first, 20ms in, stays:
  the card's box is full size from the start of the morph and the canvas
  has to cover it.
  **It can be where the page starts** (`html.ql-map-home`, the settings
  menu's Full screen map rocker; site-input.js owns the key and the class, the
  quest page reads the class at boot and calls `setMapFull(true)` two
  frames in, because the morph measures the card and the card has no box
  until the page has laid out). Then full screen is the page rather than
  a layer over it, and a page with no way off it is a trap: the app
  layout keeps its bottom bar and everything else keeps the top one
  (site.css). The fullscreen layer stops where that bar starts — the map
  card, the sheet's overlay and the search panel are all inset by
  `--tabbar-h` or `--nav-h` — and the `--map-safe-*` inset on that edge
  goes to zero, because the bar is already carrying it. `fillCategorySelect`
  calls `measureChips()` for the same reason: opening full screen at
  boot runs the panel up before the list arrives, so the row it is
  sized around has no height yet.
  **Safe areas**: full screen means edge
  to edge, and a phone's screen is not a rectangle — turned sideways
  it loses a strip to the notch on one side and a curve at every
  corner. The map canvas still bleeds into all of it; nothing pinned
  to an edge may. The rest of the site is spaced by its fixed bars,
  which carry the insets already, but full screen has no bars, so
  the root carries them at all times as `--map-safe-l/r/t/b` (set with
  `.ql-map-full` they restyled the whole page on every open and close;
  only full-screen rules read them, and the map-home overrides key off
  `.ql-map-home` alone for the same reason) and every pinned thing (the two map buttons, the anywhere chip, the
  filters drawer, the search panel's own padding) comes in by them.
  `verify-anywhere.cjs` sets those properties by hand and checks each
  control moves, since no browser here reports a real inset. An
  `orientationchange` also re-places the buttons and calls the map's
  `resize()` 300ms later: a turn is not one resize, and the
  browser's own bars settle after it. Site chrome (nav, footer, tab bar, FAB) is
  display:none while fullscreen. **Every wheel over the map is the
  page's**, in the page and in full screen alike (MapLibre's
  `scrollZoom` stays off): a capture listener on `#ql-map` stops it
  before MapLibre's own wheel zoom sees it. MapLibre eases each event
  over 200ms and guesses mouse or trackpad from the first few, so a
  pinch through it trailed the fingers and changed speed; the old
  in-page handler stepped a whole level at a time. A trackpad pinch
  (ctrl+wheel) zooms by `-delta / 69.3`, which keeps the map under the
  fingers since a pinch's delta is about 100 times the log of its
  scale; a plain wheel or two-finger scroll by `-delta / 150`. A step
  under 0.2 of a level goes straight on; a bigger one (a mouse notch)
  glides out over a 70ms ease. **Momentum**: once no input has come for
  60ms, the zoom carries on at the speed of the last tenth of a second
  (capped at three levels a second) and decays over 100ms, which adds
  at most about a third of a level; grabbing the map (`mousedown`,
  `touchstart`) stops it. All of it is around the pointer, one
  `easeTo` with `duration: 0` a frame, carrying the wheel event so the
  tap-zoom loop knows a person has taken over. **In the page, a scroll
  of the page that runs on over the map stays the page's**: a wheel on
  the map within 300ms of one elsewhere is let through (and keeps the
  window open), so the map takes the wheel only once the pointer has
  rested on it and passing over it on the way down does not trap the
  page.
  The search panel (`#ql-map-search` —
  note `#ql-search` is the *filter panel input*, a duplicate-id trap
  that already bit once) runs on all widths: bottom bar on phones with
  sheet physics, the sidebar on a desktop (below). `placeFilters()` moves
  the panel's filter controls into the search panel while fullscreen,
  and the second map button is a locate pin. Its grab bar drags with
  a mouse as well as a finger (`applySearchDrag` is shared;
  mousedown on the bar, mousemove/mouseup on the document, and a drag
  swallows the click that would otherwise step the panel on again).
  Its list
  (`renderSearchResults`, rebuilt by `refresh()` too) shows each
  quest's `.code` chip and obeys the panel's filters
  (`matchesFilters(quest, true)`: category, ticked-off, location
  radius; its own box stands in for the hidden text filter), with an
  "N of M quests" count when they hide any. Tapping a result
  collapses the search to its bar while the sheet rises (z1350 >
  1320); sheet dismissal restores it, drag-linked via
  `searchReturnState`. Bowed like that the panel reads as `bar` with its
  back layer still armed, so `collapseMapSearch` asks the layer too.
  `raiseMapSearch` is the one way the input's focus, the drawer and the
  anywhere chip raise it: never in the desktop sidebar, which is always
  open, and never under an open sheet. Quest pans offset the pin into the visible
  area. Mobile fullscreen hides the +/- zoom control.
- **The map on a phone, after the day's feedback** (the map read only by
  its lines in the dark theme, full screen did not take the screen, and
  a quest tapped on the map jumped up as half the screen).
  **Groups**: the pins source is clustered (`PIN_GROUP_RADIUS` 26px,
  `PIN_GROUP_MAX_ZOOM` 12), drawn as a sign-black disc with a white ring
  and the count (`ql-pin-groups`, `ql-pin-counts`); a tap zooms to
  `getClusterExpansionZoom`. **The count is a picture in the site's own
  type**, not map text: the map's glyphs are one fixed face (Noto Sans),
  and a figure in it beside the page's Helvetica read as a different
  font. `ql-pin-counts` is an `icon-image` named `ql-count-<count>`, and
  `styleimagemissing` draws each one the first time the map asks
  (`watchCounts`, `countPicture`: bold, 12.5px, the body's own
  `font-family` read off the page, so Helvetica Neue where the device has
  it and SCS Heros where it does not, white, centred on the figures'
  own height, at the map's pixel ratio). Drawn before the face had
  loaded it would be the fallback, so `document.fonts`' `loadingdone`
  draws them again, and so does a Sharper Map flip (`redrawCounts`).
  The Group Map Pins setting (`website/assets/CLAUDE.md`) turns the
  groups off: `pinGroupOptions` is read when the style is built and
  `syncPinGroups` applies a flip to the map on screen. The open
  quest's pins go to a source of their own, `ql-lit`, unclustered
  (`drawPins` splits them, `pinLayer` draws both), so a highlighted pin
  is never folded into a group; taps and hovers ask `ql-pins-lit`, then
  `ql-pins`, then the groups. **One sheet, three stops** (where `isSheet()`). A pin opens the quest
  sheet at its **card**: the head and the line under it
  (`#ql-detail-glance`, `fillGlance`: the points, a bare figure getting
  "points", and the distance to the place tapped; where it is, the tapped
  pin's own label on a quest with several places; Directions, Apple's maps
  on an iPhone or iPad and Google's elsewhere). The card is not a box of
  its own: it is the half-height sheet pushed down by `--ql-card-drop`
  (`measureCard`, the sheet's height less the bottom of that line, run
  whenever its content or the window changes), so a pull up uncovers the
  description under the finger and nothing is swapped. There is no
  Details button: pull up, or tap the card's head or grab bar, to read on.
  The drag (`sheetCardBase` in the gestures) knows the three stops: from
  the card a pull up goes to half, down puts it away; from half a pull
  down goes to the card, a fling well past it puts it away; well above
  half it goes to full. At the card the page and the map stay live and
  undimmed (`html.ql-sheet-card`: no dim, the overlay lets taps through),
  a tap on the map puts it away, the map pans only when the pin is not
  already in the room above it (`frameAboveCard`), and the pins light up
  without their name tips (`state.litQuiet`, which `setCardStop` sets and
  redraws the pins for). Another pin swaps the
  quest at whatever stop the sheet is at; a quest picked from the list
  opens at half, or at full when the list was full, since picking from a
  list is already a choice to read. The line under the head stays at
  every stop, so the facts lower down no longer repeat Where and
  Distance. It replaced a small card floating over the map with Details
  on it, which opened a different element: the feedback was that the
  two felt disconnected. **The panel** is the search
  box alone while collapsed (74px plus the safe area; the chips come into
  view as it is pulled up, and the box's placeholder names a picked
  region or list, `syncSearchPlaceholder`). **When the map is dragged or
  pinched it fades toward transparent** (`is-faded`, from a `movestart`
  carrying an `originalEvent`, on the panel and the sheet at its card):
  the whole of it at 0.5, no blur, the way the app's bottom bar fades on
  a scroll. It stays that way when the map stops,
  until a finger or the mouse lands on the panel, any control over the
  map (a capturing `pointerdown` on the map card that is not on the
  canvas) or a pin, or full screen is left (`unfadeMapUi`). It used to
  slide most of the way down instead and come back 150ms after the
  fingers left, which moved the panel up and down with every pinch. **The whole screen** (`realFullscreen`): the tap on the full
  screen button asks the browser for it (`requestFullscreen` with the
  navigation hidden, or the webkit name on an iPad), on a coarse pointer
  outside the installed app, and leaving the map gives it back; the
  phone's own way out of it (Android's back) leaves the map too. An
  iPhone's Safari cannot, so it is told once (`scs2-map-home-screen-hint`)
  that the app on the Home Screen has the map without Safari's bars. The
  map-home setting opens without a tap and so without asking. **Under
  375px** the anywhere chip is a crossed-out pin and the count, the words
  kept for a screen reader. **Light Map** in the filters (`#ql-light-map`,
  localStorage `scs2-questlist-light-map`, its row shown only in the dark
  theme) draws the light palette under the dark page; `mapPalette` reads
  it and the switch repaints through `repaintMap`.
  `verify-anywhere.cjs` holds the card's hand-over to the sheet and back.
- **The desktop sidebar** (`@media (min-width: 931px)` under
  `html.ql-map-full`, `sideMode()`, `setSideAway()`): on a desktop the
  full-screen map keeps the quest list beside it — `#ql-map-search` is a full-height column down
  the left (`--ql-side-w`, 380px, 340 up to 1100) holding the search, the
  chips, the filters and every quest, and the map card starts where it
  ends. It replaced a box in the bottom-left corner that had to be opened
  before a quest could be picked. A quest opens over the column at its
  width; the search box no longer raises anything there, so Escape leaves
  full screen (closing the drawer first if it is open), and its touch
  drag stands down there, so a touch screen scrolls the list. **It can be put away**: the strip along its edge
  (`#ql-side-edge`, lit on hover with a tab that follows the pointer and
  a tooltip naming the key), the button at the map's top left
  (`#ql-side-show`, only while it is away) and `[` outside a text field.
  `html.ql-side-away` is kept in localStorage `scs2-questlist-side`
  (`'0'` away). Going, the map takes the width at once and the column
  slides off over it; coming back, `ql-side-opening` keeps the map at full
  width while the column slides in over it, and the map is resized once
  it has landed — so the map is resized at its larger size and never
  shows a gap. Away, the column is `inert` (`syncSide`, which also runs
  on resize, since below 931 the same element is the phone's panel and
  must stay live). The zoom keys step down out of the show button's
  way. **The chips fold there** as they do in the
  page's side column (`foldChips` asks `sideMode()` as well): on the web
  (`html:not(.is-pwa).ql-map-full`) the sidebar's own rules wrap them on
  the column's ground and put the switches in one column, which the
  page's column rules used to do by following the pieces in, and the
  chips carry the box's 14px inset. **The filters open inside
  the panel at every width** (`html.ql-map-full .ql-filters` is in the
  flow, at the head of the list under the button that opened it); they
  used to be fixed over the map, which on a desktop ran the width of the
  screen and on a phone covered the map's buttons. On a phone opening
  them raises the panel to half, and in full screen the page's veil is
  off (`body::before`), since it would only dim the map beside the panel.
  `verify-map-desktop.cjs` checks the column, putting it away, `[` and
  the stored key, and runs the mouse-drag checks in a 900px window,
  where the phone's panel is.
- **What teams see of the other answers** (worker side in
  `tab/CLAUDE.md`): when the ask GET carries `results`, the sheet draws
  `.ql-ask-results` under the status line: "N teams answered" in the
  label voice, a bar per option with the team's own pick in ink and
  marked, a settled wager's winner marked, and for every-answer mode a
  team and answer list with the team's own row marked. While an open
  question shows its answers, the sheet reads them again after the team
  answers, every 20 seconds while the sheet is open and the page in
  view, and when the page comes back into view. Signed out, the sheet
  still only asks about quests the list carries.
- **A challenge's standings** (Challenges in `tab/CLAUDE.md`): a quest
  whose `rules.tally.public` is on shows a Standings block on its
  sheet from `GET /api/quest/standings`, places as route discs the way
  the live tab draws them, hidden teams left out, and nothing while the
  tab is frozen or closed. A signed-in team sends its session, which
  only matters for a quest that only signed-in teams can see.
- **Tab stats in panels**: quest sheets show "N of M teams" from
  `TAB_API + /api/quests`, matched by normalised shortcode, and a dash
  when the API is down or the code has no tab row — a label beside an
  empty value read as something that had failed to draw.
- **The table's distance column** (desktop) is only there while
  location is on: `renderList` sets `has-distance` on `.ql-list-card`
  from `state.userPos`, and without it `--ql-cols` gives that track's
  width to where the quest is and its head is hidden in place, so
  Points keeps its track. "No fixed location" is muted
  (`.ql-item-meta.is-anywhere`): it is the absence of a place. A
  region's name over its quests is a heading in the page's ink rather
  than the column heads' small capitals.
- **A quest scored by calls from payphones** (`phone` on the quest, from
  the list's `phone: {number}`; `renderDetailPhone` in
  scs-2-questlist-sheet.js, `#ql-detail-phone` under the standings, on
  the standings' rows): the number as a `tel:` link, and for a signed-in
  team its phone PIN and the payphones it has, from `GET
  /api/phone/mine`, asked again when the session changes. Signed out it
  says where to sign in. The worker's side is in `tab/CLAUDE.md`, The
  payphone quest.
- **The route planner** (`website/plan/`: index.html, plan.js, plan.css;
  `tab/tests/verify-plan.cjs`). A page that puts one of the quest list's
  lists in order. **It reads and writes the same storage**
  (`scs2-questlist-lists`), so the order of a list's `keys` is the
  route, a reorder here is the order there, and a key the quest list no
  longer carries is kept at the end, as the quest list keeps it. What is
  the planner's alone is in `scs2-plan`: the list last picked, the place
  picked for a quest with several pins, and whether the route starts
  from the device. The quests come from `scs.questList()`, so the page
  works offline from the kept copy, and it is precached. **Distances are
  straight lines** between pins (haversine), and the time on foot is
  that distance times 1.3 at 4.8 km/h; the page says both are guesses.
  There is no routing engine: **Directions** on a stop is a Google Maps
  link in transit mode from the stop before it (or from the device),
  one leg at a time, because Google's transit directions take no
  waypoints. **Shortest Order** is nearest stop next and then pairs of
  legs uncrossed until none shortens the route (2-opt), from the device
  when Start From Here is on and otherwise keeping the first stop; a
  quest with no pin keeps its order after the rest. The drawing is an
  SVG of the stops as numbered route discs on a line, north up, with no
  map under it, so it needs no tiles. Add a Quest uses the quest
  search, tags and related words included. The page is on the shared
  chrome with a back arrow to the quest list; no menu links to it.

