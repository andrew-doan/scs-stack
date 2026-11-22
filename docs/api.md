# The API

Every endpoint the tab worker answers, from the routes in
`tab/src/index.ts`, `tab/src/console.ts` and the modules they hand off
to. Permissions come from `tab/src/dash-access.ts`.

The site reads `https://files.scs.andyrew.space` (`TAB_API` in
`website/assets/site.js`). The public endpoints send open CORS
(`access-control-allow-origin: *`).

## Who may call what

| Caller | Proves itself with |
|---|---|
| anyone | nothing |
| a team | `Authorization: Bearer <session>` from `POST /api/submit/login` (24 hours) |
| an organiser | `Authorization: Bearer <session>` from `POST /api/console/login` (18 hours), plus the account's permission, plus the second password in `x-second-password` where an admin asked for it |
| the check-in worker | `Authorization: Bearer <TAB_SYNC_KEY>` |
| the encoder | `ENCODER_KEY` |
| Discord | an Ed25519 signature checked against `DISCORD_PUBLIC_KEY` |

## Public reads

These are kept in the worker's edge cache. All but the last are built
by `apiResponse` in `index.ts`; the last by `tally.ts`. Browsers get
`max-age=0` and a weak `ETag`, a hash of the body; a request whose
`If-None-Match` names it is answered 304 with no body. The site fetches
them with `cache: 'no-cache'`, so the browser sends the tag of the copy
it holds. A write that changes them purges them on every hostname in
`PUBLIC_API` as well as the one it arrived on.

| Endpoint | Answers | Kept | While frozen / closed |
|---|---|---|---|
| `GET /api/leaderboard` | `{teams: [{id, rank, dnf, name, points, quests_done, last_quest}]}`; hidden teams left out (a copy frozen before `id` was added has none) | 10s | the frozen copy / `{closed: true}` |
| `GET /api/stats` | `{total_teams, total_completions, total_points, submissions_pending}` | 10s | the frozen copy / `{closed: true}` |
| `GET /api/tab` | `{leaderboard, stats}`, the two above in one answer: what the live tab polls | 10s | each half as above |
| `GET /api/questlist` | regions in order, the quests and codes everyone may see, the place lists, and `version`, the quests counter it was built at. The site adds `?v=` (the pulse's quests number) once it knows it, which is a copy of its own at the edge. Opens due quests first | 30s | answers live |
| `GET /api/quests` | per code, how many teams hold it (points null for a mystery quest); per quest the same; only quests everyone may see | 30s | the frozen copy / `{closed: true}` |
| `GET /api/pulse` | `{quests, messages, message_seqs, urgent, team_pages, recap, replay, date_rules}`: `messages` and `message_seqs` are the newest message seqs, `urgent` the live urgent message with the highest seq; the three switches read off while the tab is frozen or closed. Publishes due messages and opens due quests first | 30s | answers live |
| `GET /api/messages` | the published messages everyone may read, each with its `seq` and its files | 30s | answers live |
| `GET /api/countdown` | the home page's countdown stops | 30s | answers live |
| `GET /api/slides` | the home page's slideshow pictures | 30s | answers live |
| `GET /api/quest/standings?quest=` | a challenge's standings, when the quest shows them | 10s when the same for everyone; otherwise private | `{frozen: true, frozen_at}` / `{closed: true}` |

For the standings, the freeze and the close are checked once, at the
top of the standings paths in `apiResponse`, so a new caller cannot
skip them; `/api/tab` is built from two of those paths.

## Other reads and writes for the site

None of these is kept in the edge cache.

| Endpoint | Caller | What it does |
|---|---|---|
| `GET /api/questlist/team` | team | the public list plus what this team may see |
| `GET /api/pulse/team`, `GET /api/messages/team` | team | the team's own pulse and messages; a 401 sends the site back to the public read |
| `GET /api/quest/ask?quest=` | anyone; team for its own answer | what a quest is asking now |
| `POST /api/quest/ask` | team | the team's answer; 409 once the question is closed |
| `GET /api/team?id=&name=` | anyone | one team's day, found by its id (which the leaderboard carries and a rename does not change), else by its name in any case; 404 until Team pages is switched on, and while the tab is frozen or closed |
| `GET /api/recap`, `GET /api/recap/quest?key=` | anyone | the day in numbers, and one quest's; 404 until Recap is switched on, and while frozen or closed |
| `GET /api/replay`, `GET /api/replay/route?name=` | anyone | the replay: every team's quests with when the proof was sent and the pin each was done at where that is known, its points over the day by when each submission was sent, which teams have a route, and one team's route; 404 until Replay is switched on, and while frozen or closed |
| `GET /api/rego/status` | anyone | whether sign-ups are open, why not, and the Turnstile site key |
| `POST /api/rego/create` | anyone | a team's sign-up |
| `GET`/`POST /api/rego/terms?k=` | the person the link was emailed to | read and accept the terms and waiver |
| `GET /api/ticket/qr?k=` | anyone with the key | a ticket's QR image, fetched from the check-in worker |
| `GET /api/push/vapid` | anyone | the public VAPID key |
| `POST /api/push/subscribe`, `/unsubscribe` | anyone; a team session links the device to the team | push subscriptions |
| `POST /api/push/unlink` | anyone with the endpoint | takes the team off a device, which stays subscribed (a team signing out) |
| `GET /api/embed/<page>` | Discord | the card Discord draws for a link to a site page (5 minutes in the browser) |
| `GET /api/albums`, `GET /api/album`, `GET /api/albums/info` | anyone, as each album allows | albums, one album, one photo's details |
| `POST /api/album/upload` and `/api/album/upload/*` | team or anyone, as the album allows | adding photos and videos, in slices when large |

### Team submissions (`/api/submit/*`)

| Endpoint | What it does |
|---|---|
| `POST login` | team name and submit code in, session out |
| `POST create` | a new submission with its answers |
| `GET mine` | the team's newest 100 submissions, optionally for one quest; `more: true` when there are older ones |
| `GET score` | the team's score sheet; `{ok, frozen: true}` while frozen and `{ok, closed: true}` while closed |
| `GET gallery` | the newest 300 submissions teams chose to share that have a photo or video, `more: true` when there are older ones; also open to an organiser's session |
| `POST gallery` | opt a submission in or out of the gallery |
| `GET upload/mode`, `GET upload/sign`, `GET upload/status`, `PUT upload/part`, `POST upload/finish`, `POST upload/abort` | sending files, straight to R2 or in slices through the worker |
| `GET /api/submit/tally?quest=` | the team's own count on a challenge; `{ok, frozen: true}` or `{ok, closed: true}` while the tab is frozen or closed |

### Files

Each is served by its key, and the random half of the key is the only
credential. They answer `immutable`, except where a video's still or
another height stands in until the encoder is done (`private,
no-store`). Most also answer at a path ending in the file's name, which
is how Discord tells a picture from a link.

| Endpoint | Serves |
|---|---|
| `GET /api/submit/file?key=` | proof files and their small and viewing copies (`&thumb=1`, `&res=` for a video size) |
| `GET /api/albums/file?key=` | album photos and videos |
| `GET /api/thumbs?k=&v=` | up to 30 grid thumbnails in one answer (album `alb/` and proof `sub/` keys), each exactly what the single route serves with `thumb=1`; a four-byte length, the parts as JSON, then their bytes |
| `GET /api/quests/file?key=` | files hung on a quest |
| `GET /api/messages/file?key=` | message attachments |
| `GET /api/slides/file?key=`, `GET /api/slides/cover` | slideshow pictures |
| `GET /api/drop/drop/<key>/<name>` | files shared from the Files tab |
| `GET /view/<key>/<name>`, `GET /photo/<id>` | a page for one proof or album file; Discord previews `/photo/` as the picture |
| `GET go.scs.andyrew.space/<slug>` | a short link: a redirect, or the file itself |
| `GET go.scs.andyrew.space/` | the link page while it is on (Files tab), otherwise a redirect to the site |
| `GET go.scs.andyrew.space/l/<id>` | one of the link page's links: counted, then a redirect |

## For other machines

| Endpoint | Caller | What it does |
|---|---|---|
| `POST /api/team-checkin` | check-in worker | a check-in, undo or hide: the team, whether it is complete, how many are in, the person, and when (`at`); one older than what the tab has changes nothing, and in the same second so does one with fewer people in. The team is found by its name as check-in stores it (without ``<>&"'` ``) and kept under the tab's own name |
| `/api/encoder/*` (`poll`, `claim`, `source`, `rendition`, `still`, `finish`, `upload/*`) | encoder | take a video, fetch the original, send back the copies |
| `POST /` | Discord | slash commands and role menu picks |

## Dashboard actions

Each is `/api/console/<action>`. "Any" means any signed-in account.
"Admin" means the action is in neither permission table, so only an
admin may use it. Actions marked † can be put behind the second password
(see [dashboard.md](dashboard.md#the-second-password)).

| Tab | Actions | Needs |
|---|---|---|
| all | `POST login` | no session |
| all | `GET overview`, `GET me`, `GET quests`, `GET spinner`, `POST auth/backup` | any |
| Scores | `GET board`, `GET schedule`, `GET freeze`, `POST freeze`†, `POST freeze/close`†, `POST freeze/save`, `GET freeze/copy`, `POST freeze/copy/delete`, `GET standings`, `GET tab/export`, `POST tab/last-until`, `GET`/`POST ledger/check` | `scores` |
| Recap | `GET recap`, `GET`/`POST recap/hours`, `POST recap/review`, `POST recap/times`, `POST recap/arrivals`, `POST recap/most-skip`, `POST recap/views`, `GET`/`POST recap/sections`, `POST recap/dates`, `GET`/`POST ranks/boards`, `POST ranks/recap`, `GET quests-done`, `GET ranks/times`, `GET ranks/custom` | `scores` |
| Queue | `GET submissions`, `POST review/claim`, `GET encoder/status`, `POST encoder/release`, `POST submissions/accept`, `reject`, `revise`, `reopen`, `answer`, `files`, `delete`† | `review` |
| Queue, Desk, Ledger | `GET file`, `GET file/meta`, `GET file/track`, `GET desk`, `GET points/form`, `GET team/receipt`, `POST points/undo`, `POST points/redo` | `review`, `points` or `scores` |
| Queue, Desk | `GET tally`, `GET tally/team` | `review`, `points`, `scores` or `quests` |
| Desk | `POST points/add`, `POST points/time` | `points` or `scores` |
| Desk | `POST tally/award`†, `POST tally/unaward`† | `scores` |
| Desk, Quests | `POST quests/group/ask/responses` | `quests`, `review`, `points` or `scores` |
| Desk, Quests | `POST quests/group/ask/open` | `quests`, `points` or `scores` |
| Desk, Quests | `POST quests/group/ask/settle`†, `unsettle`† | `quests` or `scores` |
| Ledger | `POST ledger/adjust`†, `POST ledger/void`† | `points` or `scores` |
| Map | `GET map` | `map` |
| Routes | `GET tracks`, `GET tracks/gpx`, `POST tracks/save`, `POST tracks/delete` | `routes` |
| Quests | `GET quests/visible`, `GET quests/export`, `GET quests/asks`, every other `POST quests/...`: `add`, `edit`, `delete`†, `group/save`, `group/access`, `group/files`, `group/file/delete`, `group/delete`†, `group/ask/save`, `tags/save`, `tags/delete`, `tags/apply`, `open-all`†, `retire`†, `import-scs2`, `regions/save`, `regions/delete`, `regions/order`, `regions/colour`, `order`, `file/preview`, `file/commit` | `quests` |
| Teams, Quests | `POST quests/team-groups/save`, `delete` | `teams` or `quests` |
| Teams | `GET codes`, `POST codes/generate`, `POST teams/add`, `rename`, `hide`, `dnf`, `delete`† | `teams` |
| Messages | `GET messages/list`, `POST messages/save`, `delete`, `archive`, `order`, `file/delete` | `messages`; a message with a push also needs `push` |
| Push | `GET push/stats`, `POST push/send`† (on by default), `POST push/name` | `push` |
| Email | `GET announce`, `POST announce/preview`, `test`, `send`†, `step`, `stop`, `retry` | `email` |
| Rego | `GET rego`, `GET rego/csv`, `POST rego/resync`, `rego/email`, `rego/person/qr`, `rego/team/save`, `rego/person/save`, `rego/person/delete`†, `rego/person/move`†, `rego/hide`, `rego/team/create`, `rego/place` | `rego` |
| Rego, Settings | `GET rego/settings`, `POST rego/settings/set`, `POST rego/email/test` | `rego` or `settings` |
| Files | `GET drop`, `POST drop/upload`, `drop/edit`, `drop/delete`, `POST links/save`, `links/delete`, `GET albums`, `GET album`, `GET album/pass`, `GET album/zip`, `POST albums/save`, `albums/delete`, `POST album/upload`, `album/photo/remove`, `album/photo/point`, `album/photos/author` | `files` |
| Discord | `GET discord/status`, `discord/guild`, `discord/leftovers`, `discord/menus`; `POST discord/guild/save`, `guild/delete`, `register`, `post`, `hold`, `setup`, `team/save`, `codes/send`†, `refresh`, `roles/all`, `leftovers/delete`†, `menus/save`, `menus/post`, `menus/delete`, `roles/create` | `discord` |
| Settings | `GET flags`, `POST flags/set`, `GET email/hold`, `POST email/hold`, `GET limits`, `POST limits/set`, `GET countdown`, `POST countdown/set`, `GET counters`, `POST counters/set`; `GET eoi`, `POST eoi/list`, `eoi/points`, `eoi/award`†; `GET slides`, `POST slides/save`, `edit`, `focus`, `hide`, `delete`, `order`, `step`; `GET export/all`†; `POST files/reclean`; `GET storage` | `settings` |
| Accounts | `GET accounts`, `POST accounts/save`†, `accounts/delete`†, `auth/reset`†, `guards/set` | admin |
| Settings | `GET privacy`, `GET privacy/export`†, `POST privacy/remove`†, `privacy/restore`†; `GET originals`, `GET originals/zip`, `POST originals/delete`† | admin |
| Log | `GET log` | `log` |
| any uploading tab | `GET upload/mode`, `GET upload/sign`, `POST upload/start`, `upload/finish`, `upload/abort` | `messages`, `quests`, `settings`, `files`, `points`, `scores` or `review` |

A successful `POST quests/...` also moves the quest counter on the
pulse, which tells the site to fetch the quest list again. Writes that
change a public read purge the edge cache; the comment beside each line
of the router in `console.ts` says which do.

## Where to read more

- [`tab/README.md`](../tab/README.md#the-http-api): example payloads for
  the public reads.
- [`tab/CLAUDE.md`](../tab/CLAUDE.md): the opening paragraphs (the API
  and its cache), "Freezing the tab", "Closing the tab", "Messages +
  pulse", "What the live tab's columns read", and the console lines
  under each feature.
- [`website/tab/CLAUDE.md`](../website/tab/CLAUDE.md): the
  payloads of `/api/team` and `/api/recap`.
- [`checkin/README.md`](../checkin/README.md#api-summary): the check-in
  worker's own endpoints.
