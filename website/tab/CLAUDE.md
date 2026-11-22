# The live tab, team pages and the recap

The leaderboard while the day runs, and the pages that open once it
is over. `recap/` on the site is the other half of the same
feature and has no notes of its own.

- **After the event** (`tab/src/recap.ts`, migration
  `2026-10-recap.sql`, table `site_flags` name→0/1, `FLAGS =
  ['team_pages', 'recap', 'replay', 'push_off']`, the last being the push
  switch in `tab/CLAUDE.md`): switches the dashboard flips once the day
  is over, all off until a row says otherwise (the replay's is below). The tab is a
  race while it runs, so behind each switch the public read answers
  404 and the site shows nothing to tap. `flagValues(db)` rides the
  pulse (`pulse.team_pages`, `pulse.recap`); console `GET flags`,
  `POST flags/set {name, value}` (logged `flag-set`, no purge — the
  public pulse is edge cached for 30 seconds like the other public
  reads, so the site can see a switch up to 30 seconds late); the
  Settings tab's **After the event** card
  carries a tick box each (`#flag-team-pages`, `#flag-recap`,
  `#flag-replay`, `#flag-push-off`; `paintFlags`/`loadFlags`). `handleRecapApi` routes before the
  cached API, both reads open CORS + no-store, **404 while the tab is
  frozen or closed** whatever the switches say (`afterPagesShut`: they
  read the live tables, so they would show past a freeze), and the
  pulse reports the three switches off then:
  `GET /api/team?id=&name=` (`teamPage`: the team by its id, which
  the leaderboard rows carry (`id`, also in a frozen copy) and a rename
  does not change, else by name in any case, which older links carry;
  visible only → `{team, rank, dnf, teams, total, quests_done, lines
  [{code, group_key, name, label, region, amount, points, worth, at}]
  in the order recorded, submissions {sent, accepted, rejected,
  pending}, first_at, last_at, by_hour [{hour, sent, accepted}],
  by_half, by_quarter, by_minute, files {photos, videos, bytes},
  checked_in_at}`) and `GET
  /api/recap` (`recapPayload`: `teams, quests, completions, points,
  submissions {…, busiest_hour, by_hour, by_half, busiest_half,
  by_quarter, busiest_quarter, by_minute, busiest_minute}, review {reviewed,
  median/mean/fastest/slowest_minutes from reviewed_at −
  submitted_at}, quests_by_time [{key, name, region, done_by,
  points, peak_hour, peak_count, source}]` — the hour a quest was
  most often done, from accepted submissions where there are any
  (`source: 'submissions'`), else from `completions.updated_at`
  (`'completions'`, a Discord `/submit`); `most_done`/`least_done`
  (10 each), `never_done`, `regions` (each with `quests`, every visible
  quest in it with its completions, teams and points), `top_teams` (the first five
  places, so a team that did not finish is not among them),
  `most_active` (5 senders), `biggest_score`, `points_spread`,
  `files` (+ `biggest_bytes`, `gallery` opt-ins), `checkins`,
  `asks`, `boards`, the Recap tab's boards ticked for the recap, in
  `tab/CLAUDE.md`). Hidden teams are out of every number. The page
  shows neither the biggest score nor the questions. `most_done` leaves
  out the quests picked on the Recap card (`recap_most_skip` in
  `site_text`, `POST recap/most-skip`, logged `recap-most-skip`), so
  the page can call it Most done side quests; Rarely done leaves them
  out too.
  `checkins` counts only check-ins inside the Recap card's Arrivals time
  frame (`recap_arrivals`, `POST recap/arrivals`, logged
  `recap-arrivals`), which is how a test run is kept out. Hours are UTC
  stamps `YYYY-MM-DD HH:00`; `fillHours` zero-fills first→last (cap
  72, past that only hours with something). **The finer steps** come
  from one count by the minute, each minute put where the hours window
  puts its hour (`placeMinute`), then gathered by `stepRows` into half
  hours, quarters and minutes, each row's `hour` the step's first minute
  (`YYYY-MM-DD HH:MM`), zero-filled while the steps span a day at most. **The hours charted can be
  set** (`hourWindow`, the `recap_hours` row of `site_text`, JSON
  `{from, to, mode}`; the Recap tab's Recap card, Hours on the charts,
  `GET/POST recap/hours`, logged `recap-hours`), because the tab team
  records entries before and after the day: an hour outside the window
  is added to the nearest hour inside it (`merge`) or left off
  (`hide`), in both pages' `by_hour`, the busiest hour and each quest's
  peak hour, and `first_at`/`last_at` are the first and last sent inside
  it. The totals are not changed. **So can the review times'**
  (`reviewWindow`, `recap_review` in `site_text`, JSON `{from, to}` to
  the minute; the Recap card's Time for Tab Team to Process, `POST
  recap/review`, logged `recap-review`): only a submission sent at or
  after `from` and decided at or before `to` counts in `review`. The
  recap page calls it Time for Tab Team to Process, and the first and
  last sent First and Last submission to Tab. **A team page's quest
  times have one as well** (`timesWindow`, `team_times` in `site_text`,
  JSON `{from, to}`; the Recap card's Quest times on team pages, `POST
  recap/times`, logged `team-times`): a line recorded outside it comes
  back with `at` empty, so the quest and its points stay and the time is
  left off (on a phone the row loses its second line). **The live tab's Last scored has a
  cutoff** too (`last_quest_until` in `site_text`, `lastQuestUntil`,
  read by `lastScored` in index.ts; the Public tab card, `POST
  tab/last-until`, logged `last-until`, purged): a submission sent or
  recorded after it is not a team's last, so the team shows the one
  before. It picks what the column shows and moves no points; the
  dashboard says so under it ("Show no submission sent after"). A frozen
  copy keeps what it had. Quests without a group
  (loose codes) do not appear in the per-quest lists. The EOI award
  (`tab/CLAUDE.md`) comes back as a line with `award: true` and region
  Non-Quest Tasks, and team.js draws that table headed Task with no
  Recorded column. A team that did not finish has `rank: null` and
  `dnf: true`, and its page's lead line says "Did not finish, with N
  points." Site: the live
  tab's `applyFlags` (from `scs.pulse()`) turns every name into
  `a.tab-team-link` → `team/?id=&name=` (the name alone for a row with
  no `id`, from a copy frozen before the field; team.js sends both) and puts up **the band at the top**
  (`#tab-over`, `syncOver`, either switch on and the tab not closed): a
  black sign saying SCS.2 is over, a line under it (the finalised
  results, and with team pages open that a tap on a team shows its
  submissions), full width on a phone and the content's width as a box
  on a desktop like the welfare page's band, with SCS.2 in Numbers (`#tab-recap`, the recap switch) and Copy Tab
  as Image (`#tab-share`, the team pages switch) as its two buttons,
  redrawing the table from `lastTeams` when the answer lands. The Tab
  icon in the bottom bar goes back from a team's page the way its back
  arrow does. **The name stays in ink** with a muted chevron after it
  (`.tab-team-go`) and the whole row is the link (`tr.has-team-link`, a
  click anywhere on it clicks the name; the grey `--tint` on a fine
  pointer's hover and on a press): green underlined names down the
  table read as a column of links rather than a board. **On a phone the
  team page is a page pushed over the tab** (app layout): the bar's
  title is the team's name (`showName`, `.site-brand-page`), a back
  arrow (`.back-toggle`, drawn like the bar's icons, with its own haptic
  switch through `scs.hapticTap`) takes the bell's place at the bar's
  left end. **Three pages are pushed over another this way**: a team's
  page and the recap over the tab, and a quest's page over the recap,
  all through `assets/push.js` (written up in `website/assets/CLAUDE.md`):
  the page slides in from the right over the page it was opened from,
  which moves a third left under it; a swipe in from the left edge, the
  arrow and the bottom bar's way back carry it off to the right again,
  and it goes back through history when that page was the page before,
  so it comes back where it was scrolled. **Under it is the page it came
  from as it was left**: the link that opens it carries `data-push` (the
  tab's team names and its SCS.2 in Numbers button, the recap's quest
  rows), and site-input.js keeps that page's `main` as the link is tapped. That
  is why **the team page and the recap load scs2-tab.css** (ahead of
  their own sheets) and the quest page recap.css: the copy needs its
  page's styles. **It used to be a cross-document view transition**
  (`@view-transition` in scs2-tab.css and team.css), and on an iPhone the
  slide in stalled half way however late the page drew itself; the new
  page's picture in a view transition is live, so it waits on the new
  page's main thread, which is busy just then loading. The slide is now
  the arriving page moving its own `main`, which needs nothing from the
  page it left, and neither page opts into view transitions any more.
  Arrived at any other way (a reload, history, a link from elsewhere)
  the page just shows. site-chrome.js cancels the browser's own edge swipe on
  every page, which is why these pages need one of their own; that
  guard does not stop events, so this one still hears them. **On the web
  the same way back is a line over the name** (`.back-link`, "Return to
  Tab", and "Return to SCS.2 in Numbers" on a quest's page; site.css,
  not drawn in the app layout, where the arrow is), going back through
  history the same way the arrow does. **On the team page in the app layout
  the bar holds the back arrow and the name and nothing else**: the bell,
  the Welfare heart and the settings gear are not drawn (`.back-toggle`
  and the rule that hides the three are in site.css, for any page that
  carries a back arrow; the recap and the quest page below are the
  others). **Each of the three draws its answer once it has slid in**
  (`scsPush.ready`), so the slide has the page to itself.
  `tab/team/` (team.js/team.css: the figures, the quests grouped by
  region, an `h3.tm-region` over a `table.nice` each, hour bars, and
  **Submission stats**, a `dl.facts` of first and last submission and
  Total submissions sent, the count with the photos, videos and bytes
  after it) and `recap/` (recap.js/recap.css, titled SCS.2 in
  Numbers: the headline figures, with the hero's lead line hidden once
  they are drawn; hour bars + facts; the quests-by-time table, each row
  opening that quest's own page; `ol.rc-list` for Most done side quests and
  Rarely done (each row the quest's chip, name and a chevron, opening the
  quest's own page like the table's rows, the whole row taking the tap;
  the disc, the chip and the name sit on one centre line), the Podium (the first three, each in its own place's disc
  through `counter-set`, so level teams share one), Most submissions and
  the dashboard's boards (`#rc-boards`), two to a row in `.rc-pair` above
  760px; the organisers' own sections (below); `.rc-chips` never-done
  codes; the regions table, where each region with quests in it opens on
  a tap to a row per quest — its completions, the teams that did it and
  its points — and keeps open through a redraw; Fun stats). **On a phone
  the regions table is one grid** (under 560px: the table `display:
  grid`, its row groups and rows `display: contents`, so the cells line
  up from row to row at the width the widest cell in each column needs):
  a region and its three figures on one line, the Completions head
  reading Done there (`.rc-head-short`; the full word stays for a screen
  reader), since the head was the widest thing in its column and left
  the names too little room; a region's last word and its chevron wrap
  together (`.rc-region-tail`), and an opened quest is its name across
  the whole width with its figures on the line under it. **The chart's step is picked in its heading**,
  on the recap and on a team's page alike: "Submissions by Hour" with the
  word underlined and a chevron, opening a short list (Hour, Half Hour,
  Quarter, Minute) that grows from the word while the chevron turns over.
  One helper draws both (`scs.chartStep(box, key, onPick)` and
  `scs.CHART_STEPS` in site.js, `.chart-step*` in site.css), each page
  keeping its own pick (localStorage `scs2-recap-step`, `scs2-team-step`)
  and drawing the worker's rows for that step; Minute draws the two
  counts as lines, each with its area filled, and the note says line
  where it said bar. On the recap the Busiest row under it follows the
  step (Busiest Quarter and so on); the team page has no Busiest row. An
  answer from before the finer steps draws by the hour. **Figures and facts are one
  treatment on all three pages** (the recap, a team's, a quest's; the
  design went through a Fable critic to an approval, round by round at
  desktop and phone widths): a number is a figure, `scs.figure([n,
  words, n2, words…])` into `ul.figures` (`.figures-4/3/2`), the number
  at `--t-display` with its words under it at body size and any number
  among the words at `--t-head`, no-break-spaced to the word after it and
  adding nothing to the line's height; a time, a range or a sentence is
  a fact row, `scs.fact(dl, name, value)` into `dl.facts`, the name at
  800 beside its value on a hairline, the same at every width. Both are
  in site.css and site.js. **Headings and labels are in title case** on
  the three pages — the section headings, the figures' words, the facts'
  names, the table heads, the receipt's options — with the small words
  (in, by, and, of, out, the, to, a, for, on, at, with) left lower case:
  "SCS.2 in Numbers", "Submissions by Hour", "Last Submission". Sentences
  stay sentences: the notes, the lead lines and the values. **The team page's lead
  line is its place and its arrival**: "1st of 31 teams. Checked in at
  9:31 pm.", or while the team is part-way in, "3 of 4 checked in, the
  last at 9:31 pm." (`checked_in` on the answer; the stamp breaks as one
  word). A quest time left out by the dashboard's Quest times frame
  is not shown at all (an empty cell, and on a phone no second line).
  **The chart's note names the two greens** in the
  organisers' words: "5 submissions total with 5 accepted (dark green
  bar) and 0 rejected (light green bar).", with "and N waiting" before the
  second bracket when any are; the recap's says the same of the day. Both say "not open" on a 404 (`#tm-closed`,
  `#rc-closed`). **Both are on site.js and site.css** like the rest of
  the redesigned site: the name is the `.hero` on the paper with the
  lead line (`#rc-lead`, `#tm-place`) under it in the muted `hero-copy`,
  every block is a `section.section` under its own `h2.section-heading`.
  The team page loads scs2-tab.css only for the copy of the tab under a
  swipe (above).
  **A quest's own page** (`recap/quest/?key=`, quest.js/quest.css; the
  worker's `GET /api/recap/quest`, behind the recap switch, in
  `tab/CLAUDE.md`): the quest's name, its code chip (a link to it on the
  quest list) and region on one centred row, two figures ("15
  Completions out of 35 teams";
  the submissions, from how many teams, accepted, rejected and waiting),
  then **Accepted submissions by time**, each team in a numbered row
  with when it was sent, a team's name linking to its page while team
  pages are open; one sent outside the dashboard's Quest times frame
  comes at the end of the list with a dash where its place would be and
  no time (`.qs-untimed`). **A quest the dashboard shows photo by photo** (`visits` on the
  answer, `tab/CLAUDE.md`) also has **Stations Visited** or **Places
  Visited** above that list (`#qs-visits`, the heading from `kind`): each
  team in a numbered row, most places first and level teams sharing a
  place, its name with a chevron and its count, a tap opening its places
  in the order visited, each with the time on the clock (`scs.fmtHour`),
  set in under the name; what is open stays open through a redraw. A team signed in on the device also sees **Your submissions**
  for that quest (`/api/submit/mine?quest=`), each with its status, time
  and thumbnails opening the site's viewer. It is pushed over the recap
  (above), so on a phone it slides in from it and swipes back to it.
  **Sections the organisers write** (`sections` on the recap's answer,
  from the dashboard's Recap card; `#rc-sections`): each a heading, a
  few words in muted at a 720px measure, then its entries two to a row
  (one under 760px), each a title at body size, words (markdown) and its
  photos and videos from the Files tab, a photo opening the viewer.
  `table.nice` in site.css sets its head in the label voice (800
  weight) over the ink rule and keeps the page's own left and right
  edges; these two pages are the only ones that use it as it comes (the
  submit page restyles its own). Times come from `scs.fmtTime`, the busiest
  hour's date from `scs.fmtDay`, and both pages redraw from the answer
  they last drew on `scs-dates-changed`. **The tables fit a phone
  rather than scrolling sideways**: the recap's quest table and each of
  the team page's tables go to two lines a row under 560px (the recap's
  heads in the same two lines, quest and teams over region and hour; the
  team page's on one, Quest and Points, the time under each quest
  needing no head of its own), as grids with `role` attributes so they stay
  tables to a screen reader; the team page's tables share fixed columns
  above that, so the points line up from region to region, and Points
  is the last column so the award table lines up too. Charts are
  `scs.hourBars(container, rows, {key, inner, empty, step, line})` +
  `.hour-bars` in site.css — plain boxes on a line, the accent (the light
  green) as the bar and a dark green inner bar for the accepted part,
  which the two pages' notes name, or with `line` the same two as lines
  with their areas filled; `step` is the minutes a row covers (60 by
  default). The times go under the line in the label voice via
  `scs.fmtHour` (with its minutes below an hour's step), on the clock —
  every I minutes for the smallest I whose spacing clears the widest
  label, a label on the hour the hour alone (measured once the chart is
  on screen, which is why both pages unhide their body before drawing;
  drawn hidden it goes by the count) — a label at either end kept inside
  the chart, and one that then meets its neighbour left off. **A bar's
  figures show over the chart** (`.hour-tip`, a small black sign along
  the chart's top over the bar, the other bars dimmed; on the line chart
  a rule down it and a mark on each line): the bar under a
  mouse, and on a finger the bar tapped, or the one under it as it runs
  along the chart (`touch-action: pan-y`, so a sideways run moves the
  sign rather than the page), kept until a tap elsewhere. Each column
  carries the same words as its `aria-label`; the `title` it had is
  gone, since a mouse would get both.
  **Pictures to paste into a chat** (`assets/share-image.js`, written up
  in `assets/CLAUDE.md`): the team page's **Copy Receipt as Image**
  (`#tm-copy`, under the figures, a bar across the column under 560px)
  opens a window first (`#tm-preview`, on the site's pop-up card,
  `.confirm-overlay`/`.confirm-card`, and the whole screen under 560px)
  that shows the picture as it will be copied, scrolling where it is
  long, with **three levels** under it (`#tm-detail`, kept in
  localStorage `scs2-receipt-detail`; an old `scs2-receipt-compact` of
  '1' reads as the first): **Quests only**, **With codes** (a line under
  each quest: its submissions and the codes it holds) and **Detailed**
  (each code on a line of its own, indented, with its points, adding up
  to the quest's figure). A pick redraws the picture, each level drawn
  once while the window is open, so people see what it does before they
  copy. Copy starts the clipboard write inside its own tap with the
  picture as a promise, as Safari needs; back, Escape, Cancel and the
  ground close it. The picture is the team's receipt from the answer on
  screen, in the order the quests were first scored, with the place
  ("3rd of 41", or "Did not finish"), and no time on it: the "as of" line
  under the name is gone from both pictures. The live tab's **Copy Tab as
  Image** (`#tab-share`/`#tab-copy`, under the recap link; the toast says
  Tab copied.) draws the board as "SCS.2 Leaderboard". Once either
  after-the-event switch is on, the live tab's title loses the word Live
  (`.tab-live-word`, and the document's title). The tab's button shows
  only while team pages are open (the same pulse flag that turns the
  names into links) and the tab is not closed (`syncShare`). Both draw in the theme the page is showing
  (`data-theme`). Both copy onto the clipboard, or save the file
  where the browser will not, and say which in a toast.
  `tests/verify-recap.mjs` (worker) and `tests/verify-recap.cjs`
  (site) cover it.
- **The replay** (`tab/replay/`: index.html, replay.js, replay.css,
  and replay-map.js, which a team's page loads too; the routes are kept
  by the tab, cleaned and saved on the dashboard's Routes tab, written up
  in `tab/CLAUDE.md`, the cleaning in `tracks/CLAUDE.md`; its map draws at
  most 2x unless the Sharper Map setting is on, as the quest map does,
  `website/assets/CLAUDE.md`). The routes teams recorded for the GPS quest,
  played back on the map with each quest appearing where and when its
  proof was sent. **Behind its own switch** (`replay` in `FLAGS`, the
  Settings tab's After the event card, `#flag-replay`; it rides the
  pulse as `pulse.replay`): `GET /api/replay` (`replayPayload`, routed
  in `handleRecapApi`, open CORS, no-store, 404 while the switch is off
  or the tab is frozen or closed) answers every visible team with its place, total,
  `route` (when its route was saved, '' for none), `quests [{key, code,
  name, region, at, spot}]` and `log` (below), and `pins {key: [{label,
  lat, lng}]}` for the quests on it. **`log` is the team's points over the
  day** (`pointsLog`): an item `{at, points, sent, accepted}` for each
  submission the team sent (not deleted, `added_by` empty), worth what its
  live ledger lines are worth now, at `submitted_at`, so a quest counts
  from when it was sent and not when it was reviewed; one for each
  organiser's entry worth something; and one for each award, balance or
  line whose submission has gone, at the time its line holds. An item
  outside the Quest times frame carries `edge: 'start'` or `'end'` in
  place of `at`, so a test entry before the day or an award after it
  lands on the replay's first or last moment, and the last moment adds
  up to the tab (`verify-recap.mjs` holds each team's log to its total).
  `at` is in `STAMP_KEYS`, so the date rules strip it like any other. **`spot` is where the quest was done** (`{lat, lng,
  place}`, or left out): the pin of the code the proof was sent for,
  matched as the dashboard's Map tab matches it (`placeFor` in
  team-map.ts: the ticked codes, an organiser's credited codes or the
  code it was sent under, against the pins' labels, then by position when
  the quest has as many codes as pins), or the quest's only pin, or, last,
  the one of the quest's pins nearest where the proof was taken, if
  within a kilometre (`PHOTO_NEAR_KM`): the location in the photo's or the
  video's own metadata (`metaBlock` + `readExif`), read from the bucket
  the first time it is needed, twelve submissions a request
  (`PHOTO_READS`), and kept in `photo_places` (migration
  `2026-12-photo-places.sql`; NULL for files with none; rows for
  submissions no longer accepted are cleared as new ones are written and
  when a team is deleted, `forgetPhotoPlaces`). **Only the pin goes out**:
  the photo's own coordinates never leave the worker, and a quest with no
  pins is never placed by its photo. A quest none of these can place gets
  no spot (`placeFor`'s `between` false, so never the midpoint the Map tab
  falls back to). **A quest the dashboard shows photo by photo is a ring at each place**
  rather than one for the quest: a quest entry per place the team visited
  (`photoVisits`, `tab/CLAUDE.md`), with `stop` the place, `spot` its
  point (a station's on the transit map, or the quest's pin) and `at`
  when its photo was taken (`taken` true) or, failing that, when it was
  sent; the page puts it on its place at that time whatever the route
  says, names the place in the tip ("Central, photo taken at 11:20") and
  in Latest Quests, and says "sent at" when the time is the
  submission's. `GET /api/replay/route?name=` (`routeFor`, the same
  switch and closed tab, a visible team by name in any case) answers
  `{ok, route}`, the replay's copy of that team's route with the tab's
  spelling of its name. **A quest's time is when its proof
  was sent** (`submitted_at` of the first accepted submission of each
  quest), not the time its line holds, which is when it was reviewed and
  can be an hour later; one sent outside the Quest times frame is left
  out, and `undated` may send `at` as Sydney's `HH:MM`, which the page
  puts on the day of the route. **A route is public once the switch is
  on**: it starts and ends inside the day and the editor can cut more,
  but whatever was saved is what anyone can read. The tab's band carries **Replay the Day**
  (`#tab-replay`, an outline after SCS.2 in Numbers) while the switch is
  on, and the page is pushed over the tab like the recap (`data-push`,
  the back arrow and Return to Tab); it says not open on a 404.
  **The drawing** (`SCSReplay.start(host, {api, replay, single, teams})`,
  fetching from `api` the route of each team in `replay` that has one):
  MapLibre with the quest map's base style and palette (a copy of
  `MAP_PALETTES` and its layer rules, repainted on a theme flip) and the
  transport lines in grey under the names, so a team's colour is never
  read as a line's; the routes, the quests and where each team is are
  drawn on a canvas laid over the map's canvas and under its controls
  and pop-ups, redrawn on every move and every frame of play, because
  restyling a layer per team each frame would be the slow way to the
  same picture. **A moving map is drawn in its own frame**: the canvas is
  drawn on the map's `render` event whenever the camera has changed since
  the last drawing (`cameraKey`), not on `move` through a frame of its
  own, which left the routes a frame behind the map and made them jump
  as it was dragged. **It opens as the quest map does**: where it was left in this tab (sessionStorage
  `scs2-replay-view:all`, or `:team:<name>` on a team's page), and the
  routes' own view in a new tab; and with a picture of the map and its
  routes as they last stood at that view (`scs2-replay-shot:<page>` for
  its size and look, the JPEG in the `scs2-map-shot` cache at
  `/__replay-shot/<page>`, taken at the end of the day with every team
  shown and nobody having moved it) over the live map until it has
  drawn. The replay page asks for MapLibre while its data is on its way
  (`SCSReplay.preload`). A map position goes to the screen by a scale and a shift
  read off two projected points, since the map neither turns nor tilts.
  Each team is a route colour (the ten `--line-*` tokens, then a few of
  the transit file's), its route so far a line over a casing of the
  land colour, **dashed where it was filled in underground** (`filled`
  on a leg), its quests rings, and where it is now a disc with a white
  ring (a dot in it once its route has ended). A quest sits **on its
  pin when the route passes within 300 m of it in the hour before the
  proof was sent** (its `spot` alone when it has one, otherwise any of
  its pins), at the moment it came closest, and otherwise where
  the team was when it was sent; one with neither is left off. **Teams
  with no route** are behind a toggle chip after the team chips,
  **N teams with no route** (`.rp-team-others`, on a line of its own
  under the chips, `.rp-others`, because it switches a second set of
  marks rather than a team; off by default, kept in localStorage
  `scs2-replay-others`; only teams with at least one quest that has a
  `spot`): on, each of their quests is a ring in ink
  (`--text`) at its spot from the time its proof was sent, drawn under
  the routed teams' rings, ringing out when passed like theirs, in Latest
  Quests with a hollow ring for a disc, with a line of its own in the
  key (`.rp-key-other`, which says the routed teams' rings are in their
  colour). A tap on one lists everyone who did a quest at that place, in
  the order sent, six at most. A team's page shows only its own route. A quest
  passed while playing rings out once (not under reduced motion). The
  key under the map says what the dash and the ring are. **The
  controls** sit under the map, in the page: Play (from the start when
  at the end), the time on Sydney's clock (the 24-hour setting is read,
  and `scs-dates-changed` redraws it), Slow, Normal and Fast (2, 6 and 15
  minutes of the day a second, kept in localStorage `scs2-replay-speed`),
  and a slider over the day with the hours under it. **The slider is
  drawn in the system**: a square ink thumb with a surface keyline on a
  4px bar (`.rp-scrub-track`), the part played in green
  (`.rp-scrub-fill`, its width set with the time), a mark dropped from
  the bar at each hour and a shorter one at an unlabelled hour or, with
  room, each half hour, and the labels in the charts' axis voice, every
  hour or every second or third where they would meet (`layoutTicks`,
  measured, again on a resize). The speed buttons are one segmented
  control with the site's button keyline, at the body size. The page
  opens at the end of the day, every route drawn. On the replay page
  every team is a chip (picked while it is on the map, best placed
  first), with All ahead of them as a keyline control whichever teams are
  shown, since it is a command and not a team; on a phone the chips are
  one row scrolling sideways to the screen's edges. **Latest Quests**
  lists the last five the replay has passed, newest sent first, the code
  chips one width so the names line up. The lead line is "6 of 12 teams
  recorded a route." or "All 12 teams recorded a route.". **The layout
  under the map** (`.rp-pair`): above 760px the leaderboard on the left
  and, in `.rp-side` beside it, Latest Quests over Submissions; narrower,
  the three one under the other. Each section's rule sits 34px under
  what is above it (`.rp .section-heading` gives up the site's pull-up,
  which assumes a section's own margin), and both lists end with no
  hairline under their last row. The design was taken through a Fable
  critic, round by round at desktop and phone widths, to a 10, and then
  set back on the site's type sizes and keylines. **The leaderboard**
  (`.rp-board`) is every visible team's points
  at the replay's time from its `log` (`standingsAt`): best first, level
  teams sharing a place, the tab's medal discs for the first three and
  its place figures for the rest (`.rank-bullet`, `.rank-figure` from
  scs2-tab.css, which the page loads), an en dash for a team that did not
  finish or has nothing yet, the team's route colour as its disc or the
  hollow ink ring for a team with no route, every team up to fifteen and
  past that the top ten with **Show All N Teams**; a row that changes place glides there (measured, on
  `--duration-medium`, not under reduced motion), and nothing is redrawn
  while the order and the points stay the same. **Submissions**
  (`.rp-stats`) has two figures side by side at every width, Sent and
  Accepted, counted
  from the team-sent items up to the replay's time, and the site's bar
  chart (`scs.hourBars`, a bar a quarter hour of everything teams sent,
  the accepted part dark green) with the bars after the replay's time
  faded (`.is-ahead`), drawn again on a resize, on `scs-dates-changed`
  and after full screen. Items are put on the replay's day as they are
  read (`buildBoard`): an `edge` at its end of the day and a time outside
  it at the nearer end, and the day itself takes in everything sent up
  to three hours either side of the routes. Both sections move into the
  full-screen pane with the rest. A team's page has neither.
  A tap on a team's disc says what it was doing then (on the
  metro from Chatswood to Central, here from 11:02 to 11:40, or when its
  route starts or ends), and on a quest which it was and when it was
  sent, on the site's black sign. **The map takes gestures as the quest
  map does**: one finger moves it and two pinch it, and every wheel over
  it is the map's (MapLibre's `scrollZoom` is off and a capture listener
  on the map zooms instead, a copy of the quest map's: a trackpad pinch
  by what the fingers did, a mouse notch gliding out, a short coast when
  the input stops), except that a page scroll running on over the map
  stays the page's until the pointer rests there (300ms). There is no
  Ctrl prompt. **Full screen** (`.rp-full-btn` at the map's top right,
  the quest map's glyphs; `html.rp-map-full` and `.rp.is-full`): the
  card grows from its place to the screen (the quest map's measured
  morph, 320ms, none under reduced motion), the site's bars step aside,
  and the key, the controls, the team chips and Latest Quests move into
  `.rp-pane` and back again on the way out, in their order. On a phone
  (930px and under) the pane is a panel along the bottom: its bar holds
  the controls on one line (Play as its icon alone) and the map stops
  where it starts (`--rp-pane-h`, measured). **It moves as the quest
  map's search panel does**, with two stops rather than three: the bar,
  and half the screen or what the pane holds if that is less
  (`paneSizes`, `--rp-pane-bar`/`--rp-pane-open`), what does not fit
  scrolling inside. A finger anywhere on it but the slider over the day
  drags it 1:1, an asymptotic rubber band past either stop (the quest
  map's `rubberBand`, 40px over the top and 30 under the bar), and the
  release settles by the height projected from the flick (velocity
  times 160, capped) on the panel's own curve (280ms
  `cubic-bezier(0.26, 1.12, 0.3, 1)`); in the open pane a drag on the
  content scrolls it, and a pull down from its top takes the pane.
  The grab bar is the quest map's: flat at rest, an up arrow or a v
  while it moves, flat and stretching at the ends. A mouse drags the
  bar too and a click on it opens or closes the pane, the drag
  swallowing its click. Open, the pane holds a back layer of its own,
  so Back closes it first and full screen second; leaving full screen
  with it open waits for its pop (`scsBackLayer.after`) so no entry is
  left behind. While the map is moved by hand the pane goes to half
  opacity until it or a control over the map is touched (`is-faded`,
  the quest map's). Wider, it is the same pane stood up as a 400px
  column down the left, the map in the rest: the controls on the one
  line they take on a phone (play as a square, the time, the speeds,
  the slider under them) held at the top, and everything else
  scrolling under them in `.rp-pane-more`, with a hairline under the
  controls once it has scrolled (`is-scrolled`, both widths; on a
  phone only while the pane is open). 400 is what the one-line
  controls need. Going in or out of full screen re-lays the slider's
  hour marks for the width it now has (`layoutTicks`, which keys on
  both the spacing and the half-hour marks). Escape and the button close full screen too, and
  site-chrome.js leaves `.rp-pane` out of pull to refresh. The controls
  are wired as soon as the map exists rather than on its `load`, which
  waits for every tile.
  **On a team's page** the Route section (`#tm-route`, between the
  figures and Quests Done) shows the team's route alone, once the pulse
  says the replay is open and `/api/replay` says the team has a route
  (names compared in lower case, spaces collapsed), with its quests from
  the same answer. `tests/verify-recap.mjs` and `verify-tracks.mjs` hold
  the worker's half and `verify-recap.cjs` the pages, against stubbed
  routes and logs.
- **Live tab page** (`/tab/`): the board and nothing around it,
  10s self-refresh (the worker keeps its answer for 10s to match), FLIP row movement keyed by team name, retry button.
  **One read a refresh**: `readBoard` asks `/api/tab`, the leaderboard
  and the stats in one answer, with `cache: 'no-cache'`, so a board that
  has not changed comes back as a 304 with no body.
  The kept copy is `{lb, stats}` as before. **Only an answer newer than
  the one drawn is drawn or kept** (`readsAsked`/`readDrawn`): the
  interval, a return to the page, Retry and the first load each start a
  read that tries again on its own, and an older one landing late used
  to repaint over a newer one, frozen or closed included, and become the
  copy. A failed read says nothing once a newer one has answered, and
  nothing while the tab is closed (the sign is the copy). The
  after-the-event switches are read again with a fresh pulse every
  minute while the page is on screen (`scs.pulse(true)`), and from any
  pulse the chrome fetches (the `scs-pulse` event), so a tab left open
  sees them go on.
  Six columns — place, team, points, behind, quests, last scored — and
  the totals as the table's own `tfoot` under the columns they sum
  (`#tab-teams`/`#tab-points`/`#tab-completions`, still driven by
  `scs.digits`), so a figure is read against its column instead of in a
  band of stat cards above it. **Behind is worked out on the page**
  (the leader's points less the row's, the leader's printed as the 0 it
  is); **last scored comes off `/api/leaderboard`'s `last_quest`** and
  reads time, `span.code` chip, quest name — a team with nothing scored
  gets an empty cell. The top three wear gold, silver and bronze
  `.rank-bullet` discs (`--medal-1/2/3` in scs2-tab.css, the same fills
  in both themes because a medal is not a route and does not change
  colour with the room); every other rank is the figure in a
  `.rank-figure` box the disc's width, so every place sits on the same
  centre line as the medal digits rather than on the discs' right edge.
  **A team that did not finish** (a row with `dnf: true` and `rank:
  null`; `tab/CLAUDE.md` has the worker's side) keeps its row in score
  order with an en dash in the `.rank-figure` box, never a medal, even
  at the top of the board; its points carry a `*` (`.tab-dnf-mark`,
  hung in the cell's padding so the figures keep the column's edge,
  inline on a phone where the points are the last column and have no
  padding); its Behind is empty (`tr.is-dnf` also hides the phone's
  minus), and the leader every Behind is measured from is first place,
  not the top row. `#tab-dnf`, "* Did not finish." under the table, shows
  while any row is marked and goes with the board when the tab is
  closed. The waiting line under the table
  (`#tab-waiting`) is `/api/stats`'s `submissions_pending`, hidden at
  zero and when a kept copy predates the field; a drawn info mark
  (`.tab-waiting-mark`) sits before it, on the first line's cap height
  in a two-column grid so the sentence wraps under the words rather
  than under the icon — an SVG rather than a character, so it keeps its
  weight at every stop on the text-size ladder and in both themes.
  The last-scored time comes from `scs.fmtTime` now rather than this
  page's own copy of the rule, so the settings menu's Hide dates rocker
  reaches it (`assets/CLAUDE.md`); `lastPaint` is what lets the page
  redraw when that rocker is flipped between two 30-second refreshes.
  **Below 840px there are two views** (`.tab-view`, Compact and Full on
  the Updated line, kept in localStorage `scs2-tab-view`), 840 being
  where every page drops to the one 36rem column: at 760 a narrow
  desktop window put six columns in that column and Last scored came
  down a letter a line. Above it, a quest name in Last scored that
  cannot keep 9em beside its code takes a line of its own under them
  (`flex-wrap`, `.tab-last-name`'s basis). Compact is one
  line a team — place, name, quests, points — so forty teams fit on two
  screens, a long name taking a second line before it is cut; Full
  adds one line under the name with last scored (never wrapping) and
  the gap to the leader as a minus
  figure under the points, the leader's own left blank. Both are the
  table's own rows as a four-column grid (`display: block` on the table
  and its row groups — a row that is a grid is no longer a table row,
  and a table left to size itself around one hangs off the side of the
  phone; the `role` attributes keep it a table to a screen reader). The
  Updated line sits one `--after-title` from the top and one from the
  table, says "just now" for the first three seconds after a refresh
  lands and counts up from there; while frozen it is the "Standings as
  of" line instead (`tab/CLAUDE.md`, Freezing the tab). **Closed**, the
  worker answers `{closed: true}` and the page puts `html.tab-closed`
  on: the bar row, the table card and the waiting line go, a black sign
  (`.tab-closed-sign`, the 404's plate) says the tab is closed, and the
    closed answer becomes the kept copy, so a later visit opens on the
  sign rather than on standings from before it closed.
  **A refresh that brings the same answer leaves the page alone**
  (`lastDrawn` in `paintTab`, forced by the Hide dates rocker, which
  changes the drawing and not the data). While frozen every answer is
  the same, and rebuilding the rows every ten seconds under the frost's
  backdrop blur made the text flash sharp each time, which read as the
  page reloading and the freeze resetting. `verify-live-tab.cjs` counts
  the DOM changes a frozen refresh makes and wants none.
  `.tab-table-card` scrolls sideways only (`overflow-y: hidden` — with
  `overflow-x: auto` alone the vertical axis computed to auto too, and
  the FLIP transforms gave it overflow to drag into by hand).
  The loading skeleton is a real table of the same shape: ranks 1-10
  printed, grey bars for names and numbers, one all-bar row for the
  unknown rest, and the totals row under them.
  **The unreachable tab says which of two things happened**: with a
  board on screen, the refresh failed and these are the copy this
  device kept (the hero's second bar says how old it is); with nothing
  kept, there are no standings yet — and then the skeleton hands over
  rather than pulsing at a table that is not coming, and `#tab-table`
  keeps `is-empty` so the totals row is not a line of dashes under a
  rule hard against the head's.
  Season 1 tab is untouched but hidden from menus by default
  (`scs2-hide-s1` — hidden unless `'0'`; settings toggle restores it).
  `tab/tests/verify-live-tab.cjs` drives all of it against a stubbed
  API at 1280 and 390, in both themes, with and without a kept copy.
