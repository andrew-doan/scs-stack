# Documentation

Reference pages for people working on SCS.2. Each describes how a part
works now, briefly, and links to the `CLAUDE.md` notes beside the code,
which keep the full detail and the reasons behind each decision.

Read them in this order:

| Page | What it covers |
|---|---|
| [architecture.md](architecture.md) | The pieces (the site, the tab worker and its hostnames, the dashboard, the check-in worker, the tile server), how a request moves between them, the caches, and the outside services. |
| [website.md](website.md) | Every page, the shared scripts, the service worker, the settings, the app and web layouts, and the design rules in short. |
| [dashboard.md](dashboard.md) | The organisers' tabs, accounts, permissions, the second password, and how the dashboard's 33 script files fit together. |
| [worker.md](worker.md) | The tab worker's modules and what each owns, how a request is routed, the once-a-minute run, and configuration. |
| [api.md](api.md) | Every endpoint: the public reads with their caching and freeze behaviour, the team and machine endpoints, and the dashboard's actions by tab with the permission each needs. |
| [data-model.md](data-model.md) | The tables of both databases, the ledger and the view `held`, the R2 key prefixes, and migrations. |
| [operations.md](operations.md) | Before the day, on the day, after it, rolling back, and the known errors with their fixes. |
| [testing.md](testing.md) | The test suites, how to run them, CI, and what deserves a check. |

## Other documents

- [`README.md`](../README.md): the front door. Running the site locally,
  the checked rules, deploying, the accounts and services.
- [`tab/README.md`](../tab/README.md): setting the tab worker up on a
  Cloudflare account and a Discord server, and running it.
- [`checkin/README.md`](../checkin/README.md): setting up and running
  check-in.
- [`tab/ENCODER.md`](../tab/ENCODER.md): the video encoder organisers run
  on their own computers.
- [`security/README.md`](../security/README.md): the probe of the live
  hosts and what each check proves.
- [`text/CLAUDE.md`](../text/CLAUDE.md): every string the site shows,
  in one CSV, and how an edited copy is applied.

## The notes beside the code

| Note | Covers |
|---|---|
| [`CLAUDE.md`](../CLAUDE.md) | the layout, the hard rules for the whole repo, testing conventions |
| [`website/assets/CLAUDE.md`](../website/assets/CLAUDE.md) | the shared chrome, caches, haptics, motion |
| [`website/questlist/CLAUDE.md`](../website/questlist/CLAUDE.md) | the quest page, the sheet, the map |
| [`website/submit/CLAUDE.md`](../website/submit/CLAUDE.md) | the submit page |
| [`website/compress/CLAUDE.md`](../website/compress/CLAUDE.md) | the compressor and its multi-threaded engine |
| [`website/tab/CLAUDE.md`](../website/tab/CLAUDE.md) | the live tab, team pages, the recap, the replay |
| [`tracks/CLAUDE.md`](../tracks/CLAUDE.md) | cleaning the GPX routes teams recorded |
| [`tab/CLAUDE.md`](../tab/CLAUDE.md) | the worker, the dashboard, migrations |
| [`checkin/CLAUDE.md`](../checkin/CLAUDE.md) | the check-in worker |
| [`phone/CLAUDE.md`](../phone/CLAUDE.md) | the phone worker for the payphone quest |

The notes are long and written as a record of each decision. Start
with the pages here, then read the notes for the detail.

## Keeping these pages right

A change to how something works updates the page here and the
`CLAUDE.md` beside the code in the same commit. Where a page and the
code disagree, the code is right and the page is the thing to fix.
`docs/` is outside `website/`, so it is never published and editing it
needs no cache bump.
