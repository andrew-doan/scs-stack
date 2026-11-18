#!/usr/bin/env python3
"""Write an edited site-text.csv back into the site.

    python3 apply.py                 # say what would change, change nothing
    python3 apply.py --write         # make the changes
    python3 apply.py --write other.csv

Fill in the new_text column for the rows you want changed and leave the
rest empty. A row is found again by its kind and its exact old text, not
by its line number, so the CSV still applies after the file has moved
around. A row marked as shared changes on every page that carries those
words.

Two kinds of row are reported rather than changed:

  - a block with tags inside it (a link or a bold run in the middle of a
    sentence). Rewriting it would need to know where the tags go, so it
    is left for a hand edit and the file and line are printed.
  - a row whose old text is no longer in the file, which means the file
    changed after the CSV was made. Re-run extract.py and edit again.

When anything under website/ changes, the service worker's CACHE number
is bumped, because the installed app only picks new files up on a bump.
"""
import csv, os, re, sys
from collections import defaultdict

import extract

HERE = extract.HERE
SITE = extract.SITE
REPO = extract.REPO


def whole(rel):
    """A row's file, wherever it lives.

    Most rows are in website/. The email's and the bot's are in the tab
    worker, so the path is resolved against the repo when it is not a
    site path."""
    p = os.path.join(SITE, rel)
    return p if os.path.exists(p) else os.path.join(REPO, rel)


def load(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return [r for r in csv.DictReader(fh) if (r.get("new_text") or "").strip()]


def html_index():
    """Every block and attribute the extractor can see, with its range."""
    index = defaultdict(list)
    for root, dirs, files in os.walk(SITE):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for f in sorted(files):
            if not f.endswith(".html"):
                continue
            rel = os.path.relpath(os.path.join(root, f), SITE)
            if extract.skip(rel):
                continue
            for r in extract.from_html(os.path.join(root, f), rel):
                if r["element"] != "js":
                    index[(r["kind"], r["text"])].append(r)
    return index


def esc_html(s, attr=False, quote='"'):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if attr:
        s = s.replace(quote, "&quot;" if quote == '"' else "&#39;")
    return s


def esc_js(s, like, quote):
    """Escape new text the way the string it replaces was escaped."""
    s = s.replace("\\", "\\\\").replace(quote, "\\" + quote)
    s = s.replace("\n", "\\n").replace("\t", "\\t")
    if "\\u" in like:
        s = "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in s)
    return s


def main():
    args = [a for a in sys.argv[1:] if a != "--write"]
    write = "--write" in sys.argv
    csv_path = args[0] if args else os.path.join(HERE, "site-text.csv")

    changes = load(csv_path)
    if not changes:
        print("Nothing in the new_text column. Nothing to do.")
        return 0

    index = html_index()
    edits = defaultdict(list)          # file -> [(start, end, replacement)]
    done, skipped = [], []

    for row in changes:
        old, kind = row["text"], row["kind"]
        # a script's text keeps the spaces at its ends: they are what
        # joins ' pts, total ' to the number in front of it
        new = row["new_text"] if row["element"] in ("js", "email", "discord") else row["new_text"].strip()
        if new == old:
            continue
        shared = "the same words are in" in (row.get("notes") or "")

        if row["element"] in ("js", "email", "discord"):
            path = whole(row["file"])
            src = open(path, encoding="utf-8").read()
            lit = row.get("source") or old
            hit = None
            for quote in "'\"`":
                needle = quote + lit + quote
                at = src.find(needle)
                if at >= 0:
                    hit = (at + 1, at + 1 + len(lit), esc_js(new, lit, quote))
                    break
            if hit:
                edits[row["file"]].append(hit)
                done.append((row["id"], row["file"], old, new))
            else:
                skipped.append((row["id"], row["file"], "not found any more", old))
            continue

        if row["element"] == "manifest":
            path = whole(row["file"])
            src = open(path, encoding="utf-8").read()
            needle = '"' + old.replace('"', '\\"') + '"'
            at = src.find(needle)
            if at >= 0:
                edits[row["file"]].append(
                    (at + 1, at + len(needle) - 1, new.replace('"', '\\"')))
                done.append((row["id"], row["file"], old, new))
            else:
                skipped.append((row["id"], row["file"], "not found any more", old))
            continue

        hits = index.get((kind, old), [])
        if not shared:
            hits = [h for h in hits if h["file"] == row["file"]]
        if not hits:
            skipped.append((row["id"], row["file"], "not found any more", old))
            continue
        for h in hits:
            src = open(whole(h["file"]), encoding="utf-8").read()
            a, b = h["span"]
            raw = src[a:b]
            if h["attr"]:
                quote = src[a - 1] if a and src[a - 1] in "'\"" else '"'
                edits[h["file"]].append((a, b, esc_html(new, True, quote)))
            elif "<" in raw:
                skipped.append((row["id"], h["file"],
                                "has tags inside it, so edit it by hand", old))
                continue
            else:
                lead = raw[:len(raw) - len(raw.lstrip())]
                tail = raw[len(raw.rstrip()):]
                edits[h["file"]].append((a, b, lead + esc_html(new) + tail))
            done.append((row["id"], h["file"], old, new))

    for f, items in sorted(edits.items()):
        path = whole(f)
        src = open(path, encoding="utf-8").read()
        for a, b, text in sorted(items, key=lambda x: -x[0]):
            src = src[:a] + text + src[b:]
        if write:
            open(path, "w", encoding="utf-8").write(src)

    for i, (rid, f, old, new) in enumerate(done):
        print(f"{rid}  {f}\n    - {old[:90]}\n    + {new[:90]}")
    if skipped:
        print("\nLeft alone:")
        for rid, f, why, old in skipped:
            print(f"  {rid}  {f}  {why}\n      {old[:90]}")

    touched = sorted(edits)
    site_touched = [f for f in touched if os.path.exists(os.path.join(SITE, f))]
    if write and touched:
        bump = bump_cache() if site_touched else None
        print(f"\nWrote {len(done)} change(s) across {len(touched)} file(s).")
        if bump:
            print(f"Service worker CACHE is now {bump}.")
        if len(site_touched) < len(touched):
            print("Email copy changed. Redeploy the tab worker for it to take effect.")
    elif touched:
        print(f"\n{len(done)} change(s) across {len(touched)} file(s). "
              "Nothing written — run again with --write.")
    return 1 if skipped else 0


def bump_cache():
    """The installed app only picks new files up when this number moves."""
    path = os.path.join(SITE, "sw.js")
    src = open(path, encoding="utf-8").read()
    m = re.search(r"(\bvar CACHE\s*=\s*'[^']*v)(\d+)(')", src)
    if not m:
        return None
    nxt = str(int(m.group(2)) + 1)
    open(path, "w", encoding="utf-8").write(
        src[:m.start()] + m.group(1) + nxt + m.group(3) + src[m.end():])
    return m.group(1).split("'")[-1] + nxt


if __name__ == "__main__":
    sys.exit(main())
