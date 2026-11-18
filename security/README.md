# Checking the live site for leaks and open doors

`probe.sh` runs the checks that can be automated. This says what each one
proves, what it does not prove, and the things you have to do by hand.

Run it against your own infrastructure. Everything in it is a GET, or a
POST that is expected to be refused before it does anything, so it
cannot create a team, a submission, a message or an email.

```
./security/probe.sh                                  the real hosts
./security/probe.sh --api files.example.workers.dev  a preview worker
./security/probe.sh --site localhost:8123 --http     a local server
```

It stops if a host does not answer. That is deliberate: curl reports a
failed connection as status `000`, and a check that asks "is this shut?"
would read `000` as a yes. An unreachable host would make the whole run
pass. The first version of this script did exactly that, and reported
three private endpoints as safely closed when nothing was listening.

## Read a result properly

A pass means the thing tested behaved. It does not mean the system is
safe — only that this particular door is shut. A `note` is something to
look at, not necessarily something wrong.

The checks that matter most are in section 1: if any of those answer
`200`, stop and fix it before the event, because it means a private
endpoint can be read by anyone with the URL.

## What each section checks

**1. Endpoints that must refuse a stranger.** Every dashboard read, and
the team-only submit reads, asked for with no credentials. All should
answer 401. It then asks again with a bearer token that was never
issued — that separates "the gate is shut" from "the header is never
read", which look identical from outside if the gate is open.

**2. What the public reads contain.** The leaderboard, stats, quests,
pulse, messages and countdown are meant to be open. The question is not
whether they answer but whether they answer with more than the site
needs. It greps each payload for an email address and for field names
that should never be public (`token`, `secret`, `password`, `qr_key`,
`session`, `email`, `zid`).

It also looks for `team_checkins` in `/api/stats`. That field is every
team's name, the exact time they finished checking in, and their
headcount — public, unauthenticated, and read by nothing on the site.
The recap and the dashboard query the table directly. During a live
event it tells any team when every other team arrived. If it is still
there, consider dropping it and keeping `teams_checked_in`, the count.

**3. Capability URLs.** Proof files are served without a session: the
random half of the R2 key is the capability, so anyone a team shared the
link with can open it. What must hold is that a key cannot be guessed or
escaped from. The checks ask for an invented key, a key that tries to
climb out of the `sub/` prefix, and a key belonging to a different
prefix. All should be 404. It also asks the ticket QR proxy for a key
far too short to be real.

This does not test the entropy of a real key. That is a code property:
file keys are 12 random bytes, check-in tokens 16, QR keys 24, sessions
32.

**4. The Discord endpoint.** An unsigned POST that Discord would treat
as a ping. It should be refused with 401 by the Ed25519 check before
anything reads the body.

**5. Response headers.** The site currently sets none of the usual ones.
None of these is a hole on its own, and they are listed as notes rather
than failures:

- `content-security-policy` — defence in depth. Awkward here because
  every page carries an inline boot script, so a strict policy needs
  hashes or nonces and there is no build step to generate them.
- `x-frame-options`, or `frame-ancestors` in a CSP — stops another site
  framing the sign-in and submit forms. The cheapest real improvement.
- `referrer-policy` — browsers have defaulted to
  `strict-origin-when-cross-origin` since about 2020, so the ticket
  URL's token does not leak cross-origin today. An explicit header is
  insurance against an old browser.
- `x-content-type-options: nosniff`.
- `strict-transport-security` — Netlify already redirects to https; HSTS
  closes the first plaintext hop.

All five can be added in a `website/_headers` file with no build step.

**6. Caching.** A private answer must never be storable by a shared
cache. Anything private should say `private, no-store`.

**7. The check-in worker.** Its own endpoints and organiser pages,
unauthenticated.

## What the script cannot test, and you should

**Clickjacking.** Save this as a local file and open it. If the site
appears inside the box, it can be framed, and a transparent frame over a
convincing page can make someone click Sign out, or worse, on a page
they think is something else.

```html
<!doctype html>
<p>If the site renders below, it can be framed.</p>
<iframe src="https://scs.andyrew.space/submit/" width="900" height="600"></iframe>
```

**What the browser is holding.** Open the site, then DevTools →
Application. Under Local Storage you should see preferences and caches —
`scs2-theme`, `scs2-questlist-done-v2`, `scs2-tab-cache` and so on — and
one credential, `scs2-submit-session`. That session is a bearer token for
that team. It is meant to be there; what matters is that nothing else is,
and that signing out removes it. Check that.

**The service worker's caches.** Same panel, Cache Storage. It should
hold pages, assets, map tiles and proof images. It must not hold a
response from `/api/submit/mine`, `/api/submit/score`,
`/api/submit/gallery` or anything under `/api/console/`. If a private
answer is in there, a shared device keeps it after sign-out.

**A real team session against another team's data.** The only test that
proves the team boundary holds. Sign in as one team, take
`scs2-submit-session` from Local Storage, and use it against the API:

```
TOKEN=<paste it>
curl -s -H "authorization: Bearer $TOKEN" https://files.scs.andyrew.space/api/submit/mine
curl -s -H "authorization: Bearer $TOKEN" https://files.scs.andyrew.space/api/submit/score
```

Both should answer for that team only. There is no team id in either
request, so the worker is deriving it from the session — which is the
right shape. Confirm the answers are that team's and nobody else's.

**Sign-out really ends the session.** Take a token, sign out in the
browser, then reuse the token with the commands above. It should answer
401. A token that still works after sign-out is a real problem on shared
phones.

**Whether an old proof link still works.** Capability URLs are forever
by design — that is the tradeoff for links that can be shared. Decide
whether you are comfortable with it and tell teams, rather than
discovering it later.

## Things this deliberately does not do

**No brute forcing.** Submit codes are 8 characters from a 31-character
alphabet, about 40 bits, so guessing one is not practical in a day even
with no rate limit. Testing that by hammering the endpoint would only
generate noise and possibly trip alerts.

**No rate-limit testing on sign-up.** `/api/rego/create` is guarded by a
honeypot, per-IP and global hourly limits, and Turnstile, and it creates
real teams and sends real email. Test it by signing up once, on purpose,
and watching the dashboard.

**No load or denial testing.** Not useful against your own event, and
Cloudflare would see it as an attack.

## When to run it

Before the event, after any worker deploy, and after any change to
`tab/src/console.ts`, `submit.ts` or `rego.ts` — those three hold the
gates.
