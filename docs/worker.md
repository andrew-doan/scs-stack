# The tab worker

`tab/` is one Cloudflare Worker, `scs-tab-bot`. It serves the public API
the site reads, team submissions, push, registration, the dashboard and
its API, the Discord slash commands, and the encoder's API. Scores live
in the D1 database `scs-scores`; files live in the R2 bucket
`scs-submissions`.

## The code

- **TypeScript in erasable syntax only** (`tab/src/*.ts`). Node runs the
  test suites on the source and wrangler bundles it, so there is no
  build step. `npm run typecheck` runs `tsc` under `strict` with nothing
  emitted, in about a second.
- The dashboard's page files (`tab/src/dash/`, `console-page.js`) and
  the vendored QR encoder (`tab/src/vendor/qrcode.js`) stay JavaScript.
  The dashboard's script parts and spinner are checked as JavaScript
  (`tsconfig.dash.json`, against `tab/types/dash.d.ts`); the rest are
  not type checked.
- `src/shared.ts` holds every helper more than one module uses.
  Modules import from it rather than writing their own.
- `src/types.ts` holds the shapes that cross a boundary: `Env`, one
  interface per table, request bodies and public payloads.
- Writes of more than one row go through `env.DB.batch`, which runs as
  one transaction.

## How a request is routed

`fetch` in `src/index.ts` wraps everything: an unhandled error becomes a
JSON 500. On a dashboard path, or when the cause is a missing table or
column, the answer names the cause (and tells you to run
`npm run db:migrate`). On a public path it says only that something went
wrong, with a reference that the worker's log carries.

`route` then tries, in order:

1. `OPTIONS` preflight (open CORS).
2. Short links, when the hostname is `SHORT_HOST` (`drop.ts`).
3. Dropped files at `/api/drop/drop/<key>/<name>`.
4. The dashboard page (`/dash`, `/dash/spinner`, `/console` redirect)
   and its API, `/api/console/*` (`console.ts`).
5. A challenge's count and standings (`tally.ts`).
6. Team submissions, `/api/submit/*` (`submit.ts`).
7. The encoder, `/api/encoder/*` (`submit.ts`).
8. Push subscriptions, `/api/push/*` (`push.ts`).
9. Registration, terms and ticket images (`rego.ts`).
10. The quest list, quest files and live questions (`quests.ts`).
11. Message attachments (`messages.ts`), slideshow pictures
    (`slides.ts`), albums and the file pages (`albums.ts`), Discord
    link previews (`embed.ts`), team pages and the recap (`recap.ts`).
12. Any other `GET /api/...` is a public read built by `apiResponse`
    and kept in the edge cache.
13. `POST /api/team-checkin` from the check-in worker.
14. Anything else posted is a Discord interaction: the signature is
    checked, then the command runs.

## Modules

| Module | Owns |
|---|---|
| `index.ts` | routing, Discord interactions, the public reads (`apiResponse`, `livePayload`), the edge cache and its purge, check-in reports, the scheduled run's entry |
| `shared.ts` | responses, input cleaning, secrets (`configured`, `secretMatches`), random keys, R2 streaming, time stamps, settings kept in `site_flags` |
| `types.ts`, `globals.d.ts` | types only |
| `console.ts` | the dashboard API's router and most of its actions: sign-in, overview, teams, review, codes, the freeze controls, settings, accounts, the full export |
| `console-page.js` | puts the dashboard page together from `src/dash/` |
| `dash-access.ts` | who may do what, the second password, account password hashing |
| `totp.ts` | authenticator codes, backup codes and the enrolment QR |
| `tab.ts` | the standings (how teams rank), number formatting, the tab as CSV |
| `ledger.ts` | the ledger: writing, voiding and re-scoring lines; the hourly check |
| `parts.ts` | what each code of a quest scores: fixed, per unit, judged, tiered, counted |
| `points.ts` | points an organiser records, and adjusting or undoing a team's lines |
| `tally.ts` | challenges: counting across a team's submissions, standings, awarding places |
| `rules.ts` | what a quest's submit form takes and how a challenge is counted |
| `access.ts` | who can see a quest |
| `quests.ts` | quests, codes, regions, tags, team groups, import and export, `/api/questlist`, quest files, live questions, opening on time |
| `submit.ts` | team sign-in, submissions, proof files and slices, the score sheet, the gallery, the review cap, the encoder's API |
| `r2direct.ts` | signed URLs for uploads straight to R2 |
| `staged.ts` | the dashboard's own uploads straight to R2 |
| `strip.ts` | photo metadata: taking it out of what the public sees, reading it for organisers, checking file types |
| `photoserve.ts` | photos served with their metadata cut out as they stream |
| `videostrip.ts` | videos the encoder has not reached, with their metadata blanked |
| `sharepage.ts` | the worker's own file pages, `/view/` and `/photo/` |
| `track.ts` | GPX tracks read for the review card |
| `albums.ts` | albums: the public list and uploads, the dashboard's album actions, the file pages' routes |
| `zip.ts` | an album as a ZIP, streamed |
| `messages.ts` | organiser messages and attachments, scheduled publishing, the counters, `/api/pulse` and `/api/messages` |
| `push.ts`, `webpush.ts` | push subscriptions, sending and the outbox; the Web Push protocol on WebCrypto |
| `announce.ts` | email announcements and their send queue |
| `email.ts`, `email-html.ts` | sending email (Cloudflare's binding, Resend as a fallback); what an email looks like |
| `rego.ts` | registration, the sign-up guard, confirmation emails, terms, syncing with the check-in worker, the Google Sheet, the Rego tab |
| `eoi.ts` | expressions of interest and the points they give |
| `discord.ts` | Discord's REST side: servers, the organiser guard, `/verify`, team roles and channels, posts, holding posts, the Discord tab |
| `rolemenus.ts` | role menus members pick roles from |
| `commands.ts` | the slash command definitions (`scripts/register.mjs` sends them to Discord) |
| `embed.ts` | how a link to a site page looks in Discord (`/api/embed/*`) |
| `freeze.ts` | freezing and closing the tab, saved copies of the standings |
| `recap.ts` | after the event: team pages, the recap, the replay's reads, their switches |
| `tracks.ts` | the routes teams recorded: the Routes tab's actions and what the replay reads |
| `countdown.ts`, `slides.ts` | the home page's countdown and slideshow |
| `drop.ts` | files with public links, and short links |
| `storage.ts` | the Settings tab's Storage card |
| `schedule.ts` | the once-a-minute run |
| `team-map.ts` | the dashboard's Map tab |
| `data/` | the SCS.2 quest list the dashboard imports, and the station lists |

## The scheduled run

`[triggers] crons` in `tab/wrangler.toml` runs `scheduled` once a minute.
Each job runs on its own, so one failing does not stop the others, and
a minute with nothing to do writes nothing to the log.

1. Publish messages whose time has come.
2. Open quests whose opening time has come.
3. Move queued submissions into the review places that have freed up.
4. Send the next batch of a push announcement.
5. Send the next batch of an email announcement, unless email is
   stopped in Settings.
6. Retry ticket emails that failed or were held while email was
   stopped (nothing while it still is).
7. Save an hourly copy of the standings, when they have moved.
8. Check the ledger, once an hour.
9. Delete dashboard uploads left unsaved for a day.

The site's own polling of `/api/pulse` and `/api/messages` also
publishes due messages, so a message goes up as soon as anyone loads a
page.

## Configuration

`tab/wrangler.toml` holds what is the same for every deployment:

- `[vars]`: `VAPID_SUBJECT`, `EMAIL_FROM`, `EMAIL_REPLY_TO`,
  `PUBLIC_API`, `SHORT_HOST`, `R2_BUCKET`.
- Bindings: `DB` (D1 `scs-scores`), `SUBMIT` (R2 `scs-submissions`),
  `EMAIL` (Cloudflare Email Service).
- A placeholder `database_id`. `npm run deploy` fills it in by name into
  `wrangler.deploy.toml` (ignored by git) and deploys that. Never deploy
  with `npx wrangler deploy` directly.
- Workers Logs (`[observability]`) on for every request.

Everything that differs per account is a secret, listed in
`tab/secrets.example.json`: Discord's public key and bot token,
`CONSOLE_PASSWORD`, `PUSH_PASSWORD`, `TAB_SYNC_KEY`, `CHECKIN_KEY` and
`CHECKIN_API`, the VAPID keys, `ENCODER_KEY`, `SHEETS_WEBHOOK_URL`,
`EMAIL_API_KEY`, the Turnstile keys, the `R2_*` keys for direct uploads,
and `GUILD_ID` and `ORGANISER_ROLE_ID` for a first Discord server. A
value still reading `PASTE…` counts as unset, and the feature it guards
stays off. A secret must not share a name with a `[vars]` entry.

## The Discord side

The commands are `/score`, `/leaderboard`, `/quest`, `/list`, `/submit`,
`/unsubmit`, `/post`, `/verify` and `/help`. The worker answers each
interaction itself; there is no gateway connection. `/submit`,
`/unsubmit`, `/post` and the `channel:` option work only from a server
set up on the Discord tab, for a member holding that server's organiser
role. `/submit` keeps to the part rules the Queue's Accept uses: a fixed
part once, a per-unit part up to its most, never a tiered one.
`/unsubmit` refuses a tiered or a counted part: a counted part's count
is its accepted submissions, which an entry taking one off would not
lower. While posts are held (Discord tab), nothing is posted and a
command's answer is seen only by whoever ran it. Setup is in
[`tab/README.md`](../tab/README.md#setting-it-up).

## Where to read more

- [`tab/CLAUDE.md`](../tab/CLAUDE.md): the full notes. The opening
  paragraphs cover the API and the cache; then "`src/shared.ts` holds
  every cross-module helper", "Freezing the tab", "Messages + pulse",
  "The ledger", "Parts and their scoring types", "Discord side",
  "The worker's own clock", the submission and file paragraphs, "Albums",
  registration, and sign-in.
- [`tab/README.md`](../tab/README.md): setting the worker up and running
  it.
- [api.md](api.md) for every endpoint, [data-model.md](data-model.md)
  for the tables.
