#!/usr/bin/env bash
# Probe the live workers for the things that would leak data or let
# somebody in. Read-only: every request here is a GET, or a POST that is
# expected to be refused before it does anything. Nothing it sends can
# create a team, a submission, a message or an email.
#
#   ./security/probe.sh                  the real hosts
#   ./security/probe.sh --api files.example.workers.dev
#   ./security/probe.sh --site localhost:8123 --api 127.0.0.1:8787
#
# Run it against your own infrastructure. Every check prints what it
# asked, what it expected and what it got, so a failure tells you where
# to look rather than just that something is wrong.
#
# README.md beside this file says what each check proves, what it does
# not prove, and the handful of things a script cannot test.
set -u

SITE="scs.andyrew.space"
API="files.scs.andyrew.space"
DASH="dashboard.scs.andyrew.space"
CHECKIN="checkin.scs.andyrew.space"
SCHEME="https"

while [ $# -gt 0 ]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    --dash) DASH="$2"; shift 2 ;;
    --checkin) CHECKIN="$2"; shift 2 ;;
    --http) SCHEME="http"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

pass=0; fail=0; warn=0
ok()   { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
note() { warn=$((warn+1)); printf '  note  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
head_() { printf '\n%s\n' "$1"; }

# curl answers 000 when it could not connect at all. That is not a
# refusal and must never be read as one: an unreachable host would
# otherwise make every "is this shut?" check pass, which is the one
# failure mode a security check must not have. Anything that reads a
# status goes through this first.
unreachable() {
  if [ "$1" = "000" ]; then
    bad "$2" "no HTTP response — host unreachable, DNS failed, or the request timed out. This is NOT a refusal."
    return 0
  fi
  return 1
}

# Refuse to run at all against a host that is not answering, rather
# than printing a page of meaningless results.
reachable() {
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1")
  [ "$c" != "000" ]
}

# status of a GET
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1"; }
# status of a GET carrying a bearer token
code_auth() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "authorization: Bearer $2" "$1"; }
# body of a GET
body() { curl -s --max-time 20 "$1"; }

# A token that is well formed but was never issued. Used to prove that
# it is the session lookup refusing us and not the header parser.
BOGUS="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

printf 'Probing %s://%s (site) and %s://%s (api)\n' "$SCHEME" "$SITE" "$SCHEME" "$API"

for h in "$SITE:$SCHEME://$SITE/" "$API:$SCHEME://$API/api/pulse"; do
  name="${h%%:*}"; u="${h#*:}"
  if ! reachable "$u"; then
    printf '\n%s is not answering. Stopping.\n' "$name"
    printf 'Every "is this shut?" check would pass against a host that is\n'
    printf 'simply unreachable, which is worse than not running at all.\n'
    exit 2
  fi
done

# ---------------------------------------------------------------- 1 ---
head_ "1. The endpoints that must refuse a stranger"
# Every one of these should answer 401. A 200 means the gate is open.
for path in \
  "/api/console/overview" \
  "/api/console/export/all" \
  "/api/console/rego" \
  "/api/console/codes" \
  "/api/console/log" \
  "/api/console/board" \
  "/api/submit/mine" \
  "/api/submit/score" \
  "/api/submit/gallery"
do
  c=$(code "$SCHEME://$API$path")
  if unreachable "$c" "$path could not be reached"; then continue; fi
  if [ "$c" = "401" ]; then ok "$path refuses with 401"
  elif [ "$c" = "404" ]; then ok "$path is not there (404)"
  else bad "$path answered $c, expected 401" "anything but 401/404 here means it can be read without signing in"
  fi
done

# The same paths with a token that was never issued. This separates
# "the gate is shut" from "the header was never read".
c=$(code_auth "$SCHEME://$API/api/console/export/all" "$BOGUS")
if [ "$c" = "401" ]; then ok "a made-up bearer token is still refused"
else bad "a made-up bearer token answered $c" "the session lookup is not checking the token"
fi

# ---------------------------------------------------------------- 2 ---
head_ "2. What the public reads actually contain"
# These are meant to be open. The question is not whether they answer,
# it is whether they answer with more than the site needs.
for path in "/api/leaderboard" "/api/stats" "/api/quests" "/api/pulse" "/api/messages" "/api/countdown"; do
  c=$(code "$SCHEME://$API$path")
  [ "$c" = "200" ] && ok "$path is public and answering" || note "$path answered $c" "not fatal — it may be switched off"
done

for path in "/api/leaderboard" "/api/stats" "/api/quests" "/api/pulse" "/api/messages" "/api/recap" "/api/countdown"; do
  b=$(body "$SCHEME://$API$path")
  [ -z "$b" ] && continue
  # an email address anywhere in a public payload
  if printf '%s' "$b" | grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'; then
    bad "$path contains an email address" "public payloads must not carry anyone's address"
  fi
  # a field whose name says it is a secret
  if printf '%s' "$b" | grep -qiE '"(token|secret|password|qr_key|session|email|zid)"'; then
    bad "$path carries a field that should not be public" "$(printf '%s' "$b" | grep -oiE '"(token|secret|password|qr_key|session|email|zid)"' | sort -u | tr '\n' ' ')"
  fi
done
ok "checked every public payload for addresses, tokens and zIDs"

# Per-team check-in data. See README, finding 1.
b=$(body "$SCHEME://$API/api/stats")
if printf '%s' "$b" | grep -q '"team_checkins"'; then
  note "/api/stats still carries team_checkins" "every team's arrival time and headcount, readable by anyone, and nothing on the site reads it"
else
  ok "/api/stats does not carry per-team check-in rows"
fi

# ---------------------------------------------------------------- 3 ---
head_ "3. Capability URLs — guessing and traversal"
# A key that was never issued must 404, not serve something.
c=$(code "$SCHEME://$API/api/submit/file?key=sub/1/AAAAAAAAAAAAAAAA")
unreachable "$c" "the file endpoint could not be reached" || \
if [ "$c" = "404" ]; then ok "an invented file key is not found"
else bad "an invented file key answered $c" "expected 404"; fi

# A key that tries to climb out of the prefix.
c=$(code "$SCHEME://$API/api/submit/file?key=../../secret")
if [ "$c" = "404" ] || [ "$c" = "400" ]; then ok "a traversal key is refused ($c)"
else bad "a traversal key answered $c" "expected 400 or 404"; fi

# A key that is not under sub/ at all.
c=$(code "$SCHEME://$API/api/submit/file?key=msg/AAAAAAAAAAAA")
if [ "$c" = "404" ]; then ok "a key outside sub/ is not served by the team endpoint"
else bad "a key outside sub/ answered $c" "expected 404"; fi

# The ticket QR proxy: a key far too short to be a real one.
c=$(code "$SCHEME://$API/api/ticket/qr?k=aaaa")
unreachable "$c" "the ticket proxy could not be reached" || \
if [ "$c" = "400" ] || [ "$c" = "404" ]; then ok "a too-short ticket key is refused ($c)"
else bad "a too-short ticket key answered $c" "expected 400 or 404"; fi

# ---------------------------------------------------------------- 4 ---
head_ "4. The Discord endpoint"
# An unsigned POST must be refused. This sends a body Discord would
# treat as a ping; without a signature it should never be read.
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      -X POST -H 'content-type: application/json' \
      -d '{"type":1}' "$SCHEME://$API/")
unreachable "$c" "the interactions endpoint could not be reached" || \
if [ "$c" = "401" ]; then ok "an unsigned interaction is refused with 401"
else bad "an unsigned interaction answered $c" "expected 401 — the Ed25519 check should reject it"
fi

# ---------------------------------------------------------------- 5 ---
head_ "5. Response headers on the site"
h=$(curl -s -D - -o /dev/null --max-time 20 "$SCHEME://$SITE/")
want_header() {
  if printf '%s' "$h" | grep -qi "^$1:"; then ok "$1 is set"
  else note "$1 is not set" "$2"
  fi
}
want_header "content-security-policy" "defence in depth against script injection; needs hashes because every page has an inline boot script"
want_header "x-frame-options"         "or frame-ancestors in a CSP — stops the sign-in and submit forms being framed by another site"
want_header "referrer-policy"         "browsers default to strict-origin-when-cross-origin, so this is insurance rather than a hole"
want_header "x-content-type-options"  "stops a browser guessing a type other than the one sent"
if printf '%s' "$h" | grep -qi "^strict-transport-security:"; then ok "strict-transport-security is set"
else note "strict-transport-security is not set" "Netlify redirects to https already; HSTS stops the first plaintext hop"
fi

# The dashboard must not be indexed.
h2=$(curl -s -D - -o /dev/null --max-time 20 "$SCHEME://$DASH/dash")
if printf '%s' "$h2" | grep -qi "^x-robots-tag:.*noindex"; then ok "the dashboard says noindex"
else note "the dashboard does not send x-robots-tag: noindex" "it would be indexable if a link to it ever leaked"
fi

# ---------------------------------------------------------------- 6 ---
head_ "6. Caching — no private answer may be stored by anything shared"
for path in "/api/submit/gallery" "/api/submit/mine" "/api/console/overview"; do
  c=$(code "$SCHEME://$API$path")
  if unreachable "$c" "$path could not be reached"; then continue; fi
  cc=$(curl -s -D - -o /dev/null --max-time 20 "$SCHEME://$API$path" | grep -i '^cache-control:' | head -1)
  if printf '%s' "$cc" | grep -qi "no-store\|private"; then ok "$path is not cacheable ($(printf '%s' "$cc" | tr -d '\r'))"
  elif [ "$c" = "401" ] || [ "$c" = "404" ]; then ok "$path refused with $c before it answered, so there is nothing to cache"
  else note "$path answered $c with: $(printf '%s' "$cc" | tr -d '\r')" "a private answer wants private, no-store"
  fi
done

# ---------------------------------------------------------------- 7 ---
head_ "7. The check-in worker"
for path in "/api/status" "/api/attendees" "/admin" "/door"; do
  c=$(code "$SCHEME://$CHECKIN$path")
  if unreachable "$c" "$path could not be reached"; then continue; fi
  if [ "$c" = "401" ] || [ "$c" = "403" ] || [ "$c" = "404" ]; then ok "$path refuses or is absent ($c)"
  else note "$path answered $c" "check by hand whether that page or payload should be open"
  fi
done

printf '\n%d passed, %d failed, %d to look at by hand\n' "$pass" "$fail" "$warn"
[ "$fail" -gt 0 ] && exit 1
exit 0
