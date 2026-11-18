# The dashboard

The dashboard is where organisers run the day: scoring, review, quests,
teams, messages, sign-ups and Discord. The tab worker serves it at
`/dash`, normally on `dashboard.scs.andyrew.space`. `/console` redirects
there for old bookmarks. `/dash/spinner` is a separate page, a wheel of
the teams on the board, signed in with the same session. Every action
is a call to `/api/console/*`; the
actions and their permissions are listed in [api.md](api.md#dashboard-actions).

## Signing in

- **Every account is made by an admin** on the Accounts tab: a name, a
  password of its own (ten characters or more), the tabs it may use or
  admin, the quests it may score if not all of them, and whether it
  needs a six-digit code from an authenticator app.
- An account that needs a code sets it up at its first sign-in. It is
  then shown ten backup codes, each usable once, for a lost phone.
- A session lasts 18 hours.
- The shared `CONSOLE_PASSWORD` does two things only: the first sign-in
  on an empty database makes an admin with it, and an account from
  before admins made them (no password of its own) still signs in with
  it until an admin gives it one.
- Failed attempts are throttled per address, never for the whole
  worker: three failures are free, then the wait doubles from five
  seconds up to fifteen minutes. Cloudflare's human check (Turnstile) is
  asked for only after an address has been refused something.
- Every attempt is recorded in `console_attempts` and shown on the
  Accounts tab.

## The tabs

The tab bar shows only the tabs the account may use. The permission
keys are older than some of the tab names: the Queue is `review`, the
Desk is `points`, and Recap opens with `scores`.

| Tab | Permission | What organisers do there |
|---|---|---|
| Scores | `scores` | The day board. The public tab card: freeze or close the tab, copy the standings as a picture, export the tab as CSV, the cutoff for the Last scored column, saved copies of the standings. The ledger check. |
| Recap | `scores` | Every leaderboard (points, quests done, photo to submission, boards counted from a challenge) and what the after-the-event recap shows. |
| Queue | `review` | Review submissions: accept, reject with a reason, change, send back, delete, add files. Narrow by quest or team. Shows who else is looking at a card. The video encoders card is at the foot. |
| Desk | `points` or `scores` to record; `review` to read | One quest at a time: record a result for a team, the teams holding it, a challenge's standings and its award, a live question's answers and a wager's settlement. |
| Ledger | `review`, `points` or `scores` | One team's statement: every line by quest, undo and put back, adjust the team's points with a reason, copy it as a picture. |
| Map | `map` | Where each team last sent something from, and when. |
| Routes | `routes` | The route each team recorded for the GPS quest: clean a GPX file in the browser, cut the day to a time range or leave stretches out, check it on a map, save it for the replay. |
| Quests | `quests` | The quest list by region: add, edit, order, regions and their colours, tags, who can see each quest, open everything now, polls and wagers, import and export. |
| Teams | `teams` | Add, rename, hide (test teams), mark did not finish, delete. Submit codes. Team groups. |
| Messages | `messages` | Write, schedule, order and archive announcements, with attachments, an audience and an urgency. Adding a push to one also needs `push`. |
| Push | `push` | Send a notification to everyone, a team or one device. The device list. |
| Email | `email` | Email announcements to everyone signed up, one team, or typed addresses. Test, send, stop, retry. Says so when email is stopped in Settings. |
| Rego | `rego` | The sign-ups: teams and people, edit, move, delete, resend a confirmation, make a check-in code, mark a test signup, export CSV, resync the Google Sheet. |
| Files | `files` | Files with public links (the drop), short links, and albums. |
| Discord | `discord` | Hold posts, server by server. Servers and their roles. Set up team roles and channels. Send submit codes. Send a message. Role menus. Register the commands. |
| Settings | `settings` | Things set once: sign-ups and their limits, the submission limit, the EOI, the home page countdown and slideshow, the after-the-event switches, stopping every email and the email test, storage, and tools (export everything, tidy photo storage, version counters). Admins also get Personal data (take the sign-ups' emails, zIDs and dietary needs off both databases into a file, and put them back from it) and Original videos (download the proof videos as teams sent them, then delete the originals). |
| Accounts | admin only | Accounts, the second-password switches, sign-in attempts. |
| Log | `log` | Every change, with who made it. |

An account limited to some quests (`console_users.quests`; admins ignore
it) records, reviews and adjusts only those quests' codes, and runs,
reads and settles only their questions and wagers; anything outside
them is refused with `no_access`. An empty list is every quest, so the
worker takes one only with `all_quests` (the editor's Every quest). A
quest deleted comes out of every list, and one that is an account's
only quest is not deleted until that account has another. An account
with only the Desk permission and one quest is the one for the people
out at a main quest: it lands on that quest's desk.

## Permissions

`tab/src/dash-access.ts` is the source of truth.

- `PERMS` lists the permission keys, one per tab: `scores`, `points`,
  `review`, `map`, `routes`, `quests`, `teams`, `messages`, `push`, `email`,
  `rego`, `files`, `discord`, `settings`, `log`. An admin has all of
  them and the Accounts tab.
- `allowed()` looks the action up in `EXACT` (method and path), then by
  prefix in `PREFIX`. Some actions are open to several tabs; a handful
  (`GET overview`, `GET me`, `GET quests`, `GET spinner`,
  `POST auth/backup`) are open to any account.
- **An action in neither table is admin only.** A new endpoint is
  closed until it is given a tab there.
- The worker checks this on every request. A refusal is 403 with
  `no_access`. The page leaves out what the account cannot use, but
  that is only a convenience.

## The second password

Some actions also ask for a second password, held by the worker as
`PUSH_PASSWORD`. An admin chooses which on the Accounts tab; the
choices are kept in `site_flags` as `guard_<key>`. The page sends it in
the `x-second-password` header. A ticked action is locked while the
worker has no `PUSH_PASSWORD`.

| Switch | Covers | On by default |
|---|---|---|
| `push` | sending a push notification | yes |
| `email` | sending an email announcement | no |
| `freeze` | freezing, unfreezing, closing or opening the tab | no |
| `open-all` | opening every quest at once | no |
| `retire` | retiring every quest | no |
| `delete-quest` | deleting a quest | no |
| `delete-team` | deleting a team | no |
| `delete-submission` | deleting a submission | no |
| `adjust` | adjusting a team's points, or undoing an award or balance line | no |
| `award` | awarding or undoing a challenge, a wager or the EOI | no |
| `delete-signup` | deleting a person from the sign-ups | no |
| `move-signup` | moving a person to another team | no |
| `discord-delete` | deleting Discord roles and channels | no |
| `discord-codes` | sending submit codes in Discord | no |
| `export` | exporting everything | no |
| `privacy` | downloading, removing or putting back personal data | no |
| `originals` | deleting original videos | no |
| `accounts` | changing an account | no |

Changing a switch asks for the second password itself whenever the
worker has one. An action the page sends as a run of requests (the
submit codes, deleting leftover roles and channels or original videos)
asks once and uses what was typed for the rest of the run.

## How the page is built

The page is plain files in `tab/src/dash/`: `dash.html` (the body),
`dash.css`, and the script as 33 files in `tab/src/dash/js/`.
`consolePage()` in `tab/src/console-page.js` joins them into one HTML
response with the styles and the script inline. The worker fills in two
`body` attributes, `data-turnstile` and `data-files`, and nothing else.

The script files load in this order:

1. Shared files: `core.js` (the session, `api` and `post`, toasts,
   element helpers, times, `can` and `canTab`, `state`), `markdown.js`,
   `uploads.js`, `preview.js`, `share.js`, `parts.js` (the answer boxes
   and scoring inputs) and `tabs.js` (the tab bar, which tab is open,
   access, `refresh`).
2. `signin.js`.
3. A file per tab, in the tab bar's order: `scores`, `recap`, `queue`,
   `desk`, `ledger`, `map`, `tracks` (the Routes tab), `quests` with `quest-order`, `quest-editor`
   and `asks`, `teams`, `messages`, `push`, `email`, `rego`, `drop` and
   `albums` (the Files tab), `discord` and `rolemenus`, `settings` with
   `storage` and `slides`, `accounts`, `log`.
4. `start.js`, which opens the page signed in or at the sign-in form.

Each file is one function, `(function (dash) { … })(window.dash)`.
`core.js` makes `window.dash`, and nothing else of the page's goes on
`window`. A file puts what other files need on `dash` and copies what
it uses from the shared files into local variables at its top. A tab's
code goes in its own file; something two tabs draw goes in a shared
file. They are classic scripts, written to the same ES5 rule as the
site. Every name on `dash` and every field of `dash.state` is declared
in `tab/types/dash.d.ts`, which `npm run typecheck` holds the parts to.

**The order is written twice**: `JS` in `tab/src/dash/files.js`, which
wrangler bundles as text modules (the `[[rules]]` block in
`tab/wrangler.toml`), and `tab/src/dash/files-node.js`, which the Node
test suites read from disk. A new file needs an import and a place in
both lists. `verify-console.mjs` checks the two lists agree with each
other and the folder, and `verify-dash-bundle.mjs` builds the deploy
bundle and compares its page with the Node one byte for byte.

The dashboard loads a few things from the site at `https://scs.andyrew.space`
(`dash.SITE`): MapLibre and the transport lines for the Map and Routes
tabs, the GPX cleaner (`tab/replay/track-clean.js`) for the Routes
tab, `share-image.js` for pictures, `video-sizes.js` for video previews.
`netlify.toml` sends CORS headers on the map files, the icons and the
fonts so the dashboard may read them from another origin.

## Where to read more

- [`tab/CLAUDE.md`](../tab/CLAUDE.md): "Signing in to the dashboard",
  "What an account may do is checked on every request", "The second
  password", "The page is plain files in `src/dash/`", "The script's
  parts", "How the worker gets them" and "Where things go, so it does
  not drift back into a mess"; the Queue, Desk, Ledger, Recap and Map
  tabs each have their own paragraph.
- [`tab/README.md`](../tab/README.md#the-dashboard): the dashboard from
  an organiser's side.
