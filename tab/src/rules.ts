// What a quest takes and how it is counted, beyond its questions:
// `quest_groups.rules`, one JSON column, '' for the defaults.
//
//   files  what proof the submit form takes: which kinds of file, how
//          many, and whether one is needed at all. No kinds is a quest
//          answered with its questions alone.
//   tally  a challenge counted across a team's submissions ("visit the
//          most stations"): what is counted, the points each place
//          earns when the organisers award them, and whether the site
//          shows the standings.
//   partial  read from what was stored before parts had scoring types:
//          the quest took part marks. Its codes are judged now
//          (parts.ts), and nothing stores it any more.
//
// rulesOf always answers a whole object, so a reader never checks for a
// missing part; cleanRules is the only way a stored value is written.
// The kinds of file a quest can take. Photos and videos are what the
// site shows; a GPX track and a PDF are proof for the organisers only,
// since neither has a copy with its metadata taken out.
import { fields } from './shared.ts';
import type { FileKind, QuestRules, TallyKind } from './types.ts';

export var FILE_KINDS: FileKind[] = ['photo', 'video', 'gpx', 'pdf'];
export var DEFAULT_FILE_KINDS: FileKind[] = ['photo', 'video'];
export var DEFAULT_MAX_FILES = 4;
export var MAX_FILES_LIMIT = 20;

// What a challenge counts: the distinct places picked in the quest's
// first pick question, the numbers given to its first count question
// added up or the highest of them, or the accepted submissions
// themselves.
export var TALLY_KINDS: TallyKind[] = ['', 'picks', 'sum', 'highest', 'submissions'];

function isTallyKind(s: string): s is TallyKind {
  return (TALLY_KINDS as string[]).indexOf(s) !== -1;
}
var MAX_AWARDS = 10;
var MAX_AWARD = 100000;

function defaults(): QuestRules {
  return {
    files: { kinds: DEFAULT_FILE_KINDS.slice(), max: DEFAULT_MAX_FILES, required: true },
    tally: { kind: '', awards: [], public: false },
    partial: false
  };
}

function parse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (!raw) return {};
  try { var v = JSON.parse(String(raw)); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch (err) { return {}; }
}

// A stored value read back whole, with every part filled in.
export function rulesOf(raw: unknown): QuestRules {
  var v = parse(raw);
  var out = defaults();
  var f = fields(v.files);
  var kinds = f.kinds;
  if (Array.isArray(kinds)) { var list = kinds; out.files.kinds = FILE_KINDS.filter(function (k) { return list.indexOf(k) !== -1; }); }
  if (isFinite(Number(f.max)) && f.max != null) out.files.max = Math.max(0, Math.min(MAX_FILES_LIMIT, Math.round(Number(f.max))));
  if (f.required != null) out.files.required = !!f.required;
  if (!out.files.kinds.length) { out.files.max = 0; out.files.required = false; }
  if (!out.files.max) out.files.required = false;
  var t = fields(v.tally);
  var kind = String(t.kind || '');
  if (isTallyKind(kind)) out.tally.kind = kind;
  if (Array.isArray(t.awards)) {
    out.tally.awards = t.awards.slice(0, MAX_AWARDS).map(Number).filter(function (n) { return isFinite(n); })
      .map(function (n) { return Math.max(0, Math.min(MAX_AWARD, Math.round(n * 100) / 100)); });
  }
  out.tally.public = !!t.public && !!out.tally.kind;
  out.partial = v.partial === true || v.partial === 1 || v.partial === '1';
  return out;
}

// What the dashboard or a file sent, checked. Answers {rules, error,
// partial}; `rules` is the string to store, '' when everything is the
// default, and `partial` says an older file asked for part marks, which
// makes the quest's codes judged.
export function cleanRules(raw: unknown): { rules: string; partial: boolean } | { error: string } {
  var v = parse(raw);
  var f = fields(v.files);
  if (Array.isArray(f.kinds) && f.kinds.some(function (k) { return (FILE_KINDS as unknown[]).indexOf(k) === -1; })) {
    return { error: 'A quest takes photos, videos, GPX tracks or PDFs.' };
  }
  if (f.max != null && f.max !== '') {
    var max = Number(f.max);
    if (!isFinite(max) || max !== Math.round(max) || max < 0 || max > MAX_FILES_LIMIT) {
      return { error: 'Files per submission must be a whole number from 0 to ' + MAX_FILES_LIMIT + '.' };
    }
  }
  var t = fields(v.tally);
  if (!isTallyKind(String(t.kind || ''))) return { error: 'That is not something a challenge can count.' };
  var awards = t.awards;
  if (typeof awards === 'string') awards = awards.split(/[\s,;]+/).filter(Boolean);
  if (awards != null && !Array.isArray(awards)) return { error: 'Points by place must be a list of numbers.' };
  if (awards && awards.length > MAX_AWARDS) return { error: 'Points by place go to ' + MAX_AWARDS + ' places at most.' };
  if (awards && awards.some(function (n) { var x = Number(n); return !isFinite(x) || x < 0 || x > MAX_AWARD; })) {
    return { error: 'Points by place must be numbers from 0 to ' + MAX_AWARD + '.' };
  }
  var clean = rulesOf({
    files: { kinds: f.kinds, max: f.max === '' ? undefined : f.max, required: f.required },
    tally: { kind: t.kind, awards: awards || [], public: t.public }
  });
  return { rules: isDefault(clean) ? '' : JSON.stringify(clean), partial: rulesOf(v).partial };
}

export function isDefault(rules: QuestRules): boolean {
  return JSON.stringify(rules) === JSON.stringify(defaults());
}

// ---------- files ----------

var EXT_KIND: Record<string, FileKind> = { gpx: 'gpx', pdf: 'pdf' };
// The kind a file is, from its type and, where a browser sends no useful
// type (a GPX track usually arrives as application/octet-stream), its
// name. '' for a file no quest takes.
export function fileKindOf(type: unknown, name?: unknown): FileKind | '' {
  var t = String(type || '').toLowerCase().split(';')[0].trim();
  if (/^image\//.test(t)) return t === 'image/svg+xml' ? '' : 'photo';
  if (/^video\//.test(t)) return 'video';
  if (t === 'application/pdf') return 'pdf';
  if (t === 'application/gpx+xml') return 'gpx';
  var ext = String(name || '').toLowerCase().split('.').pop() || '';
  if ((t === '' || t === 'application/octet-stream' || t === 'application/xml' || t === 'text/xml') && EXT_KIND[ext]) return EXT_KIND[ext];
  return '';
}

// The type a file of that kind is stored and served under.
export function storedTypeFor(kind: string, type: unknown): string {
  if (kind === 'gpx') return 'application/gpx+xml';
  if (kind === 'pdf') return 'application/pdf';
  return String(type || '').toLowerCase().split(';')[0].trim();
}

// The first bytes of a GPX track or a PDF say what it is, the way a
// photo's do. A GPX file is XML whose root is <gpx>.
export function documentMatches(kind: string, bytes: Uint8Array): boolean {
  if (kind === 'pdf') return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
  if (kind === 'gpx') {
    var head = new TextDecoder().decode(bytes.slice(0, 1024)).replace(/^﻿/, '').trim();
    return /^<\?xml[^>]*\?>\s*(<!--[\s\S]*?-->\s*)*<gpx[\s>]/i.test(head) || /^<gpx[\s>]/i.test(head);
  }
  return true;
}

// Words for the kinds a quest takes, for a refusal: "a photo or video".
export function kindsText(kinds: readonly string[]): string {
  var words: Record<string, string> = { photo: 'photo', video: 'video', gpx: 'GPX track', pdf: 'PDF' };
  var list = kinds.map(function (k) { return words[k]; });
  if (!list.length) return 'nothing';
  var last = list.pop();
  return 'a ' + (list.length ? list.join(', ') + ' or ' + last : last);
}
