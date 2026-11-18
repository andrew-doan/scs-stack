# The site's own words

Every piece of text the site says, in one CSV, with the two scripts that
take it out and put it back.

```
site-text.csv   1106 rows: where, file, line, kind, element, text, new_text, notes
extract.py      reads website/ and writes the CSV
apply.py        reads an edited CSV and writes the changes back
```

The site has no translation layer and does not need one: the words live
where they are used, in the HTML and in the scripts. So the CSV is an
inventory with a file, a line and the exact old text on every row, and
`apply.py` matches on that text to put an edit back.

It reaches past `website/`. The confirmation email and the Discord bot
say the site's words too, and both are built in the tab worker, so their
copy is in here with everything else. Those rows write back to `tab/`
and need the worker redeployed, not a cache bump; `apply.py` says so
when it has touched one.

## Editing

Fill in `new_text` for the rows you want changed and leave the rest
empty. Then:

```
cd text
python3 apply.py                 # say what would change, change nothing
python3 apply.py --write         # make the changes
```

A row is found again by its kind and its old text, not by its line
number, so the CSV still applies after the file has moved around. When
anything under `website/` changes, `apply.py` bumps `CACHE` in
`website/sw.js`, because the installed app only picks new files up on a
bump.

Re-run `extract.py` after the site changes, or after applying edits, so
the CSV matches what is in the files.

## The columns

`where` is the page. `On every page` means the nav, the settings menu or
the footer — those are written out in all sixteen pages, so the row
stands for all of them and an edit changes all of them.

`kind` says what the words are: a heading, a button, a link, a form
label, a page title, a screen-reader label, a placeholder, a toast, a
status line. `Script text` means a string the page's own JavaScript puts
on screen in a place the extractor could not name more precisely.

The email adds `Subject`, `Preview line` (the grey line an inbox shows
after the subject), `Email heading`, `Email title` and `Plain-text
version` — the same message written again for clients that will not
render HTML, so a change to one usually wants the same change to the
other. The bot adds `Command name`, `Command description` (both of which
Discord shows in its own menu), `Reply`, `Reply, only you see it`,
`Channel post` and `Sign-up alert`.

`notes` carries four warnings:

- **the same words are in N pages** — the row is shared, see above.
- **joins onto other text** — the string is one part of a sentence the
  script builds, like `' pts, total '`. The spaces at the ends are doing
  work; keep them.
- **has a link or a bold run inside it** — the paragraph holds tags, so
  `apply.py` cannot tell where they go in a rewrite. It reports the file
  and line and leaves it alone. 66 rows are like this.
- **this is the word people type after the slash** — a command's own
  name. Changing it means re-registering the commands with Discord
  (`tab/scripts/register.mjs`), so it is not a copy edit.

`source` is the text exactly as it appears in the file, before any
escape like a unicode code point is turned into the character it stands
for. It is
what `apply.py` searches for.

## What is not in it

Anything OrgComm types. Quests, messages, team names and leaderboard
rows come from the worker's database, not from the repo, so they are
edited in the dashboard and in the quest CSVs.

Also out: the vendored libraries, the Season 1 archive, `marketing/`
(posters, logos, title animations, the map studies — not the site), the
strings that are plainly machinery (selectors, CSS, storage keys, URLs,
class names, MIME types, markup templates), the errors the code throws
at itself and never shows, and the device and browser names the push
code reads off the user agent.

## How the extractor decides

HTML is read one block at a time rather than one text node at a time, so
a paragraph with a bold lead-in is one row instead of three. A block
emits only when nothing inside it is also a block, which is what keeps a
`div` wrapping a table from coming out as a single row with the whole
table's words run together.

JavaScript is walked character by character rather than matched with a
regex, because a regex cannot tell a comment from code, and a sentence
somebody wrote in a comment must not end up in the CSV as if the site
said it. Each string is then classified by the statement it sits in:
`scsToast(` makes it a toast, `.textContent =` makes it text on screen,
`new Error(` drops it.

The worker is not read whole. A worker file is mostly machinery, so
`EMAIL_SOURCES` and `BOT_SOURCES` name the function that builds a
message — `regoEmail`, `discordContent`, everything from `cmdScore` to
`runCommand` — and the reader takes its line range by matching its
braces. Inside one of those the test is relaxed, because everything
there that is not machinery is the message; outside them nothing is
read. The nearest builder before a string names its row, so a link
inside a paragraph is a link and the paragraph around it is still a
paragraph.
