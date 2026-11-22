#!/usr/bin/env python3
"""Pull every piece of text the site itself says into one CSV.

    python3 extract.py            # writes site-text.csv beside this file

In: page copy, headings, button and link labels, form labels, hints and
placeholders, screen-reader labels, page titles and descriptions, the
app manifest, and every message the scripts put on screen — toasts,
status lines, errors, empty states, confirmations.

Out: anything OrgComm types, because quests, messages, team names and
leaderboard rows come from the worker rather than the repo; the
vendored libraries; and the Season 1 archive. Out too: strings that are plainly machinery — selectors, CSS,
storage keys, URLs, class names, MIME types, markup templates, and the
errors the code throws at itself.

Each row carries the file, the line and the exact source text, so
apply.py can write an edited CSV back.
"""
import csv, os, re, sys
from collections import Counter, defaultdict
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(os.path.dirname(HERE), "website")

SKIP_DIRS = {"node_modules", "assets/haptics", "assets/ffmpeg",
             "assets/protomaps", "scs1-tab"}
SKIP_FILES = {"qrcode.js", "qr.js", "leaflet.js", "pmtiles.js"}

# a page's own name, for the "where" column
PAGE = {
    "index.html": "Home", "info/index.html": "Event info",
    "welfare/index.html": "Welfare and safety", "questlist/index.html": "Quest list",
    "questlist/full/index.html": "Quest list, full", "tab/index.html": "Live tab",
    "tab/team/index.html": "Team page", "messages/index.html": "Messages",
    "submit/index.html": "Submit a quest", "rego/index.html": "Register",
    "gallery/index.html": "Gallery",
    "recap/index.html": "Recap",
    "ticket/index.html": "Ticket", "terms/index.html": "Terms and waiver",
    "404.html": "Page not found",
    "manifest.webmanifest": "App install",
}
SHARED = {"assets/site.js": "Shared chrome", "assets/site-viewer.js": "Shared chrome",
          "assets/site-chrome.js": "Shared chrome", "assets/site-input.js": "Shared chrome",
          "assets/site-app.js": "Shared chrome", "sw.js": "Offline"}

ORDER = ["On every page", "Home", "Event info", "Quest list", "Quest list, full",
         "Submit a quest", "Live tab", "Team page", "Recap", "Gallery",
         "Messages", "Register", "Terms and waiver", "Confirmation email", "Email layout",
         "Email, dashboard test", "Discord commands", "Discord replies",
         "Discord announcements", "Ticket", "Welfare and safety",
         "Compress a video", "Camera", "Page not found", "Shared chrome",
         "App install", "Offline"]

FIELDS = ["id", "where", "file", "line", "kind", "element", "text",
          "new_text", "notes", "source"]


def page_of(rel):
    if rel in SHARED:
        return SHARED[rel]
    if rel in PAGE:
        return PAGE[rel]
    d = os.path.dirname(rel)
    for k, v in PAGE.items():
        if d and os.path.dirname(k) == d:
            return v
    return rel


# ----------------------------------------------------------------- HTML
# Text is taken per block, not per text node: a paragraph with a bold
# lead-in is one thing somebody edits, not three fragments. A block
# emits only when nothing inside it is also a block, so a row is the
# smallest whole thing somebody would edit — that paragraph is one row,
# but a list item made of three spans is three.
BLOCK = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "button", "a", "label",
         "dt", "dd", "td", "th", "caption", "summary", "legend", "figcaption",
         "option", "title", "span", "div"}

# things that hold blocks without being one. A div wrapping a table is
# not a paragraph, and emitting it gives a row with the whole table's
# words run together.
CONTAINER = {"table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl",
             "section", "article", "aside", "nav", "header", "footer", "main",
             "figure", "details", "form", "fieldset", "picture", "video",
             "audio", "template"}

KIND_BY_TAG = {
    "title": "Page title", "h1": "Heading", "h2": "Heading", "h3": "Heading",
    "h4": "Heading", "h5": "Heading", "h6": "Heading", "button": "Button",
    "a": "Link", "label": "Form label", "dt": "Label", "dd": "Value",
    "summary": "Disclosure", "th": "Table heading", "td": "Table cell",
    "legend": "Fieldset legend", "option": "Menu option",
    "figcaption": "Caption", "li": "List item",
}


def tag_end(src, i):
    """The offset just past the '>' that closes the tag starting at i."""
    q = None
    while i < len(src):
        c = src[i]
        if q:
            if c == q:
                q = None
        elif c in "'\"":
            q = c
        elif c == ">":
            return i + 1
        i += 1
    return len(src)


class Grab(HTMLParser):
    MUTE = {"style", "svg", "template"}
    ATTRS = {
        "aria-label": "Screen-reader label", "placeholder": "Placeholder",
        "alt": "Image description", "title": "Tooltip",
        "aria-description": "Screen-reader description",
        "data-cd-label": "Countdown label",
    }
    VOID = {"br", "img", "input", "meta", "link", "hr", "source", "area", "col"}

    def __init__(self, src):
        super().__init__(convert_charrefs=True)
        self.src = src
        self.starts = [0]
        for line in src.splitlines(keepends=True):
            self.starts.append(self.starts[-1] + len(line))
        self.rows, self.stack, self.muted = [], [], 0
        self.script, self.scripts = None, []

    def at(self):
        line, col = self.getpos()
        return line, self.starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        line, off = self.at()
        end = tag_end(self.src, off)
        raw = self.src[off:end]
        a = dict(attrs)
        if tag == "script":
            self.muted += 1
            self.script = None if a.get("src") else line
            return
        if tag in self.MUTE:
            self.muted += 1
        for k, kind in self.ATTRS.items():
            v = (a.get(k) or "").strip()
            if v and not v.startswith("{") and len(v) > 1:
                m = re.search(r"\b" + re.escape(k) + r"\s*=\s*(['\"])(.*?)\1",
                              raw, re.S)
                if m:
                    self.rows.append(dict(line=line, kind=kind, tag=tag, text=v,
                                          span=(off + m.start(2), off + m.end(2)),
                                          attr=True))
        if tag == "meta" and a.get("name") == "description":
            v = (a.get("content") or "").strip()
            m = re.search(r"\bcontent\s*=\s*(['\"])(.*?)\1", raw, re.S)
            if v and m:
                self.rows.append(dict(line=line, kind="Page description",
                                      tag="meta", text=v, attr=True,
                                      span=(off + m.start(2), off + m.end(2))))
        if tag in self.VOID:
            if tag == "br":
                for f in self.stack:
                    f["buf"].append(" ")
            return
        self.stack.append({"tag": tag, "line": line, "buf": [], "kids": 0,
                           "inner": end})
        # every ancestor, not just the parent: a block three levels down
        # still means the outer one is a wrapper rather than a sentence
        if len(self.stack) > 1 and (tag in BLOCK or tag in CONTAINER):
            for f in self.stack[:-1]:
                f["kids"] += 1

    def close_frame(self, f, end):
        text = " ".join("".join(f["buf"]).split())
        if f["tag"] in BLOCK and text and f["kids"] == 0:
            self.rows.append(dict(line=f["line"], kind=KIND_BY_TAG.get(f["tag"], "Text"),
                                  tag=f["tag"], text=text, attr=False,
                                  span=(f["inner"], end)))

    def handle_endtag(self, tag):
        _, off = self.at()
        if tag == "script":
            if self.muted:
                self.muted -= 1
            self.script = None
            return
        if tag in self.MUTE and self.muted:
            self.muted -= 1
        while self.stack:
            f = self.stack.pop()
            self.close_frame(f, off)
            if self.stack:
                self.stack[-1]["buf"].append(" " + "".join(f["buf"]) + " ")
            if f["tag"] == tag:
                break

    def handle_data(self, data):
        if self.script is not None:
            self.scripts.append((self.script, data))
            return
        if self.muted or not self.stack:
            return
        self.stack[-1]["buf"].append(data)


def from_html(path, rel):
    src = open(path, encoding="utf-8").read()
    g = Grab(src)
    g.feed(src)
    g.close()
    while g.stack:
        g.close_frame(g.stack.pop(), len(src))
    out = []
    for r in g.rows:
        t = " ".join(r["text"].split())
        if len(t) < 2 or not re.search(r"[A-Za-z]", t):
            continue
        a, b = r["span"]
        out.append(dict(file=rel, line=r["line"], where=page_of(rel),
                        kind=r["kind"], element=r["tag"], text=t, source=t,
                        span=r["span"], attr=r["attr"],
                        inline=not r["attr"] and "<" in src[a:b]))
    # the boot script and the 404 puns live in the page, not in a .js file
    for first_line, code in g.scripts:
        out += scan_js(code, rel, page_of(rel), base_line=first_line)
    return out


# ------------------------------------------------------------------- JS
# Strings are found by walking the source rather than by regex: a regex
# cannot tell a comment from code, and the one thing that must not end
# up in the CSV is a sentence somebody wrote in a comment.
def js_strings(src):
    """Yield (line, text, the code just before it) for every string literal."""
    i, n, line = 0, len(src), 1
    prev = ""          # last significant character, for regex-vs-divide
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                if src[i] == "\n":
                    line += 1
                i += 1
            i += 2
            continue
        if c == "/" and prev not in ")]}" and not re.match(r"[\w$]", prev or " "):
            i += 1                       # a regex literal: skip it whole
            klass = False
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "[":
                    klass = True
                elif src[i] == "]":
                    klass = False
                elif src[i] == "/" and not klass:
                    i += 1
                    break
                elif src[i] == "\n":
                    break
                i += 1
            prev = "/"
            continue
        if c in "'\"`":
            start_line, start = line, i
            i += 1
            buf = []
            while i < n:
                if src[i] == "\\":
                    buf.append(src[i:i + 2])
                    i += 2
                    continue
                if src[i] == c:
                    i += 1
                    break
                if src[i] == "\n":
                    line += 1
                buf.append(src[i])
                i += 1
            yield start_line, "".join(buf), src[max(0, start - 220):start]
            prev = "x"
            continue
        if not c.isspace():
            prev = c
        i += 1


HTML_TAGS = {
    "a", "abbr", "area", "article", "aside", "audio", "b", "body", "br",
    "button", "canvas", "caption", "code", "col", "dd", "details", "dialog",
    "div", "dl", "dt", "em", "fieldset", "figcaption", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html",
    "i", "iframe", "img", "input", "label", "legend", "li", "link", "main",
    "menu", "meta", "nav", "ol", "option", "p", "path", "picture", "pre",
    "script", "section", "select", "small", "source", "span", "strong",
    "style", "summary", "svg", "table", "tbody", "td", "textarea", "tfoot",
    "th", "thead", "time", "title", "tr", "ul", "video",
}

SELECTORY = re.compile(r"""
      ^\s*[.#]                      # a class or id selector
    | \[[a-zA-Z-]+[\]=^*$~|]        # an attribute selector
    | :scope|::[a-z-]+|:not\(|:nth-|:hover|:focus|:checked
    | [~>]\s|\s[~>]                 # a combinator
    | ^[a-z][a-z0-9]*[.#][a-zA-Z_-]  # tag.class
""", re.X)

CSSY = re.compile(r"""
      ^--                           # a custom property
    | ^\(.*:.*\)                    # a media query
    | cubic-bezier\(|translate[XYZ3d]*\(|scale\(|rotate\(|rgba?\(|var\(--
    | ^-?\d[\d.]*(px|ms|s|%|vh|vw|em|rem|deg)\b
    | ^[a-z-]+\s*:\s*[^ ]+;?$       # one CSS declaration
    | \b(?:sans-serif|system-ui|monospace|cursive)\b
""", re.X)

MARKUPY = re.compile(r"</?[a-z][a-z0-9]*[\s>/]|&[a-z]+;|\$\d|[{}]")

PATHY = re.compile(r"""
      ^(?:https?:)?//
    | ^\.{0,2}/
    | ^[\w.-]+/[\w./-]*$
    | \.(?:js|mjs|css|json|html|webmanifest|png|jpe?g|svg|webp|gif|woff2?|pmtiles)$
""", re.X)

KEYY = re.compile(r"""
      ^scs2?[-:]                    # a storage key
    | ^data:|^blob:
    | ^[a-z]+/[a-z0-9.+*-]+(;|,|$)  # a MIME type
    | ^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+$   # kebab or snake, one token
    | ^[a-z]+([A-Z][a-z0-9]*)+$     # camelCase, one token
    | ^[-,;]?\s*[a-z][a-z-]*=       # an option or a query parameter
    | ^[MmLlHhVvCcSsQqTtAaZz]\s?-?\d[\d.,\sA-Za-z-]*$   # SVG path data
""", re.X)

# names of things, not words to a reader
MACHINE_WORDS = {
    "use strict", "mailto:", "https://", "http://", "bot", "bearer ", "click", "keydown", "keyup", "touchstart", "touchmove",
    "touchend", "pointerdown", "pointerup", "change", "input", "submit",
    "scroll", "resize", "load", "error", "message", "visibilitychange",
    "transitionend", "animationend", "get", "post", "put", "patch", "delete",
    "true", "false", "null", "undefined", "none", "block", "flex", "grid",
    "hidden", "visible", "auto", "yes", "no", "on", "off", "light", "dark",
    "small", "medium", "large", "polite", "assertive", "button", "dialog",
    "hover", "active", "escape", "enter", "tab", "space", "shift", "control",
    "backspace", "arrowup", "arrowdown", "arrowleft", "arrowright", "bearer",
    "point", "feature", "featurecollection", "linestring", "polygon",
    "top left", "top right", "bottom left", "bottom right", "center",
    "html", "text",
}

# names the script reads off the user agent, not words anybody wrote
NOT_COPY = {"Notification", "Device", "iPad", "iPhone", "Android", "Mac",
            "Windows", "Linux", "Edge", "Opera", "Firefox", "Chrome", "Safari",
            "PushManager", "Intl", "Promise"}

# SQL. The worker keeps its statements as plain strings, and a SELECT
# is several words of English as far as the phrase test is concerned.
# The keywords are matched case-sensitively because every statement in
# the worker is written in caps, and lowercasing the test would catch
# "Set by" in the email's metadata block.
SQLY = re.compile(r"""
      ^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|VALUES|
             FROM|JOIN|LEFT\ JOIN|WHERE|ORDER\ BY|GROUP\ BY|ON\ CONFLICT|SET)\b
    | \?\d\b                        # a bound parameter
    | \bCOLLATE\ NOCASE\b
    | =\s*NULL\b
""", re.X)

# a list of class names: all lowercase tokens and at least one hyphen
CLASSLIST = re.compile(r"^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*){0,4}$")


def machinery(t):
    """Is this a name the code uses rather than words a person reads?"""
    if t.strip() in NOT_COPY:
        return True
    if t.lower().strip() in MACHINE_WORDS:
        return True
    if CLASSLIST.match(t) and "-" in t:
        return True
    if SELECTORY.search(t) or CSSY.search(t) or MARKUPY.search(t) \
       or PATHY.search(t) or KEYY.search(t) or SQLY.search(t):
        return True
    # a comma-separated list of selectors, e.g. "a, button, label, summary"
    parts = [p.strip() for p in t.split(",")]
    if len(parts) > 1 and all(
            p and (p in HTML_TAGS or p.startswith(".") or p.startswith("#"))
            for p in parts):
        return True
    return False


def says(s):
    """Does this read like something a person is meant to read?"""
    t = s.strip()
    if len(t) < 3 or not re.search(r"[A-Za-z]", t) or machinery(t):
        return False
    if len(t.split()) >= 2 and len(re.findall(r"[A-Za-z]{2,}", t)) >= 2:
        return True
    # a single word only counts when it is written as a sentence would be
    return bool(re.match(r"^[A-Z][a-z]{2,}[.!?…]?$", t))


# Where a string is put in front of somebody. The call forms are looked
# for anywhere in the statement, because the string is often not the
# first argument; the assignment forms have to sit right before it.
ASSIGNS = [
    (re.compile(r"\.textContent\s*\+?=\s*$"), "Text"),
    (re.compile(r"\.innerHTML\s*\+?=\s*$"), "Text"),
    (re.compile(r"\.placeholder\s*=\s*$"), "Placeholder"),
    (re.compile(r"""['"]aria-label['"]\s*,\s*$"""), "Screen-reader label"),
    (re.compile(r"""['"]title['"]\s*,\s*$"""), "Tooltip"),
    (re.compile(r"\.title\s*=\s*$"), "Tooltip"),
    (re.compile(r"\.ariaLabel\s*=\s*$"), "Screen-reader label"),
    (re.compile(r"\b(?:err|error|msg|message|status|note|hint|body|label|reason|why)\s*=\s*$"),
     "Message"),
    (re.compile(r"\breturn\s+$"), "Message"),
]
CALLS = [
    (re.compile(r"\bscsToast\("), "Toast"),
    (re.compile(r"\bswapText\("), "Status line"),
    (re.compile(r"\bconfirm\("), "Confirmation"),
    (re.compile(r"\balert\("), "Alert"),
    (re.compile(r"\bshowNotification\("), "Notification"),
    (re.compile(r"\bdocument\.title\b"), "Page title"),
    (re.compile(r"""['"]aria-label['"]\s*,"""), "Screen-reader label"),
    (re.compile(r"\.(?:textContent|innerHTML|ariaLabel)\b"), "Text"),
    (re.compile(r"\.placeholder\b"), "Placeholder"),
    (re.compile(r"""\.title\b|['"]title['"]\s*,"""), "Tooltip"),
    # the small builders each page keeps for its own rows and fields
    (re.compile(r"\b(?:fact|stat|field|fieldLabel|slider|chip|pill|opt|toggle|"
                r"rocker|check|sub|head|caption)\("), "Label"),
    (re.compile(r"\blabel\s*:\s*$"), "Label"),
    (re.compile(r"\bplural\("), "Text"),
]
# A sink is somewhere a person will read it, so a short or lowercase
# string there is kept even though it would not stand on its own. The
# builders are not sinks: they take class names and field types too.
SINKS = {"Toast", "Status line", "Text", "Placeholder", "Screen-reader label",
         "Tooltip", "Confirmation", "Alert", "Notification"}

ESCAPES = {"n": "\n", "t": "\t", "r": "", "\\": "\\", "'": "'", '"': '"',
           "`": "`", "/": "/", "0": ""}


def unescape(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            c = s[i + 1]
            if c == "u" and re.match(r"[0-9a-fA-F]{4}", s[i + 2:i + 6]):
                out.append(chr(int(s[i + 2:i + 6], 16)))
                i += 6
                continue
            if c in ESCAPES:
                out.append(ESCAPES[c])
                i += 2
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def statement(before):
    """The code back to the start of the statement the string is in."""
    cut = max(before.rfind(";"), before.rfind("{"), before.rfind("}"))
    return before[cut + 1:]


def scan_js(src, rel, where, base_line=1, liberal=False):
    out = []
    for line, raw, before in js_strings(src):
        stmt = statement(before)
        # errors the code throws at itself, and anything logged
        if "new Error(" in stmt or "console." in stmt \
           or re.search(r"\.message\s*[=!]==?\s*$", stmt):
            continue
        kind = None
        for pat, name in ASSIGNS:
            if pat.search(stmt):
                kind = name
                break
        if not kind:
            for pat, name in CALLS:
                if pat.search(stmt):
                    kind = name
                    break
        s = unescape(raw)
        if liberal or kind in SINKS:
            t = s.strip()
            if len(t) < 2 or not re.search(r"[A-Za-z]", t) or machinery(t):
                continue
            kind = kind or "Text"
        else:
            if not says(s):
                continue
            kind = kind or "Script text"
        out.append(dict(file=rel, line=line + base_line - 1, where=where,
                        kind=kind, element="js", text=s, source=raw))
    return out


def from_js(path, rel):
    return scan_js(open(path, encoding="utf-8").read(), rel, page_of(rel))


# --------------------------------------------------------------- email
# The confirmation email is not in website/. It is built in the tab
# worker and sent from there, but its words are the site's words, so
# they belong in this CSV. The file around them is a worker, full of
# machinery, so only the part that builds a message is read: the
# function is found by name and its body by matching its braces.
REPO = os.path.dirname(HERE)

EMAIL_SOURCES = [
    # file, function, the object inside it that is the message, heading
    ("tab/src/rego.ts", "regoEmail", None, "Confirmation email"),
    ("tab/src/console.ts", "emailTest", "message = {", "Email, dashboard test"),
    ("tab/src/announce.ts", "buildAnnouncement", None, "Announcement email"),
]
# Fixed details that sit outside those functions. The pattern's one
# group is the words; everything else on the line is machinery.
EMAIL_LOOSE = [
    ("tab/src/rego.ts", r"var EVENT_DATE = '([^']+)'", "Confirmation email", "Fixed detail"),
    ("tab/src/rego.ts", r"var ORG_EMAIL = '([^']+)'", "Confirmation email", "Fixed detail"),
    ("tab/src/email-html.ts", r'alt="([^"\'+()]+)"', "Email layout", "Image description"),
    ("tab/src/announce.ts", r"var WHY = '([^']+)'", "Announcement email", "Text"),
]

# Where a string lands in a message. The builders in email-html.js are
# the email's own vocabulary, so they name a row the way a tag names one
# on a page. The nearest call before the string wins, not the first one
# in the statement — a paragraph that contains a link is still a
# paragraph, and the link inside it is still a link.
EMAIL_CALLS = [
    (re.compile(r"\bsubject:\s*$"), "Subject"),
    (re.compile(r"\bpreheader:\s*$"), "Preview line"),
    (re.compile(r"\bheading:\s*$"), "Email heading"),
    (re.compile(r"\btitle:\s*$"), "Email title"),
    (re.compile(r"\bE\.button\($"), "Button"),
    (re.compile(r"\bE\.link\($"), "Link"),
    (re.compile(r"\bE\.label\($"), "Label"),
    (re.compile(r"\bE\.details\(\[?$"), "Label"),
    (re.compile(r"\bE\.paragraph\($"), "Text"),
    (re.compile(r"\bvar text =\s*$|\btext:\s*$"), "Plain-text version"),
    (re.compile(r"\bhtml:\s*$"), "Text"),
]


def braces_from(src, i):
    """The line range of the block whose opening brace follows i."""
    i = src.index("{", i)
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    return src.count("\n", 0, i) + 1, src.count("\n", 0, j) + 1


def find_fn(src, name):
    return re.search(r"^(?:export\s+)?(?:async\s+)?function\s+" + re.escape(name) + r"\b",
                     src, re.M)


def body_of(src, name, inner=None):
    """The line range to read.

    `name` is one function, or a pair meaning everything from the first
    to the end of the second, or None for the whole file. `inner` narrows
    to one object inside the function.
    """
    if name is None:
        return 1, src.count("\n") + 1
    if isinstance(name, tuple):
        a, b = find_fn(src, name[0]), find_fn(src, name[1])
        if not a or not b:
            return None
        return src.count("\n", 0, a.start()) + 1, braces_from(src, b.end())[1]
    m = find_fn(src, name)
    if not m:
        return None
    if inner:
        k = src.find(inner, m.end())
        if k < 0:
            return None
        return braces_from(src, k)
    return braces_from(src, m.end())


def nearest(before, calls, fallback):
    """The nearest builder before the string names the row."""
    tail = before.rstrip()
    tail = tail[:-1] if tail[-1:] in "'\"`" else tail
    best, at = None, -1
    for pat, name in calls:
        for m in pat.finditer(tail):
            if m.start() > at:
                best, at = name, m.start()
    if best:
        return best
    # not at the very end of the statement: take the last builder anywhere
    for pat, name in reversed(calls):
        m = None
        for m in re.finditer(pat.pattern.replace("$", ""), tail):
            pass
        if m and m.start() > at:
            best, at = name, m.start()
    return best or fallback


# ------------------------------------------------------------ the bot
# The Discord bot's words are the site's words too — the slash commands
# Discord lists in its own menu, what the bot answers, and what it posts
# into a channel. The dashboard's own API errors are not here: they are
# a different surface with a different audience.
BOT_SOURCES = [
    # every string in this file is a command or an option Discord shows
    ("tab/src/commands.ts", None, None, "Discord commands", True),
    # the reply builders, from the first command to the router
    ("tab/src/index.ts", ("cmdScore", "runCommand"), None, "Discord replies", False),
    # what the bot says when Discord refuses, and the organiser guards
    ("tab/src/discord.ts", None, None, "Discord replies", False),
    # how an OrgComm message is laid out when it is cross-posted
    ("tab/src/messages.ts", "discordContent", None, "Discord announcements", False),
    # the card Discord draws for a link to one of the site's pages
    ("tab/src/embed.ts", None, None, "Discord link previews", False),
]
BOT_LOOSE = [
    ("tab/src/rego.ts", r"alertOrganisers\([^,]+, *[^,]+, *'([^']+)'",
     "Discord announcements", "Sign-up alert"),
]

BOT_CALLS = [
    (re.compile(r"\bname:\s*$"), "Command name"),
    (re.compile(r"\bdescription:\s*$"), "Command description"),
    (re.compile(r"\bephemeral\($"), "Reply, only you see it"),
    (re.compile(r"\bcontent:\s*$"), "Channel post"),
    (re.compile(r"\bwhy:\s*$"), "Reply"),
]


def read_worker(sources, loose, calls, default, fallback_kind):
    out = []
    for rel, fn, inner, where, liberal in sources:
        path = os.path.join(REPO, rel)
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        span = body_of(src, fn, inner)
        if not span:
            continue
        first, last = span
        lines = src.splitlines()
        for r in scan_js(src, rel, where, liberal=liberal):
            if not (first <= r["line"] <= last):
                continue
            line = lines[r["line"] - 1]
            at = line.find(r["source"])
            before = line[:at] if at > 0 else line
            r["kind"] = nearest(before, calls, fallback_kind)
            r["element"] = default
            out.append(r)
    for rel, pat, where, kind in loose:
        path = os.path.join(REPO, rel)
        if not os.path.exists(path):
            continue
        for i, line in enumerate(open(path, encoding="utf-8"), 1):
            for m in re.finditer(pat, line):
                v = m.group(1)
                if not re.search(r"[A-Za-z]{2}", v):
                    continue
                out.append(dict(file=rel, line=i, where=where, kind=kind,
                                element=default, text=unescape(v), source=v))
    return out


def from_bot():
    return read_worker(BOT_SOURCES, BOT_LOOSE, BOT_CALLS, "discord", "Reply")


def from_email():
    out = []
    for rel, fn, inner, where in EMAIL_SOURCES:
        path = os.path.join(REPO, rel)
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        span = body_of(src, fn, inner)
        if not span:
            continue
        first, last = span
        lines = src.splitlines()
        plain = None
        for i in range(first - 1, min(last, len(lines))):
            if re.search(r"\bvar text =", lines[i]):
                j = i
                while j < last and not lines[j].rstrip().endswith(";"):
                    j += 1
                plain = (i + 1, j + 1)
                break
        for r in scan_js(src, rel, where, liberal=True):
            if not (first <= r["line"] <= last):
                continue
            line = lines[r["line"] - 1]
            at = line.find(r["source"])
            before = line[:at] if at > 0 else line
            kind = r["kind"]
            kind = nearest(before, EMAIL_CALLS,
                           "Text" if kind in ("Script text", "String") else kind)
            if plain and plain[0] <= r["line"] <= plain[1]:
                kind = "Plain-text version"
            r["kind"] = kind
            r["element"] = "email"
            out.append(r)

    for rel, pat, where, kind in EMAIL_LOOSE:
        path = os.path.join(REPO, rel)
        if not os.path.exists(path):
            continue
        for i, line in enumerate(open(path, encoding="utf-8"), 1):
            for m in re.finditer(pat, line):
                v = m.group(1)
                if not re.search(r"[A-Za-z]{2}", v):
                    continue
                out.append(dict(file=rel, line=i, where=where, kind=kind,
                                element="email", text=unescape(v), source=v))
    return out


# ------------------------------------------------------------ manifest
def from_manifest(path, rel):
    import json
    src = open(path, encoding="utf-8").read()
    d, out, where = json.loads(src), [], page_of(rel)

    def place(value):
        m = re.search(r'"' + re.escape(value) + r'"', src)
        line = src.count("\n", 0, m.start()) + 1 if m else 1
        return line

    def add(value, kind):
        out.append(dict(file=rel, line=place(value), where=where, kind=kind,
                        element="manifest", text=value, source=value))

    for k, kind in (("name", "App name"), ("short_name", "App name, short"),
                    ("description", "App description")):
        if d.get(k):
            add(d[k], kind)
    for s in d.get("shortcuts", []):
        for k, kind in (("name", "Shortcut"), ("short_name", "Shortcut, short"),
                        ("description", "Shortcut description")):
            if s.get(k):
                add(s[k], kind)
    return out


# ----------------------------------------------------------------- walk
def skip(rel):
    parts = rel.split("/")
    return (parts[0] in SKIP_DIRS or os.path.dirname(rel) in SKIP_DIRS
            or os.path.basename(rel) in SKIP_FILES)


def collect():
    rows = []
    for root, dirs, files in os.walk(SITE):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for f in sorted(files):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SITE)
            if skip(rel):
                continue
            if f.endswith(".html"):
                rows += from_html(path, rel)
            elif f.endswith(".js"):
                rows += from_js(path, rel)
            elif f == "manifest.webmanifest":
                rows += from_manifest(path, rel)
    rows += from_email()
    rows += from_bot()

    # the same words in the same file can be a heading in one place and
    # a nav label in another, so the kind is part of what makes a row
    seen, final = set(), []
    for r in rows:
        key = (r["file"], r["text"], r["kind"])
        if key in seen:
            continue
        seen.add(key)
        final.append(r)

    # The nav, the settings menu and the footer are written out in every
    # page, so the same words come back sixteen times. One row each,
    # marked as shared: changing it changes it everywhere.
    pages = defaultdict(list)
    for r in final:
        if r["element"] not in ("js", "manifest"):
            pages[(r["text"], r["kind"])].append(r)
    for group in pages.values():
        if len(group) < 3:
            continue
        first = min(group, key=lambda r: (r["file"] != "index.html", r["file"]))
        first["where"] = "On every page"
        first["shared_on"] = len(group)
        for r in group:
            if r is not first:
                r["drop"] = True
    final = [r for r in final if not r.get("drop")]

    final.sort(key=lambda r: (ORDER.index(r["where"]) if r["where"] in ORDER else 99,
                              r["file"], r["line"]))
    for n, r in enumerate(final, 1):
        r["id"] = f"T{n:04d}"
        notes = []
        if r.get("shared_on"):
            notes.append(f"the same words are in {r['shared_on']} pages, "
                         "so an edit here changes all of them")
        if r.get("inline"):
            notes.append("has a link or a bold run inside it, so apply.py "
                         "leaves this one for a hand edit")
        if r["kind"] == "Command name":
            notes.append("this is the word people type after the slash — changing it "
                         "means re-registering the commands with Discord")
        if r["element"] in ("js", "email", "discord") \
           and (r["text"][:1].isspace() or r["text"][-1:].isspace()):
            notes.append("joins onto other text, so keep the spaces at the ends")
        if "\n" in r["text"]:
            notes.append("contains a line break")
        r["notes"] = "; ".join(notes)
        r["new_text"] = ""
    return final


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "site-text.csv")
    final = collect()
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in final:
            w.writerow(r)
    print(f"{len(final)} strings -> {out}")
    for k, c in Counter(r["kind"] for r in final).most_common():
        print(f"  {c:4d}  {k}")
    print()
    for k in ORDER:
        c = sum(1 for r in final if r["where"] == k)
        if c:
            print(f"  {c:4d}  {k}")


if __name__ == "__main__":
    main()
