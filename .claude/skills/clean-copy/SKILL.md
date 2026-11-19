---
name: clean-copy
description: Cut interface copy that shouldn't exist — captions that restate a label, hints that pre-empt a worry the user never had, warnings that are scar tissue from a fixed bug. Use when writing or reviewing any user-facing string (labels, hints, empty states, toasts, confirmations, button text), or when asked to clean up / tighten copy.
---

# Cleaning copy

Most bad copy isn't badly written. It's copy that shouldn't be on the screen. Editing it for
tone just makes the wrong thing read better. So the first question is never "how should this
be phrased" — it's **should this exist**.

## The ladder

Walk a string down these in order. Stop at the first one that fires and delete.

**1. Does this need to surface at all?**
Is the thing being described something the user would ever have wondered about, unprompted? If
they'd never have thought to ask, you're not answering a question — you're planting one. Nobody
opens an avatar cropper wondering whether the circle is a true circle. A caption reading "the
preview is rendered at the exact size used on your profile" makes them wonder whether it might
not be.

**2. Does the label need to exist?**
A caption earns its place only when the value is meaningless without it. If the label, the
field, or the value beside it already says the thing, the caption is noise. A field labelled
"Retry limit" does not need "how many times we retry" beneath it. A bare "30" does need
"seconds" beside it — that one stays.

**3. Is it pre-empting something the user would never have had to consider?**
The tell: copy that rules out a failure rather than describing a behaviour.

> Cancel upload
> *Always keeps the files already transferred — never wipes the folder like the old cancel did.*

That second clause exists because of a bug. The user doesn't know about the bug, doesn't share
your memory of fixing it, and now has a worry they arrived without. **The fix for a fixed bug
is the fix. Not a caption about the fix.** Same for copy defending a design decision, or
hedging about something that simply works: "this may look slow but it is not", "don't worry if
the count seems off for a moment".

**4. Rewrite to remove the offending part. If nothing is left, delete the element.**
Don't preserve a hint just because there was a hint there. An empty `hint` prop comes off the
component; an explanatory `<p>` gets deleted, not shortened to a stub.

## What survives

Copy stays when the user genuinely cannot act without it:

- A real consequence at the moment of choosing. Under a destructive button: *"Anything not yet
  synced is lost."* They need it before they click, and they can't infer it.
- A compatibility or scope fact they can't see. *"Works with keys issued after March; older
  keys need rotating first."* The checkbox alone doesn't tell them whether it applies to them.
- What a blank state means and what to do next. *"No projects yet. Create one and it will
  appear here."*
- Units, scale, or format on a bare value.

Note the first example is one sentence. Had it continued *"— only use this when a sync is
stuck"*, that half would go: it instructs the user on when they're allowed to press a button
they can already see. Keep the consequence, cut the permission slip.

## Working style

- Read the string next to what's actually on screen around it — the label, the value, the
  button. Redundancy is invisible when you read the string alone.
- Cut whole clauses, not words. Tightening "Leave this blank to use the default setting for
  your account" into "Leave blank for the default" is a smaller win than noticing which half of
  a two-sentence hint is doing no work.
- When reviewing a batch, report as `file:line` with the current string and either the rewrite
  or `cut` — and say in a few words which rung it failed. Don't rewrite copy that passes.
- If a string is load-bearing but only in a rare state, consider whether it belongs in that
  state rather than permanently on the page.

## Tells to look for

After the ladder, read what is left for these. Each is a reason to cut or rewrite, checked
against what is on the screen, not against the string alone.

- A small label above a heading, or a line under it, that says the heading again.
- Numbers on things that are not steps (01, 02, 03 on a list with no order).
- Copy that explains the interface to the person using it: "Use the filters below to narrow the
  list", "This chart shows…". The control or the picture should say it.
- A design note that reached the screen: why the page is laid out this way, what it used to do.
- A status built from a chain of facts joined by dashes or dots. Use a sentence, or commas.
- The same word in the label, the placeholder and the hint.
- A slogan where a description was wanted.
- A badge, a dot or a "Live" word that is not bound to a real state.
- On a chart: a title naming the chart type, a note on how to read it, and a legend beside
  labels that already name each series.

Sentence rules for interface strings:

- No em dash. Use a full stop, a comma or a colon. (Notes and commit messages are not interface
  strings.)
- No filler ("in order to", "please note"), no stacked adverbs, none of the words a model
  reaches for ("seamless", "effortless", "delve", "elevate").
- Write little. Once a string is cut, the replacement is usually shorter than what was there or
  is nothing.

What not to touch:

- **Copy the committee wrote by hand.** The home page's blurb, the info page, the confirmation
  email's "You're In!", the bot's sign-offs, the 404's lines and the page descriptions for the
  team pages and the recap carry exclamation marks and a voice on purpose. Fix a typo or broken
  grammar and leave the rest, the exclamation mark included. Emphasis somebody chose is not a
  tell.
- Legal text (the terms and waiver). Its punctuation is the lawyer's.
- A visible label or an `aria-label` that names a control. Cutting it breaks the control for
  somebody.
- A claim you cannot check (a number, a date, a rule of the event). Ask, do not reword.
- The settled design: the uppercase label voice, the 800 weights, the title case on the recap
  pages and "Page | SCS.2" titles are in the root `CLAUDE.md` and are not copy tells.
- Edit the string where it is written (the page, the script, the worker), never the CSV by hand.

The `unslop-ui` skill has a counter that finds candidates (it is a pattern match, so it also
counts notes and the label-voice CSS; read each hit before acting on it):

    python3 -I ~/.agents/skills/unslop-ui/scripts/count_tells.py website tab/src/dash checkin/src

Its surface rules (`--surface`: weights, radii, shadows) are not applied here. The design
system decides those.

## In this repo

`text/site-text.csv` is the inventory: every string the site says, with its file, line, kind
and element. `text/extract.py` rebuilds it from `website/` (and the parts of `tab/` that speak
to readers: the confirmation email and the Discord bot). `text/apply.py` writes an edited
`new_text` column back. Re-run `extract.py` after any copy change, or the CSV goes stale.

Two house rules sit above this skill and are not negotiable:

- **No mannered prose.** No metaphor standing in for a plain statement. Say what you mean.
- **No hype, no emoji, no "simply"**, and nothing that only makes sense if you wrote the code.

Both are in the root `CLAUDE.md`. This skill is the cut before the edit; those are the edit.
