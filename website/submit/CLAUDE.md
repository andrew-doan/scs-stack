# The submit page

Sending proof in: the answer box a quest asks for and naming a file
before it goes up. The worker side of submissions — sessions, big
uploads, thumbnails, renditions, the gallery — is in `tab/CLAUDE.md`.
The compressor is a page of its own, `website/compress/CLAUDE.md`.

- **The way to the compressor**: a line under the composer's file field
  (`.sub-compress-link`, "Compress a large video before sending it."), the nudge on a file
  row over 500MB, and, signed out, a line under the sign-in card
  (`.sub-compress-alt`), for somebody who came to compress and has no
  submit code. A script in the head sends `/submit/#compress`, where the
  compressor used to be a view of this page, on to `/compress/` before
  anything draws. An upload in progress writes its share into the tab's
  title (`scs-run` with `which: 'send'`).
- **The design rounds** (a critic scored the signed-in page 6, 7, 8,
  9 and 10 out of 10 over four rounds): the browser's file control is
  hidden in the site's keyline button (`.sub-files-btn`, a label with
  the input in it), under the field's name and the files already listed
  — "Choose files", then "Add more", and "Choose another" for a quest
  that takes one file — and a pick adds to the list, leaving out a file
  listed already, where it used to replace it; a quest that takes one
  file still replaces. The quest box is hidden while a quest is picked
  (the claim under it is the answer) and change brings it back with
  focus. The claim is a grid, chip, name and change in a row, and on a
  phone the chip and change on one row with the name under them; it
  carries `--sign-edge`. The pick box's results take no room while
  empty. A sent row is three lines: chip, verdict and time, centred;
  then what was claimed and what was said (`.sub-notes`, across the
  row: a rejection's reason in red with no "Rejected:" before it, an
  organiser's line in the text colour over its reason, the queued line,
  part marks); then the photos with the gallery switch beside them,
  named "Gallery". A row with no files (`no-files`) drops those two
  cells. A link in a sentence is drawn as Sign out is, the text's
  weight and colour over a 2px rule. After the rounds the page took the
  site's standard section heading back, rule and all: it had been the
  one page without, for a Submit/Compress row that no longer exists.
- **The page's shape**: the h1 on the paper, then "Sending as <team> ·
  Sign out" (`.sub-who`), then the composer and what has already gone as
  two columns of the shared twelve-column `.band`, one column with the
  composer first under 900px. **About** and **Next Steps After Submission**
  (`.sub-info`, the committee's own wording) sit at the foot of the
  signed-in page only (inside `#sub-main`; the sign-in page is the card
  and nothing else), side by side on a wide screen and stacked with 40px
  between them under 900px. Next Steps is a
  plain nested list; it was numbered 01–04 and the numbering went. The
  empty error line under the sign-in button takes no room (`:empty`). The
  quest's own claim (`#sub-quest-picked`) stays on the line under the
  picker. The submissions list is a three-storey row at every width and
  the score sheet under 560px, because five facts and three do not fit
  one line on a phone; both are still `table.nice` markup, restyled as
  grids, so nothing that reads a row by cell index breaks.
- **Saving or sharing a sent file**: the viewer opened from a sent
  file's thumbnail has Download (the whole file, metadata cut, `download=1`)
  and Share: a photo's named public path, which Discord shows as the
  picture, or a video's `/view/` page with the player on it. A video
  plays through `assets/video-sizes.js`, with Auto and a menu of its
  sizes, and gets neither Download nor Share until the encoder has been
  through it. Written up with the lightbox in `tab/CLAUDE.md`.
- **Straight to R2** (worker side in `tab/CLAUDE.md`, Straight to R2).
  `loadMode()` asks `upload/mode` when a team is signed in; with
  `direct` true every file goes as a manifest (`whole=1`) and follows
  the create as slices, each sent by `putDirect` to the address
  `upload/sign` hands back, with nothing but the bytes on the request.
  The resume entries carry `direct`, and `upload/status` says it again.
  Without it the page sends as it always did, so nothing changes until
  the worker has the R2 secrets. **The create's 90MB counts the
  previews too** (`previewBytes`: at most 300KB of small copy a file and
  2MB of viewing copy a photo): Cloudflare refuses a request over 100MB
  before the worker sees it, and twenty files under the cap with their
  previews could pass that, which the page then reported as a dropped
  connection on every try. A send that could go past it sends `whole`
  instead, every file as a manifest, which the worker takes through its
  own slices when it has no R2 secrets; that replaced the refusal to
  send more than 90MB in one submission. The messages about an upload say "a
  file" rather than "a large file", since in direct mode a photo goes
  that way too. The album page does the same (`direct`, `where(n)` in
  `sendSlices`).
- **A send past the team's review cap is queued, not refused** (the
  worker's side is in `tab/CLAUDE.md`, Past the review cap). The create
  answers `queued: true`; the status line under Send then says the tab
  has it and it goes to review once fewer of the team's submissions are
  waiting, drawn in the glow box (`.sub-status.is-queued`, `--glow-fill`
  inside a `--glow-edge` border) so it does not read as a failed send.
  `setStatus(text, queued)` sets and clears that class, so every other
  line on it is plain. In Already sent a queued row has a `queued` pill
  in the same glow and a muted line under it, "The tab has it. It goes
  to review once fewer of yours are waiting."; the score sheet's line
  adds "and N queued behind them". A row turns into an ordinary pending
  one the next time the list is read after a place frees.
- **A deleted submission** stays in Already sent with a grey `deleted`
  pill and the reviewer's note under it ("Deleted: …", `.sub-reason.is-note`,
  muted where a rejection's reason is red) and no gallery switch. The
  worker side is in `tab/CLAUDE.md`, Deleting a submission.
- **Points an organiser recorded** are in Already sent too (`mine`'s
  `organiser`), with a muted note under the status: "Added by an
  organiser", "Points taken off by an organiser", or "Added by an
  organiser and taken back" once it is deleted. One with no photos has
  an empty count and no gallery switch. Which organiser is never said.
- **Part marks** (worker side in `tab/CLAUDE.md`, Part marks): an
  accepted row given part of its points has "Part marks: 28 of 50
  points" under the status (`mine`'s `part`), and the score sheet's
  Scored reads "28 of 50" for an amount under one. On a mystery quest
  the worker leaves the points out, so the row says "Part marks: 28
  points" and the sheet says "Part marks". A tiered or counted code's
  line has no points either, and says so in its `scoring`: its Scored is
  what it came to (`worth`), never "Part marks".
- **Already sent is the newest 100** (`mine`'s `more`), and the line
  under the table says "Showing the newest 100." when there are older
  ones.
- **A video the encoder gave up on** (`media[].skipped`) opens in the
  viewer as its still with "This video cannot be played here." rather
  than the processing line; the recap's quest page and the gallery's
  fallback view pass the flag on the same way (`processingView` in
  site-viewer.js).
- **The quest picker** (`#sub-quest-matches`, `renderMatches` /
  `closeMatches`): one box with a list of quests in it — the code chip,
  the name, a hairline between rows — under the box that filters it.
  Every match is in it, best first, and past a screen's worth it
  scrolls. It was a bordered button per row, which drew an edge round
  every quest and made a search for two letters read as a pile of cards
  rather than a list; the fullscreen map's search panel already lists
  the same quests as rows, and this is that. It is in the flow and
  carries no shadow: it is part of the form, not something opened over
  it. Escape, a tap outside `.sub-pick` and Enter on the best match all
  work, and a mouse press inside it is preventDefaulted so the caret
  stays in the box.
- **Several questions** (`questions` on the group, see
  `questlist/CLAUDE.md`): `renderAnswerBox` draws one box per question,
  each in a `.sub-q` when there is more than one, and every one is
  required. The answer goes up as the first question's `{kind, value}`
  with the rest in `more`, in order, each carrying its `prompt`, so the
  worker keeps what was asked beside what was said; a quest with one
  question sends exactly what it always did. **Multiple choice**
  (`choice`) is a fieldset of radio inputs drawn as tiles
  (`.sub-choice-opt`), the picked one in the sign's black like the
  compressor's tiles, with the input kept focusable for the keyboard.
  Already sent shows every answer joined with a middle dot.
- **Answer boxes**: a group's `submit` kind drives the submit page —
  count (a number box with a minus and a plus either side, `stepper()`;
  the box is still `input[type=number]` and the label names it by
  `for`, since a label wrapping several controls belongs to the first,
  which would be the minus), text (line), pick (filter over the expanded
  options, chosen ones as chips; at `MAX_PICKS`, 60, the filter shows a
  line saying one submission takes at most 60 instead of more matches,
  since the worker refuses a longer list rather than cutting it), codes
  (a rocker per code). The
  answer posts as an `answer` form field, JSON `{kind, value}`,
  cleaned by `cleanAnswer` in submit.ts and stored on the row; the
  console review shows it and pre-ticks `codes`, and accept credits
  every ticked code of the same group. The submit page sends the
  group's first code as `quest`.
- **What a quest takes** (worker side in `tab/CLAUDE.md`, What a quest
  takes): the quest list's `rules.files` drives the file field
  (`renderFileField`): the picker's `accept`, how many files are kept,
  the label ("Photos or GPX tracks — up to 6", "(optional)" when none is
  needed), and no field, compress line or gallery switch where they do
  not apply. `filesProblem` refuses at Send in the worker's words; with
  no quest picked, or a list without rules, the page sets no limit and
  the worker decides. A GPX or PDF in Already sent is named
  (`.sub-thumb-doc`), never linked, since nothing public serves it; the
  gallery switch shows only on rows with a photo or video.
- **A challenge's count** (`#sub-tally`, `loadTally`/`renderTally`; the
  worker's side is Challenges in `tab/CLAUDE.md`): under a quest that is
  a challenge, "Your count: N · M waiting on review" and, for places
  picked, "So far: …", from `GET /api/submit/tally`. A send clears the
  pick but keeps the line (`clearPick(keepTally)`) and refreshes it, adding
  the quest's code so it still says which quest it is about. While the
  tab is frozen or closed it says counts are hidden, as the score sheet
  does.
- **Renaming files before they go up**: everywhere a file is picked
  for upload it sits in a row with its name in a text box and the
  extension fixed after it (`splitName` → `{base, ext}`; the sent
  name is the typed base, stripped of `\/:*?"<>|`, or the original
  base when emptied, plus the extension). Submit page: `names[]`
  beside `files[]`, `fileName(i)`, sent as the multipart filename for
  inline files, as `name` in the `bigfiles` manifest and into the
  resume entry (`rememberUpload(u, name)`); `.sub-file-rename` /
  `.sub-file-ext`. Dashboard: `renameRow(file, names, i, onRemove)`
  builds `.file-row` rows; message attachments (`msgFiles` +
  `msgNames`, `#msg-files-list` is rows now) and quest files, which
  no longer upload on pick — they wait in `.qg-waiting` rows under an
  "Upload N files" button (`pending`/`pendingNames`, `sendWaiting`).
  The workers read the multipart filename, so nothing changed there.
  `verify-submit-page.cjs`, `verify-console-ui.cjs` and
  `verify-ask.cjs` check the typed name reaches the request.
- **What is going up right now** (`#sub-uploads`, built in
  `index.html`, driven from submit.js): the one place a large upload
  reports itself. It used to be a line of status text beside the Send
  button, which said nothing about what was in flight — so after the
  page had been closed and reopened, choosing the file again looked
  like it had done nothing and the empty quest picker looked like the
  thing to fix. The box carries a row per file: the quest as a signage
  chip, the file name, a bar, and `Slice 4 of 12 · 80 MB of 240 MB`. A
  send over `DETAIL_BYTES` (5MB) gets a row too, counting the request's
  own bytes. While it runs, the share of the whole job goes in
  `document.title`, which is the only thing a backgrounded page can
  say. Finished, the title changes and the warning goes; the light
  (`--glow-fill` on `::before`, the quest sheet's treatment) turns down
  rather than off, and `.is-settled` is what does that. `runUploads`
  owns all of it; `uploadBig`'s `onSlice` fires for slices already on
  the worker too, so a resumed file's bar starts where it left off.
  **Send comes back once the create has answered**, so a team can send
  another quest while a large file's slices are still going, and a
  resumed file can join them: the box is cleared only when nothing in it
  is running, settles when the last run ends, and the title carries the
  share of every run still going (`upRuns`). Two runs once emptied each
  other's rows, and the first to end said nothing was uploading.
  **A file being sent is claimed** (`scs2-submit-claims`, file id to a
  stamp renewed every slice and every 20 seconds, given up at the end and
  on `pagehide`, stale after three minutes), so another tab does not
  offer it as broken off and send the same slices twice.
  **`setStatus` writes the line plainly**, not through `scs.swapText`:
  it changes several times through a send and once per file through an
  upload, and a blurred fade on each one read as the page doing
  something rather than as it reporting. The sign-in card still swaps
  and shakes — that is one change, at the moment it matters.
- **The quest rides with the upload**: `rememberUpload(u, name, quest)`
  stores it, and `GET /api/submit/upload/status` answers `name` and
  `quest` as well, so an entry written by an older build is repaired on
  the next read rather than showing a file with no idea what it is
  proof of. The resume rows carry the chip and say outright that the
  form does not need filling in again — that was the whole confusion.
  `checkResume` asks through `scs.fetch` (each try has a time limit) and
  reads the stored list again before writing it, changing only the
  entries it asked about, so one added by a send meanwhile is kept.
  **Each entry names its team** (`team`, the name in
  `scs2-submit-team`), and only the signed-in team's are asked about: on
  a shared phone another team's waits for that team, where it used to
  get a 404 and be deleted. A 404 on the team's own entry drops it, as
  does `done`; anything else (a 401, a 5xx such as the 502 when storage
  cannot be reached, no answer at all) keeps it. **An entry from before
  entries named a team** is asked about once by each team signed in: a
  200 makes it this team's (the worker answers only for the team's own
  file) and a `done` drops it, but a 404 may be another team's file, so
  it is kept and the team goes on its `not` list, and is not asked
  again by that team.
- **A finish turned down for good** (a 4xx other than 409 and 429:
  the worker found the bytes were not the type they claimed and deleted
  the row, or the row is gone) is shown in the worker's own words, on
  the file's row and the status line, and its resume entry goes; the
  queue moves on to the next file. A 409 can be slices still missing, so
  it is treated as broken off, like a dropped connection, and the entry
  stays to resume.
- **The copies the browser makes** are canvas redraws, which is why
  they carry no metadata: the picture is decoded to pixels and written
  out fresh. The 1920px viewing copy is now sent whenever it fits
  under 2MB rather than only when it is clearly lighter than the
  original — a small photo used to send none, and a request for a
  smaller size then fell through to the file the camera wrote. The
  worker's side of all this is in `tab/CLAUDE.md` under
  **Metadata, and who gets to see it**.
- **HEIC and WebP are converted to JPEG as they are picked**
  (`convertPicked` in submit.js, through `scs.toJpeg`; see
  `assets/CLAUDE.md`), with the photo's EXIF copied into the JPEG so
  Review can still say where it was taken. The status line says what
  is being converted, a send while it is still going is refused with a
  line saying to wait, and a file that will not convert goes up as it
  is with a line saying so. `pickRound` makes a second pick made
  mid-conversion win over the first. The JPEG carries the file it was
  made from as `.picked`, which goes up beside it: `picked<i>` in the
  create while the request has room under 90MB, `bigpicked<k>` with a
  manifest whose slices come through the worker, and, whenever every
  file goes as a manifest (`whole`), named in the manifest as well, so a
  worker that sends the slices straight to R2 has it sent by `putTwin`
  after the last slice, before the finish. A resumed upload has no such file to
  send and finishes without it. The page never offers it back: the
  viewer's Download is the cut copy, since that is what a team gets of
  its own proof, and the original is for the dashboard.
  `verify-submit-page.cjs` checks a WebP goes up as a JPEG with
  `picked0` beside it under its own type.
