// Quest groups: the one quest list the tab, the website and the submit
// page all read. A group is what the site shows as a quest (name,
// region, description, pins, answer box); its codes are the rows the
// tab scores (a lead code plus any tiers and bonuses). Codes are the
// reference everything else hangs off, so a rename re-keys the tab
// entries and submissions in one batch and is otherwise left alone.

import { phoneSettings } from './phone.ts';
import { json, corsJson, cleanText, normQuest, randomKey, serveStoredFile, utcStamp, readStamp, animatedType, isLinkPreview, deleteStored, fields, prop, isBlobLike } from './shared.ts';
import { requireTeam, storePreview, bytesMatch, servePublicCopy } from './submit.ts';
import { writeBlock } from './photoserve.ts';
import { baseType } from './strip.ts';
import { bumpCounter, counterValues } from './messages.ts';
import { readStaged, claimStaged, unclaimStaged, releaseStaged } from './staged.ts';
import { rulesOf, cleanRules, isDefault } from './rules.ts';
import { viewerFor, canSee, rowVisibleTo } from './access.ts';
import { QUESTS as SCS2_QUESTS, REGIONS } from './data/scs2-quests.ts';
import { PLACES } from './data/places.ts';
import { ledgerReady, LEDGER_BEHIND, codeRenamed, codeGone, rescoreLines, rebandLines, awardStatements, voidAward, liveAward, awardGiven, awardUndoable, isTaken } from './ledger.ts';
import { partOf, cleanPart, bandsOf, bandsFromText } from './parts.ts';
import { wantsPage, mediaPage, VARY, isMedia } from './sharepage.ts';
import { reservedCode } from './tab.ts';
import { DELETED_CODE, holderStatement, holdStatements } from './deleted.ts';
import type { Ask, AudienceRow, AudienceTeamRow, Band, ConsoleSession, ConsoleUserRow, DashCode, DashGroup, Env, JsonBody, LogAction, Pin,
  PublicCode, PublicGroup, QuestAudienceRow, QuestFileRow, QuestGroupRow, QuestGroupTagRow, QuestListPayload, QuestRegionRow, QuestResponseRow,
  QuestRow, QuestRules, QuestTagRow, Question, Refusal, Scoring, TallyKind, TeamRow, Viewer } from './types.ts';
import type { CleanPart, Part, PartRow } from './parts.ts';
import type { PublicQuest } from './sharepage.ts';
import type { StagedFile } from './staged.ts';

// A pin as sent, before it is checked.
interface PinIn {
  label?: unknown;
  lat?: unknown;
  lng?: unknown;
}

// The question columns of a quest (askFromRow).
type AskRead = Pick<QuestGroupRow, 'ask_kind' | 'ask_prompt' | 'ask_options' | 'ask_open' | 'ask_open_until'>;
// A quest's search tags as typed: split on commas and line breaks,
// each tidied and kept once, at most twenty of forty letters. Stored
// joined by ", ".
export function cleanKeywords(raw: unknown): string {
  var text = Array.isArray(raw) ? raw.join(',') : String(raw == null ? '' : raw);
  var seen: Record<string, boolean> = {};
  var out: string[] = [];
  text.split(/[,\n]+/).forEach(function (w) {
    var word = cleanText(w, 40).toLowerCase();
    if (!word || seen[word] || out.length >= 20) return;
    seen[word] = true;
    out.push(word);
  });
  return out.join(', ');
}
function keywordList(stored: unknown): string[] {
  return String(stored || '').split(', ').filter(Boolean);
}

// The columns every read of a whole quest takes (GROUP_COLS).
type GroupRead = Pick<QuestGroupRow, 'id' | 'key' | 'name' | 'region' | 'description' | 'flavour' | 'keywords' | 'location' | 'coords' |
  'submit_kind' | 'prompt' | 'options' | 'sort' | 'hidden' | 'visibility' | 'opens_at' | 'mystery' | 'questions' | 'rules' |
  'ask_reveal' | 'ask_reveal_live'> & AskRead;
// A quest as the ask endpoints find it.
type VisibleGroup = Pick<QuestGroupRow, 'id' | 'key' | 'hidden' | 'visibility'> & AskRead;

// What the dashboard or a file sent for one quest, checked (cleanGroup).
interface CleanGroup {
  error: string;
  // null leaves what is stored
  keywords: string | null;
  questions: Question[];
  rules: string | null;
  partial: boolean;
  key: string;
  name: string;
  region: string;
  description: string;
  flavour: string;
  location: string;
  coords: Pin[];
  submit: string;
  prompt: string;
  options: string[];
  sort: number;
  hidden: number;
}

// A region as read, and as the dashboard lists it.
type RegionRead = Pick<QuestRegionRow, 'id' | 'name' | 'sort' | 'colour'>;
interface RegionOut {
  id: number;
  name: string;
  sort: number;
  colour: string;
  quests: number;
}
interface TagOut {
  id: number;
  name: string;
  dash_hidden: number;
  sort: number;
  quests: number;
}
interface AudienceOut {
  id: number;
  name: string;
  team_ids: number[];
}

// Every quest as the dashboard reads it (allGroups).
export interface AllGroups {
  regions: RegionOut[];
  groups: DashGroup[];
  loose: DashCode[];
  unplaced: number;
  tags: TagOut[];
  audiences: AudienceOut[];
}

// A code as the quests table holds it (codeRows).
type CodeRead = PartRow & Pick<QuestRow, 'group_id' | 'sort'>;
// What a code is written with (renameStatements, upsertGroup).
interface CodeFields {
  points: number;
  group_id?: number | null;
  label: string;
  sort: number;
  hidden: number;
  scoring?: string;
  most?: number | null;
  bands?: string;
}
// One code of a save, checked, before anything is written.
type CodeNow = Pick<QuestRow, 'code' | 'group_id' | 'points' | 'scoring' | 'most' | 'bands'>;
interface Plan {
  code: string;
  current: CodeNow | null;
  was: Part | null;
  fields: CodeFields & { scoring: Scoring; most: number | null; bands: string };
}

// A quest on its way from the dashboard's shape to the public one:
// questListPayload cuts it down in place.
type Shaping = Partial<Omit<DashGroup, 'codes' | 'ask' | 'mystery' | 'rules'>> & {
  codes: DashCode[] | PublicCode[];
  ask: Ask | null;
  mystery?: number | true;
  phone?: { number: string };
  rules?: { files: QuestRules['files']; tally: { kind: TallyKind; awards: (number | null)[]; public: boolean }; partial: boolean };
};

// A quest as the export writes it, and one read from an import file
// before it is checked.
type RecordCode = { code: string; label: string; points: number; hidden: number; scoring?: Scoring; most?: number; bands?: Band[] };
type QuestRecord = {
  code: string; name: string; region: string; description: string; flavour: string; location: string; pins: Pin[];
  answer: string; prompt: string; options: unknown[]; questions: Question[]; rules: QuestRules | ''; order: number; hidden: number; codes: RecordCode[];
  keywords: string;
};
type FileCode = { code: unknown; label?: unknown; points?: unknown; hidden?: unknown; scoring?: unknown; most?: unknown; bands?: unknown };
interface FileRecord {
  code: unknown;
  name: unknown;
  region: unknown;
  description: unknown;
  flavour: unknown;
  location: unknown;
  pins: unknown;
  answer: unknown;
  prompt: unknown;
  options: unknown;
  questions: unknown;
  order: unknown;
  hidden: unknown;
  rules?: unknown;
  keywords?: unknown;
  codes: FileCode[];
}
// One row of what an import would do.
interface PlanLine {
  line: number;
  key: string;
  name: string;
  status: string;
  detail: string;
}

// A question's answers counted per option, and what teams see of them.
interface Tally {
  choice: unknown;
  teams: number;
  points: number;
  mine?: boolean;
}
interface AskResults {
  total: number;
  counts?: Tally[];
  winner?: string;
  answers?: { team: string; choice: string; amount: number; mine?: boolean }[];
}
// A wager's settlement.
interface Settled {
  winner: string;
  at: string;
  by: string;
  undoable: boolean;
  id?: number;
}
// Who can see a quest and when it opens, checked (cleanAccess).
interface Access {
  who: string;
  audiences: number[];
  opens_at: string;
  sentAudiences: boolean;
}

export var SUBMIT_KINDS = ['none', 'count', 'text', 'pick', 'choice', 'codes'];
var RETIRED = '-o';

// What a quest asks on the submit form, as a list: each question is a
// count, a line of text, places picked from a list, one answer out of
// a few (choice), or which of the quest's codes were done. The first
// one also lives in submit_kind / prompt / options, which is all a
// page from before the list reads; `questions` holds the whole list. Ticking codes is what review credits, so it can only be
// asked once and always comes first.
export var MAX_QUESTIONS = 8;
var MAX_CHOICES = 12;

// A quest can also ask every team something while it is running: press
// one of a few buttons (choice), enter a number nobody else sees
// (number), pick a side and stake points on it (wager), or type an
// answer (text). '' is a quest that asks nothing, which is most of
// them. The columns live on the group; the answers live in
// quest_responses, one row per team.
export var ASK_KINDS = ['', 'choice', 'number', 'wager', 'text'];
// What teams see of everyone's answers: '' only their own, 'tally' how
// many picked each option, 'answers' every team's answer. Shown once
// the question closes, or while it is open too when reveal_live is on.
export var ASK_REVEALS = ['', 'tally', 'answers'];
var MAX_ASK_OPTIONS = 8;
var MAX_ASK_OPTION = 60;
var MAX_ASK_PROMPT = 200;
var MAX_ASK_TEXT = 200;
var MAX_ASK_AMOUNT = 100000;

// Files hung on a quest by the organisers, in the proof bucket under
// their own prefix.
var MAX_QUEST_FILES = 8;
var MAX_QUEST_FILE_BYTES = 25 * 1024 * 1024;
var MAX_THUMB_BYTES = 300 * 1024;   // a browser-made preview, not a photo
var QUEST_PICTURES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
var FOREVER = 'public, max-age=31536000, immutable';
var NO_STORE = { 'cache-control': 'no-store' };

// ---------- field cleaning ----------

// [{label, lat, lng}] from an array or a "Label @ lat, lng | …" string
// Pins as JSON, or as text: one a line (the dashboard's Map pins box) or
// split by | (the CSV), each "Label @ lat, lng", or a bare "lat, lng".
export function parseCoords(raw: unknown): Pin[] {
  var list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (err) {
      list = raw.split(/\r?\n|\|/).map(function (part) {
        var at = part.lastIndexOf('@');
        var c = part.slice(at + 1).split(',');
        if (c.length !== 2) return null;
        return { label: at === -1 ? '' : part.slice(0, at), lat: c[0], lng: c[1] };
      });
    }
  }
  if (!Array.isArray(list)) return [];
  var out: Pin[] = [];
  list.forEach(function (p) {
    if (!p) return;
    unfold(p as PinIn).forEach(function (q) {
      var lat = Number(q.lat);
      var lng = Number(q.lng);
      if (String(q.lat).trim() === '' || String(q.lng).trim() === '') return;
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      out.push({ label: cleanText(q.label, 80), lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 });
    });
  });
  return out.slice(0, 40);
}
// A pin saved while the Map pins box's lines were read as one: the pins
// before it are in its label ("The Star @ -33.8677, 151.195 Crown
// Sydney"), and they come back out as pins of their own.
var FOLDED = /\s*([^@]*?)\s*@\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?=\s|$)/g;
function unfold(p: PinIn): PinIn[] {
  var label = String(p.label == null ? '' : p.label);
  if (label.indexOf('@') === -1) return [p];
  var pins: PinIn[] = [];
  var end = 0;
  var m: RegExpExecArray | null;
  FOLDED.lastIndex = 0;
  while ((m = FOLDED.exec(label))) {
    pins.push({ label: m[1], lat: m[2], lng: m[3] });
    end = FOLDED.lastIndex;
  }
  if (!pins.length) return [p];
  pins.push({ label: label.slice(end), lat: p.lat, lng: p.lng });
  return pins;
}

// options as an array or one per line; @stations and @sushi stand for
// the built-in lists
export function parseOptions(raw: unknown): string[] {
  var list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/\r?\n/);
  return list.map(function (o) { return cleanText(o, 120); }).filter(Boolean).slice(0, 300);
}

// [{kind, prompt, options}] from what the dashboard or a file sent.
// A list or pick-one question with nothing to choose from is refused,
// with `error` saying which; `lenient` keeps it, for the single answer
// box of a page or a file from before the list.
export function cleanQuestions(raw: unknown, lenient?: boolean): { questions: Question[] } | { error: string } {
  var list: unknown = raw;
  if (typeof list === 'string') {
    try { list = list.trim() ? JSON.parse(list) : []; } catch (err) { return { error: 'The questions are not valid JSON.' }; }
  }
  if (!Array.isArray(list)) return { questions: [] };
  var out: Question[] = [];
  var codes: Question | null = null;
  for (var i = 0; i < list.length && out.length + (codes ? 1 : 0) < MAX_QUESTIONS; i++) {
    var q = fields(list[i]);
    var kind = String(q.kind || q.submit || '');
    if (SUBMIT_KINDS.indexOf(kind) === -1 || kind === 'none') continue;
    var one: Question = { kind: kind, prompt: cleanText(q.prompt, 120), options: [] };
    if (kind === 'pick') one.options = parseOptions(q.options);
    if (kind === 'choice') {
      one.options = parseOptions(q.options).filter(function (o) { return o.charAt(0) !== '@'; }).slice(0, MAX_CHOICES);
    }
    if ((kind === 'pick' || kind === 'choice') && !one.options.length && !lenient) {
      return { error: 'Question ' + (i + 1) + (one.prompt ? ' (' + one.prompt + ')' : '') + ' needs options to choose from.' };
    }
    if (kind === 'codes') { if (!codes) codes = one; continue; }
    out.push(one);
  }
  return { questions: codes ? [codes].concat(out) : out };
}

function cleanGroup(body: JsonBody): CleanGroup {
  var asked = body.questions != null ? cleanQuestions(body.questions) : null;
  var questions: Question[];
  if (asked && !('error' in asked)) questions = asked.questions;
  else {
    var only = String(body.submit || 'none');
    // lenient never refuses
    questions = (cleanQuestions(only === 'none' ? [] : [{ kind: only, prompt: body.prompt, options: body.options }], true) as { questions: Question[] }).questions;
  }
  var first = questions[0] || { kind: 'none', prompt: '', options: [] };
  // what the submit form takes and how a challenge counts (rules.ts);
  // null leaves what is stored, so a page or file that sends none of it
  // cannot reset it
  var ruled = body.rules != null ? cleanRules(body.rules) : null;
  return {
    keywords: body.keywords != null ? cleanKeywords(body.keywords) : null,
    error: asked && 'error' in asked ? asked.error : ruled && 'error' in ruled ? ruled.error : '',
    questions: questions,
    rules: ruled && !('error' in ruled) ? ruled.rules : null,
    // an older file's part marks: the quest's codes are judged
    partial: !!(ruled && 'partial' in ruled && ruled.partial),
    key: cleanText(body.key, 40),
    name: cleanText(body.name, 120),
    region: cleanText(body.region, 60),
    description: String(body.description == null ? '' : body.description).replace(/\r\n/g, '\n').slice(0, 6000).trim(),
    flavour: cleanText(body.flavour, 300),
    location: cleanText(body.location, 200),
    coords: parseCoords(body.coords),
    submit: first.kind,
    prompt: first.prompt,
    options: first.options,
    sort: Number(body.sort) || 0,
    hidden: body.hidden ? 1 : 0
  };
}

// The question a quest asks, read off its row. Options are stored as
// JSON; a row written before the ask columns existed reads as a quest
// that asks nothing.
//
// A deadline closes the question by itself: `open` is the switch AND
// the time, worked out on every read rather than written at the
// deadline, so nothing has to be running when it passes. Every reader
// goes through here, so they cannot disagree about whether it is open.
function askFromRow(r: AskRead): Ask {
  var parsed: unknown = [];
  try { parsed = JSON.parse(r.ask_options || '[]'); } catch (err) { parsed = []; }
  var options = Array.isArray(parsed) ? parsed : [];
  var until = r.ask_open_until || '';
  return {
    kind: r.ask_kind || '',
    prompt: r.ask_prompt || '',
    options: options,
    open: !!r.ask_open && (!until || utcStamp() < until),
    open_until: until
  };
}

// button labels from an array or one per line
function parseAskOptions(raw: unknown): string[] {
  var list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/\r?\n/);
  return list.map(function (o) { return cleanText(o, MAX_ASK_OPTION); }).filter(Boolean);
}

// the list as stored, or the one question the older columns hold
export function questionsOf(r: Pick<QuestGroupRow, 'submit_kind'> & { prompt?: string }, options: string[], stored: unknown): Question[] {
  // a stored list is what cleanQuestions wrote
  if (Array.isArray(stored) && stored.length) return stored as Question[];
  if (!r.submit_kind || r.submit_kind === 'none') return [];
  return [{ kind: r.submit_kind, prompt: r.prompt || '', options: options }];
}

function rowToGroup(r: GroupRead): DashGroup {
  var coords: Pin[] = [];
  var options: string[] = [];
  var ask = askFromRow(r);
  // what teams see of the other answers, and whether while it is open
  ask.reveal = r.ask_reveal || '';
  ask.reveal_live = !!r.ask_reveal && !!r.ask_reveal_live;
  // through the parser, so a pin folded by the old save reads as the pins
  // it was
  try { coords = parseCoords(JSON.parse(r.coords || '[]')); } catch (err) { coords = []; }
  try { options = JSON.parse(r.options || '[]') as string[]; } catch (err) { options = []; }
  return {
    id: r.id, key: r.key, name: r.name, region: r.region, description: r.description,
    keywords: keywordList(r.keywords),
    flavour: r.flavour, location: r.location, coords: coords, submit: r.submit_kind,
    prompt: r.prompt, options: options, questions: questionsOf(r, options, storedList(r.questions)), sort: r.sort, hidden: r.hidden,
    visibility: r.visibility || 'everyone', opens_at: r.opens_at || '',
    ask: ask, files: [], codes: [], tags: [], audiences: [],
    mystery: r.mystery === 1 ? 1 : 0, rules: rulesOf(r.rules)
  };
}

// A quest's question list as stored: '' and a list that cannot be read
// are the one question in the older columns.
function storedList(questions: string): unknown {
  if (!questions) return null;
  try { return JSON.parse(questions); } catch (err) { return null; }
}

// ---------- reads ----------

var GROUP_COLS = 'id, key, name, region, description, flavour, keywords, location, coords, submit_kind, prompt, options, sort, hidden, ' +
  'ask_kind, ask_prompt, ask_options, ask_open, ask_open_until, visibility, opens_at, mystery, questions, rules, ask_reveal, ask_reveal_live';

// Every quest's files in one query, handed to the groups that are
// already in memory — never a query per quest.
async function attachGroupFiles(db: D1Database, byId: Record<number, DashGroup>): Promise<void> {
  var rows = await db.prepare('SELECT group_id, key, name, type, bytes FROM quest_files ORDER BY sort, id').all<Pick<QuestFileRow, 'group_id' | 'key' | 'name' | 'type' | 'bytes'>>();
  rows.results.forEach(function (f) {
    var g = byId[f.group_id];
    if (g) g.files.push({ key: f.key, name: f.name, type: f.type, bytes: f.bytes });
  });
}

// The questions each of these quests asks, by id, as the submit form
// asks them.
export async function questionsByGroup(db: D1Database, ids: number[]): Promise<Record<string, Question[]>> {
  var out: Record<string, Question[]> = {};
  if (!ids.length) return out;
  var rows = (await db.prepare(
    'SELECT id, submit_kind, prompt, options, questions FROM quest_groups WHERE id IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(ids)).all<Pick<QuestGroupRow, 'id' | 'submit_kind' | 'prompt' | 'options' | 'questions'>>()).results;
  rows.forEach(function (r) {
    var options: string[] = [];
    try { options = JSON.parse(r.options || '[]') as string[]; } catch (err) { options = []; }
    out[r.id] = questionsOf(r, options, storedList(r.questions));
  });
  return out;
}

// Each group's rules, by id, as stored, for the groups that have any.
export async function storedRules(db: D1Database): Promise<Record<number, string>> {
  var byId: Record<number, string> = {};
  (await db.prepare("SELECT id, rules FROM quest_groups WHERE rules != ''").all<Pick<QuestGroupRow, 'id' | 'rules'>>()).results.forEach(function (r) {
    byId[r.id] = r.rules;
  });
  return byId;
}

// What one quest takes and counts: its group's rules, or the defaults
// for a loose code or an unknown one.
export async function rulesForGroup(db: D1Database, groupId: number | null | undefined): Promise<QuestRules> {
  if (!groupId) return rulesOf('');
  var row = await db.prepare('SELECT rules FROM quest_groups WHERE id = ?1').bind(groupId).first<Pick<QuestGroupRow, 'rules'>>();
  return rulesOf(row && row.rules);
}

// The quests whose points are a mystery, by id.
export async function mysteryIds(db: D1Database): Promise<Record<string, boolean>> {
  var ids: Record<string, boolean> = {};
  (await db.prepare('SELECT id FROM quest_groups WHERE mystery = 1').all<Pick<QuestGroupRow, 'id'>>()).results.forEach(function (r) { ids[r.id] = true; });
  return ids;
}

// ---------- regions ----------
// The regions (the site's categories) in display order. A group names
// its region by text; the quest_regions table holds the order and
// lets a region exist before it has quests. Any region a group names
// that the table lacks is added at the end, so the two never drift.
// The line colours a region can take (the site's --line-* tokens);
// none is red, as every region was before.
export var ROUTE_COLOURS = ['red', 'orange', 'yellow', 'green', 'blue', 'lime', 'purple', 'brown', 'grey', 'sky'];

// the regions with their colours
async function readRegions(db: D1Database): Promise<RegionRead[]> {
  return (await db.prepare('SELECT id, name, sort, colour FROM quest_regions ORDER BY sort, id').all<RegionRead>()).results;
}

export async function regionRows(db: D1Database): Promise<RegionRead[]> {
  var rows = await readRegions(db);
  var known: Record<string, boolean> = {};
  rows.forEach(function (r) { known[r.name.toUpperCase()] = true; });
  var missing = (await db.prepare("SELECT DISTINCT region FROM quest_groups WHERE region != '' ORDER BY sort, id").all<Pick<QuestGroupRow, 'region'>>()).results
    .filter(function (r) { return !known[r.region.toUpperCase()]; });
  if (missing.length) {
    var next = rows.length ? rows[rows.length - 1].sort + 1 : 1;
    await db.batch(missing.map(function (r, i) {
      return db.prepare('INSERT INTO quest_regions (name, sort) VALUES (?1, ?2)').bind(r.region, next + i);
    }));
    rows = await readRegions(db);
  }
  return rows;
}

// sorts groups by region order, then their own sort; no region last
function orderGroups<G extends { region: string; sort: number; id: number }>(groups: G[], regions: { name: string }[]): G[] {
  var rank: Record<string, number> = {};
  regions.forEach(function (r, i) { rank[r.name.toUpperCase()] = i; });
  var last = regions.length;
  function rankOf(g: G): number { var r = rank[(g.region || '').toUpperCase()]; return g.region && r != null ? r : last; }
  return groups.slice().sort(function (a, b) {
    return (rankOf(a) - rankOf(b)) || (a.sort - b.sort) || (a.id - b.id);
  });
}

// Each quest's tags and team groups as id lists, and the two lists
// themselves with how many quests each holds.
async function attachAccess(db: D1Database, byId: Record<number, DashGroup>): Promise<{ tags: TagOut[]; audiences: AudienceOut[] }> {
  var tags = (await db.prepare('SELECT id, name, dash_hidden, sort FROM quest_tags ORDER BY sort, name COLLATE NOCASE').all<Pick<QuestTagRow, 'id' | 'name' | 'dash_hidden' | 'sort'>>()).results;
  var audiences = (await db.prepare('SELECT id, name FROM audiences ORDER BY name COLLATE NOCASE').all<Pick<AudienceRow, 'id' | 'name'>>()).results;
  var count: Record<number, number> = {};
  (await db.prepare('SELECT group_id, tag_id FROM quest_group_tags').all<QuestGroupTagRow>()).results.forEach(function (r) {
    var g = byId[r.group_id];
    if (!g) return;
    g.tags.push(r.tag_id);
    count[r.tag_id] = (count[r.tag_id] || 0) + 1;
  });
  await attachAudiences(db, byId);
  var members: Record<number, number[]> = {};
  (await db.prepare('SELECT audience_id, team_id FROM audience_teams').all<AudienceTeamRow>()).results.forEach(function (r) {
    (members[r.audience_id] = members[r.audience_id] || []).push(r.team_id);
  });
  return {
    tags: tags.map(function (t) { return { id: t.id, name: t.name, dash_hidden: t.dash_hidden ? 1 : 0, sort: t.sort, quests: count[t.id] || 0 }; }),
    audiences: audiences.map(function (a) { return { id: a.id, name: a.name, team_ids: members[a.id] || [] }; })
  };
}

// The team groups each quest is shown to, as id lists: what canSee
// reads for a quest shown to team groups.
async function attachAudiences(db: D1Database, byId: Record<number, DashGroup>): Promise<void> {
  (await db.prepare('SELECT group_id, audience_id FROM quest_audiences').all<QuestAudienceRow>()).results.forEach(function (r) {
    var g = byId[r.group_id];
    if (g) g.audiences.push(r.audience_id);
  });
}

// Every code with its scoring type.
function codeRows(db: D1Database): Promise<D1Result<CodeRead>> {
  return db.prepare('SELECT code, group_id, label, points, sort, hidden, scoring, most, bands FROM quests ORDER BY sort, code').all<CodeRead>();
}

// Every group with its codes, hidden included (the console's view),
// the regions with their quest counts, plus the codes that belong to
// no group.
export function allGroups(db: D1Database): Promise<AllGroups> {
  return readGroups(db, 'all');
}

// The same for one reader. `access` is how much of who can see a quest
// is read: 'all' is the dashboard's, each quest's tags and team groups
// and the two lists; 'viewer' is a signed-in team's, the team groups of
// the quests shown to some, which is all canSee asks for, with no tags
// and empty lists; 'none' is the public's, for whom hidden and
// visibility on the quest's own row decide it. One read of quest_groups
// in every case.
async function readGroups(db: D1Database, access: 'all' | 'viewer' | 'none'): Promise<AllGroups> {
  var regions = await regionRows(db);
  var groups = orderGroups((await db.prepare('SELECT ' + GROUP_COLS + ' FROM quest_groups').all<GroupRead>()).results.map(rowToGroup), regions);
  var counts: Record<string, number> = {};
  groups.forEach(function (g) { var k = (g.region || '').toUpperCase(); counts[k] = (counts[k] || 0) + 1; });
  var listed: RegionOut[] = regions.map(function (r) { return { id: r.id, name: r.name, sort: r.sort, colour: r.colour || '', quests: counts[r.name.toUpperCase()] || 0 }; });
  var byId: Record<number, DashGroup> = {};
  groups.forEach(function (g) { byId[g.id] = g; });
  var loose: DashCode[] = [];
  var codes = await codeRows(db);
  codes.results.forEach(function (c) {
    var part = partOf(c);
    var row: DashCode = { code: c.code, label: c.label || '', points: c.points, sort: c.sort, hidden: c.hidden,
      scoring: part.scoring, most: part.most, bands: part.bands };
    if (c.group_id && byId[c.group_id]) byId[c.group_id].codes.push(row);
    else loose.push(row);
  });
  await attachGroupFiles(db, byId);
  var lists: { tags: TagOut[]; audiences: AudienceOut[] } = { tags: [], audiences: [] };
  if (access === 'all') lists = await attachAccess(db, byId);
  else if (access === 'viewer' && groups.some(function (g) { return !g.hidden && g.visibility === 'groups'; })) await attachAudiences(db, byId);
  return { regions: listed, groups: groups, loose: loose, unplaced: counts[''] || 0, tags: lists.tags, audiences: lists.audiences };
}

// The list one viewer may see: null for the public, or a team (from
// viewerFor). Visible groups with their visible codes, in region order
// (regions without a visible quest are left out; quests without a
// region come last under ''), with the place lists the answer boxes
// draw on. Each group carries the files hung on it and the question it
// asks, or null when it asks nothing. `more` says whether there are
// quests a signed-in team might see that this viewer cannot — never
// how many or which.
export async function questListPayload(db: D1Database, viewer: Viewer): Promise<QuestListPayload> {
  await releaseDue(db);
  // the quests counter as the list is built: a device keeps it with its
  // copy and asks again only once the pulse has moved past it. Read
  // first, so a write landing part way through makes the copy newer
  // than its number, never older.
  var version = (await counterValues(db)).quests;
  // who else can see a quest, its tags and the lists of both are cut from
  // this payload below, so only what decides this viewer's list is read
  var all = await readGroups(db, viewer ? 'viewer' : 'none');
  // the quest scored by calls from payphones, while calls are taken
  var phone = await phoneSettings(db);
  var regions: string[] = [];
  var groups: PublicGroup[] = [];
  var more = false;
  all.groups.forEach(function (dash) {
    if (!canSee(dash, viewer)) {
      if (!dash.hidden && !viewer) more = true;
      return;
    }
    var codes = dash.codes.filter(function (c) { return !c.hidden; });
    if (!codes.length) return;
    var g = dash as Shaping;
    delete g.id;
    // a mystery quest's points stay with the tab: the site shows ???,
    // for its bands and its places as much as for its codes
    g.codes = codes.map(function (c) {
      var out: PublicCode = { code: c.code, label: c.label, points: g.mystery ? null : c.points };
      if (c.scoring) out.scoring = c.scoring;
      if (c.scoring === 'unit' && c.most != null) out.most = c.most;
      if (c.bands && c.bands.length) {
        out.bands = c.bands.map(function (b) { return { from: b.from, points: g.mystery ? null : b.points }; });
      }
      return out;
    });
    if (phone.open && phone.code && codes.some(function (c) { return c.code === phone.code; })) g.phone = { number: phone.number };
    if (g.mystery && g.rules && g.rules.tally) g.rules.tally.awards = g.rules.tally.awards.map(function () { return null; });
    if (g.mystery) g.mystery = true; else delete g.mystery;
    // Only an OPEN question rides the public list. A question written
    // ahead of the moment it is asked is a secret until then, and this
    // payload is readable by anyone — the sheet asks /api/quest/ask
    // for the rest (a team that answered can still see a closed one).
    g.ask = (dash.ask.kind && dash.ask.open) ? dash.ask : null;
    // what it shows of the answers comes with the answers, from there
    if (g.ask) { delete g.ask.reveal; delete g.ask.reveal_live; }
    delete g.hidden;
    delete g.sort;
    // who else can see it is the organisers' business
    delete g.visibility;
    delete g.opens_at;
    delete g.tags;
    delete g.audiences;
    if (g.region && regions.indexOf(g.region) === -1) regions.push(g.region);
    groups.push(g as PublicGroup);
  });
  // each region's line colour, where one was picked (the quest sheet's
  // disc and rule; red otherwise)
  var colours: Record<string, string> = {};
  all.regions.forEach(function (r) { if (r.colour) colours[r.name] = r.colour; });
  return { version: version, regions: regions, groups: groups, places: PLACES, more: more, region_colours: colours };
}

// The public list publicQuest reads, kept in this worker instance for
// up to a minute and built again as soon as the quests' version moves
// (every dashboard quest write moves it, as does a quest opening at its
// time). A shared file's page asks for one quest, and building the
// whole list for each page was most of the work of drawing one. The
// objects are shared between callers, so nothing may change them.
var publicMemo: { at: number; version: number; list: QuestListPayload | null } = { at: 0, version: -1, list: null };
async function publicListFor(db: D1Database): Promise<QuestListPayload> {
  var version = (await counterValues(db)).quests;
  if (publicMemo.list && publicMemo.version === version && Date.now() - publicMemo.at < 60000) return publicMemo.list;
  var list = await questListPayload(db, null);
  publicMemo = { at: Date.now(), version: version, list: list };
  return list;
}

// One quest as the public list shows it, found by any of its codes or
// its key, with `code` the one asked for; null when the public cannot
// see it. Built from the public list so a quest kept from it, a hidden
// code and a mystery quest's points stay kept here too.
export async function publicQuest(db: D1Database, code: unknown): Promise<PublicQuest | null> {
  var norm = normQuest(code == null ? '' : code);
  if (!norm) return null;
  var list = await publicListFor(db);
  for (var i = 0; i < list.groups.length; i++) {
    var g = list.groups[i];
    var hit = g.codes.filter(function (c) { return normQuest(c.code) === norm; })[0];
    if (hit || normQuest(g.key) === norm) {
      return Object.assign({}, g, { code: hit || g.codes[0], colour: list.region_colours[g.region] || '' });
    }
  }
  return null;
}

// adds a region (no id) or renames one (id); a rename follows through
// to every quest in it
export async function saveRegion(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var name = cleanText(body.name, 60);
  if (!name) return json({ error: 'The region needs a name.' }, 400);
  var id = Number(body.id) || 0;
  var clash = await db.prepare('SELECT id FROM quest_regions WHERE name = ?1 COLLATE NOCASE AND id != ?2').bind(name, id).first();
  if (clash) return json({ error: 'There is already a region called ' + name + '.' }, 409);
  if (id) {
    var cur = await db.prepare('SELECT id, name FROM quest_regions WHERE id = ?1').bind(id).first<Pick<QuestRegionRow, 'id' | 'name'>>();
    if (!cur) return json({ error: 'no such region' }, 404);
    await db.batch([
      db.prepare('UPDATE quest_regions SET name = ?2 WHERE id = ?1').bind(id, name),
      db.prepare('UPDATE quest_groups SET region = ?2 WHERE region = ?1 COLLATE NOCASE').bind(cur.name, name)
    ]);
    await logAction(db, session.name, 'region-rename', cur.name + ' → ' + name, '-', 0, 0, 0);
  } else {
    var last = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM quest_regions').first<{ n: number }>() as { n: number };
    await db.prepare('INSERT INTO quest_regions (name, sort) VALUES (?1, ?2)').bind(name, last.n + 1).run();
    await logAction(db, session.name, 'region-add', name, '-', 0, 0, 0);
  }
  return json({ ok: true, regions: (await allGroups(db)).regions });
}

// removes a region; its quests move to another region (`to`) or to
// no region at all
export async function deleteRegion(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var cur = await db.prepare('SELECT id, name FROM quest_regions WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestRegionRow, 'id' | 'name'>>();
  if (!cur) return json({ error: 'no such region' }, 404);
  var to = cleanText(body.to, 60);
  if (to) {
    var target = await db.prepare('SELECT name FROM quest_regions WHERE name = ?1 COLLATE NOCASE AND id != ?2').bind(to, cur.id).first<Pick<QuestRegionRow, 'name'>>();
    if (!target) return json({ error: 'No region called ' + to + ' to move the quests to.' }, 400);
    to = target.name;
  }
  var moved = await db.prepare('SELECT COUNT(*) AS n FROM quest_groups WHERE region = ?1 COLLATE NOCASE').bind(cur.name).first<{ n: number }>() as { n: number };
  await db.batch([
    db.prepare('UPDATE quest_groups SET region = ?2 WHERE region = ?1 COLLATE NOCASE').bind(cur.name, to),
    db.prepare('DELETE FROM quest_regions WHERE id = ?1').bind(cur.id)
  ]);
  await logAction(db, session.name, 'region-delete', cur.name + (to ? ' → ' + to : ''), moved.n + ' quests', 0, 0, 0);
  return json({ ok: true, moved: moved.n, regions: (await allGroups(db)).regions });
}

// the full order, as ids
// A region's line colour on the site's quest sheet.
export async function setRegionColour(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var colour = String(body.colour || '');
  if (colour && ROUTE_COLOURS.indexOf(colour) === -1) return json({ error: 'Pick one of the line colours.' }, 400);
  var cur = await db.prepare('SELECT id, name FROM quest_regions WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestRegionRow, 'id' | 'name'>>();
  if (!cur) return json({ error: 'no such region' }, 404);
  await db.prepare('UPDATE quest_regions SET colour = ?2 WHERE id = ?1').bind(cur.id, colour).run();
  await logAction(db, session.name, 'region-colour', cur.name, colour || 'red', 0, 0, 0);
  return json({ ok: true, name: cur.name, colour: colour, regions: (await allGroups(db)).regions });
}

export async function orderRegions(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(function (n) { return n > 0; }) : [];
  if (!ids.length) return json({ error: 'Send the regions in order.' }, 400);
  await db.batch(ids.map(function (id, i) {
    return db.prepare('UPDATE quest_regions SET sort = ?2 WHERE id = ?1').bind(id, i + 1);
  }));
  await logAction(db, session.name, 'region-order', ids.length + ' regions', '-', 0, 0, 0);
  return json({ ok: true, regions: (await allGroups(db)).regions });
}

// One region's quests in the order sent (`ids`, every one of them in
// `region`, '' for the quests with no region). The region's quests left
// out of the list (the dashboard leaves out those under a tag it is
// hiding) follow them in the order they had, so the region always ends
// up numbered 1..n. Answers what GET quests answers.
export async function orderRegionQuests(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var region = cleanText(body.region, 60);
  var ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!ids.length || ids.some(function (n) { return !(n > 0) || Math.floor(n) !== n; })) {
    return json({ error: 'Send the quests in order.' }, 400);
  }
  var listed: Record<number, boolean> = {};
  for (var i = 0; i < ids.length; i++) {
    if (listed[ids[i]]) return json({ error: 'A quest is in the list twice.' }, 400);
    listed[ids[i]] = true;
  }
  var mine = (await db.prepare('SELECT id FROM quest_groups WHERE region = ?1 COLLATE NOCASE ORDER BY sort, id')
    .bind(region).all<Pick<QuestGroupRow, 'id'>>()).results;
  var inRegion: Record<number, boolean> = {};
  mine.forEach(function (g) { inRegion[g.id] = true; });
  var stray = ids.filter(function (id) { return !inRegion[id]; })[0];
  if (stray) {
    var other = await db.prepare('SELECT key, region FROM quest_groups WHERE id = ?1').bind(stray).first<Pick<QuestGroupRow, 'key' | 'region'>>();
    if (!other) return json({ error: 'no such quest' }, 404);
    return json({ error: region ? other.key + ' is not in ' + region + '.' : other.key + ' is in ' + other.region + '.' }, 409);
  }
  var order = ids.concat(mine.map(function (g) { return g.id; }).filter(function (id) { return !listed[id]; }));
  await db.batch(order.map(function (id, n) {
    return db.prepare('UPDATE quest_groups SET sort = ?2 WHERE id = ?1').bind(id, n + 1);
  }));
  await logAction(db, session.name, 'quest-order', region || 'No region', ids.length + ' quests', 0, 0, 0);
  return json(Object.assign({ ok: true }, await allGroups(db)));
}

// ---------- writes ----------

// A code rename re-keys everything that points at the code: the new
// row goes in first (under a temporary norm so a same-norm rename never
// trips the unique index), the tab entries and submissions move over,
// the old row goes, then the norm settles. Returns the statements.
export function renameStatements(db: D1Database, oldCode: string, newCode: string, fields: CodeFields, ledger: boolean): D1PreparedStatement[] {
  var norm = normQuest(newCode);
  return (ledger ? codeRenamed(db, oldCode, newCode) : []).concat([
    db.prepare('INSERT INTO quests (code, norm, points, group_id, label, sort, hidden, scoring, most, bands) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
      .bind(newCode, norm + '~RENAME', fields.points, fields.group_id, fields.label, fields.sort, fields.hidden,
        fields.scoring || '', fields.most == null ? null : fields.most, fields.bands || ''),
    // the old copy of the tab, held to its foreign key on the code
    db.prepare('UPDATE completions SET quest_code = ?2 WHERE quest_code = ?1').bind(oldCode, newCode),
    db.prepare('UPDATE submissions SET quest_code = ?2 WHERE quest_code = ?1').bind(oldCode, newCode)
  ].concat(namedCodeStatements(db, oldCode, newCode), [
    db.prepare('DELETE FROM quests WHERE code = ?1').bind(oldCode),
    db.prepare('UPDATE quests SET norm = ?2 WHERE code = ?1').bind(newCode, norm)
  ]));
}

// A code renamed wherever stored JSON names it. A code inside JSON is the
// code as a JSON string, quotes and all, so renaming CQ1 cannot touch
// CQ11.
function namedCodeStatements(db: D1Database, oldCode: string, newCode: string): D1PreparedStatement[] {
  var was = JSON.stringify(oldCode);
  var now = JSON.stringify(newCode);
  return [
    // what each submission credited: its codes, and its counts' and part
    // marks' keys. Take back, Change, Reject and the receipt read these
    db.prepare('UPDATE submissions SET credit = REPLACE(credit, ?1, ?2) WHERE instr(credit, ?1) > 0').bind(was, now),
    // the codes a team ticked in its answer, and only those: the rest of
    // an answer is what somebody typed
    db.prepare(
      "UPDATE submissions SET answer = json_set(answer, '$.value', json((SELECT json_group_array(CASE WHEN j.value = ?1 THEN ?2 ELSE j.value END) " +
      "FROM json_each(submissions.answer, '$.value') AS j))) " +
      "WHERE instr(answer, ?3) > 0 AND json_valid(answer) AND json_extract(answer, '$.kind') = 'codes'"
    ).bind(oldCode, newCode, was),
    // an award by place and a wager settlement keep the code they paid on
    db.prepare('UPDATE quest_groups SET tally_settled = REPLACE(tally_settled, ?1, ?2) WHERE instr(tally_settled, ?1) > 0').bind(was, now),
    db.prepare('UPDATE quest_groups SET ask_settled = REPLACE(ask_settled, ?1, ?2) WHERE instr(ask_settled, ?1) > 0').bind(was, now)
  ];
}

// An account limited to some quests names them by key, so a quest whose
// key changes is renamed in those lists too, or the account would lose
// the quest without anyone touching it.
export async function renameInScopes(db: D1Database, oldKey: string, newKey: string): Promise<void> {
  var rows = await scopeLists(db);
  var writes: D1PreparedStatement[] = [];
  rows.forEach(function (r) {
    var keys = String(r.quests).split(',');
    if (keys.indexOf(oldKey) === -1) return;
    var next: string[] = [];
    keys.forEach(function (k) {
      var key = k === oldKey ? newKey : k;
      if (next.indexOf(key) === -1) next.push(key);
    });
    writes.push(db.prepare('UPDATE console_users SET quests = ?2 WHERE name = ?1').bind(r.name, next.join(',')));
  });
  if (writes.length) await db.batch(writes);
}

// Every account limited to some quests, with its list.
async function scopeLists(db: D1Database): Promise<Pick<ConsoleUserRow, 'name' | 'quests' | 'admin'>[]> {
  return (await db.prepare("SELECT name, quests, admin FROM console_users WHERE quests != ''").all<Pick<ConsoleUserRow, 'name' | 'quests' | 'admin'>>()).results;
}

// A deleted quest's key comes out of every account's list, so a quest
// given the key later is not handed to an account nobody gave it to.
// An account whose list held that key alone is `stranded`: its list
// cannot be left empty, which reads as every quest, so the delete waits
// until an admin gives it another quest. An admin's list is ignored, and
// may be emptied. `writes` take the key out of the rest, each only from
// the list it was read with.
export async function dropFromScopes(db: D1Database, key: string): Promise<{ stranded: string[]; writes: D1PreparedStatement[] }> {
  var stranded: string[] = [];
  var writes: D1PreparedStatement[] = [];
  (await scopeLists(db)).forEach(function (r) {
    var keys = String(r.quests).split(',');
    if (keys.indexOf(key) === -1) return;
    var next = keys.filter(function (k) { return k && k !== key; });
    if (!next.length && !r.admin) { stranded.push(r.name); return; }
    writes.push(db.prepare('UPDATE console_users SET quests = ?2 WHERE name = ?1 AND quests = ?3').bind(r.name, next.join(','), r.quests));
  });
  return { stranded: stranded, writes: writes };
}

export function strandedRefusal(names: string[]): string {
  var many = names.length > 1;
  return 'The account' + (many ? 's ' : ' ') + names.join(', ') + (many ? ' score' : ' scores') +
    ' this quest and no other. Give ' + (many ? 'them' : 'it') + ' another quest on the Accounts tab first.';
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (var i = 0; i < statements.length; i += 40) {
    await db.batch(statements.slice(i, i + 40));
  }
}

// The same, for statements in runs that must land together (a code's
// new points and the lines re-scored at them): a run is never split
// between two batches.
async function runGroups(db: D1Database, groups: D1PreparedStatement[][]): Promise<void> {
  var batch: D1PreparedStatement[] = [];
  for (var i = 0; i < groups.length; i++) {
    if (batch.length && batch.length + groups[i].length > 40) {
      await db.batch(batch);
      batch = [];
    }
    batch = batch.concat(groups[i]);
  }
  if (batch.length) await db.batch(batch);
}

// Creates or updates one group and the codes sent with it, each a part
// with its scoring type (parts.ts). Codes are matched by `was` (the code
// as it was before this edit); a changed code renames, a missing `was`
// adds. A row that sends no `scoring` keeps the code's type (an older
// file asking for part marks makes it judged). Codes are never removed
// here: that is the typed-confirm delete. Resolves {error, status} or
// {id, added, renamed}.
async function upsertGroup(db: D1Database, g: CleanGroup, rows: unknown[], id: number, by: string): Promise<{ error: string; status: number } | { id: number; added: number; renamed: number }> {
  var kept = reservedCode(g.key);
  if (kept) return { error: kept, status: 400 };
  var clash = await db.prepare('SELECT id FROM quest_groups WHERE key = ?1 COLLATE NOCASE AND id != ?2').bind(g.key, id).first();
  if (clash) return { error: 'Another quest already uses the code ' + g.key + '.', status: 409 };
  var cols = 'code, group_id, points, scoring, most, bands';
  // the quest's points by place, which a counted part's top is worked
  // out with, and what its challenge counts
  var stored = id ? await db.prepare('SELECT rules FROM quest_groups WHERE id = ?1').bind(id).first<Pick<QuestGroupRow, 'rules'>>() : null;
  var rules = rulesOf(g.rules != null ? g.rules : stored && stored.rules);
  // every code is checked before anything is written
  var seen: Record<string, boolean> = {};
  var plans: Plan[] = [];
  var counted = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = fields(rows[i]);
    var code = cleanText(r.code, 40);
    if (!code) return { error: 'Every code row needs a code.', status: 400 };
    var norm = normQuest(code);
    if (seen[norm]) return { error: code + ' appears twice.', status: 400 };
    seen[norm] = true;
    var was = cleanText(r.was, 40);
    var current = was ? await db.prepare('SELECT ' + cols + ' FROM quests WHERE code = ?1').bind(was).first<CodeNow>() : null;
    if (!current) current = await db.prepare('SELECT ' + cols + ' FROM quests WHERE norm = ?1').bind(norm).first<CodeNow>();
    if (current && current.group_id && current.group_id !== id) {
      var owner = await db.prepare('SELECT key FROM quest_groups WHERE id = ?1').bind(current.group_id).first<Pick<QuestGroupRow, 'key'>>();
      return { error: 'The code ' + code + ' belongs to ' + (owner ? owner.key : 'another quest') + '.', status: 409 };
    }
    // a kept code may be renamed away from a quest that already holds it,
    // and is never taken
    var reserved = reservedCode(code) || (current && current.group_id !== id ? reservedCode(current.code) : '');
    if (reserved) return { error: reserved, status: 400 };
    var taken = await db.prepare('SELECT code FROM quests WHERE norm = ?1 AND code != ?2').bind(norm, current ? current.code : '').first<Pick<QuestRow, 'code'>>();
    if (taken) return { error: 'The code ' + code + ' already exists as ' + taken.code + '.', status: 409 };
    var wasPart = current ? partOf(current) : null;
    var asked = r.scoring != null ? r : {
      code: code, points: r.points,
      scoring: g.partial ? 'judged' : wasPart ? wasPart.scoring : '',
      most: r.most != null ? r.most : wasPart ? wasPart.most : null,
      bands: r.bands != null ? r.bands : wasPart ? wasPart.bands : ''
    };
    var part = cleanPart(Object.assign({}, asked, { code: code, points: r.points }), rules.tally.awards);
    if ('error' in part) return { error: part.error, status: 400 };
    // a line on a tiered or counted part is worth what its band gave, not
    // units times points, so the lines a code holds cannot be read again
    // under the other kind of scoring
    if (current && wasPart && crossesBands(wasPart.scoring, part.scoring)) {
      var holding = await teamsHolding(db, current.code);
      if (holding) return { error: heldRefusal(current.code, holding), status: 409 };
    }
    if (part.scoring === 'counted') counted++;
    plans.push({ code: code, current: current, was: wasPart, fields: {
      points: part.points, label: cleanText(r.label, 80), sort: Number(r.sort) || i, hidden: r.hidden ? 1 : 0,
      scoring: part.scoring, most: part.most, bands: part.bands
    } });
  }
  // the quest's codes this save leaves out keep their stored types
  if (id) {
    var sent: Record<string, boolean> = {};
    plans.forEach(function (p) { if (p.current) sent[p.current.code] = true; });
    (await db.prepare('SELECT code, scoring FROM quests WHERE group_id = ?1').bind(id).all<Pick<QuestRow, 'code' | 'scoring'>>()).results
      .forEach(function (q) { if (!sent[q.code] && q.scoring === 'counted') counted++; });
  }
  if (counted > 1) return { error: 'A quest counts one thing across the day, so only one of its parts can be counted.', status: 400 };
  if (counted && !rules.tally.kind) {
    return { error: 'A counted part needs the quest to say what it counts, under its challenge.', status: 400 };
  }
  // new points re-score every team holding the code, on the ledger, and
  // so do a tiered code's new bands
  var ledger = await ledgerReady(db);
  var rescored = plans.some(function (p) {
    return p.current && (Number(p.current.points) !== p.fields.points || rebanded(p));
  });
  if (rescored && !ledger) return { error: LEDGER_BEHIND, status: 503 };

  var values = [g.key, g.name, g.region, g.description, g.flavour, g.location, JSON.stringify(g.coords),
    g.submit, g.prompt, JSON.stringify(g.options), g.sort, g.hidden];
  if (id) {
    var existing = await db.prepare('SELECT id, key FROM quest_groups WHERE id = ?1').bind(id).first<Pick<QuestGroupRow, 'id' | 'key'>>();
    if (!existing) return { error: 'no such quest', status: 404 };
    // Who can see a quest is set on its own (setGroupAccess), like its
    // question and its files, so a save or a re-import can never open
    // or close one: hidden is only read from the body for a new quest.
    var upd = db.prepare(
      'UPDATE quest_groups SET key = ?1, name = ?2, region = ?3, description = ?4, flavour = ?5, location = ?6, ' +
      'coords = ?7, submit_kind = ?8, prompt = ?9, options = ?10, sort = ?11 WHERE id = ?12'
    );
    await upd.bind.apply(upd, values.slice(0, 11).concat([id])).run();
    if (existing.key !== g.key) await renameInScopes(db, existing.key, g.key);
  } else {
    var insStmt = db.prepare(
      'INSERT INTO quest_groups (key, name, region, description, flavour, location, coords, submit_kind, prompt, options, sort, hidden) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
    );
    var ins = await insStmt.bind.apply(insStmt, values).run();
    id = ins.meta && ins.meta.last_row_id;
  }
  // the whole list where there is more than one; one fits the older columns
  await db.prepare('UPDATE quest_groups SET questions = ?2 WHERE id = ?1')
    .bind(id, g.questions.length > 1 ? JSON.stringify(g.questions) : '').run();
  if (g.rules != null) {
    await db.prepare('UPDATE quest_groups SET rules = ?2 WHERE id = ?1').bind(id, g.rules).run();
  }
  if (g.keywords != null) {
    await db.prepare('UPDATE quest_groups SET keywords = ?2 WHERE id = ?1').bind(id, g.keywords).run();
  }
  if (g.region) await regionRows(db); // a new region name joins the table

  var runs: D1PreparedStatement[][] = [];
  var added = 0;
  var renamed = 0;
  plans.forEach(function (p) {
    var f = p.fields;
    f.group_id = id;
    var after = ledger ? rescoreLines(db, p.code, p.current && p.current.points, f.points, by)
      .concat(rebanded(p) ? rebandLines(db, p.code, by) : []) : [];
    if (p.current && p.current.code !== p.code) {
      runs.push(renameStatements(db, p.current.code, p.code, f, ledger).concat(after));
      renamed++;
    } else if (p.current) {
      runs.push([
        db.prepare('UPDATE quests SET points = ?2, group_id = ?3, label = ?4, sort = ?5, hidden = ?6, scoring = ?7, most = ?8, bands = ?9 WHERE code = ?1')
          .bind(p.code, f.points, f.group_id, f.label, f.sort, f.hidden, f.scoring, f.most, f.bands)
      ].concat(after));
    } else {
      runs.push([
        db.prepare('INSERT INTO quests (code, norm, points, group_id, label, sort, hidden, scoring, most, bands) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
          .bind(p.code, normQuest(p.code), f.points, f.group_id, f.label, f.sort, f.hidden, f.scoring, f.most, f.bands)
      ]);
      added++;
    }
  });
  if (runs.length) await runGroups(db, runs);
  return { id: id, added: added, renamed: renamed };
}

// A code's scoring moving into or out of tiered or counted, or from one
// to the other.
function crossesBands(was: string, now: string): boolean {
  var byBands = function (s: string) { return s === 'tiered' || s === 'counted'; };
  return (was || '') !== (now || '') && (byBands(was) || byBands(now));
}

// How many teams have the code on the tab.
async function teamsHolding(db: D1Database, code: string): Promise<number> {
  var row = await db.prepare('SELECT COUNT(*) AS n FROM held WHERE quest_code = ?1').bind(code).first<{ n: number }>();
  return row ? Number(row.n) || 0 : 0;
}

function heldRefusal(code: string, n: number): string {
  return code + ' is on the tab for ' + n + ' team' + (n === 1 ? '' : 's') +
    ', so its scoring cannot change to or from tiered or counted. Add a new code for the new scoring instead.';
}

// A tiered code that stays tiered with different bands: its lines are
// worked out again from the numbers they reached.
function rebanded(p: Plan): boolean {
  return !!(p.was && p.was.scoring === 'tiered' && p.fields.scoring === 'tiered' &&
    JSON.stringify(p.was.bands) !== JSON.stringify(bandsOf(p.fields.bands)));
}

export async function saveGroup(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var g = cleanGroup(body);
  if (g.error) return json({ error: g.error }, 400);
  if (!g.key) return json({ error: 'The quest needs a code.' }, 400);
  if (!g.name) return json({ error: 'The quest needs a name.' }, 400);
  var rows = Array.isArray(body.codes) ? body.codes : [];
  var res = await upsertGroup(db, g, rows, Number(body.id) || 0, session.name);
  if ('error' in res) return json({ error: res.error }, res.status);
  var savedId = res.id;
  // Written here rather than in upsertGroup, so a file import leaves it
  // as it was.
  if ('mystery' in body) {
    await db.prepare('UPDATE quest_groups SET mystery = ?2 WHERE id = ?1').bind(res.id, body.mystery ? 1 : 0).run();
  }
  await logAction(db, session.name, 'quest-save', g.key, rows.length + ' code' + (rows.length === 1 ? '' : 's') +
    (res.added ? ', ' + res.added + ' new' : '') + (res.renamed ? ', ' + res.renamed + ' renamed' : ''), 0, 0, 0);
  var saved = (await allGroups(db)).groups.filter(function (x) { return x.id === savedId; })[0];
  return json({ ok: true, group: saved });
}

// Deletes a group, its codes and their tab entries. Type the key. What
// the quest leaves behind moves to the holder of deleted quests
// (deleted.ts), so its codes are free for a new quest that starts with
// nothing; its files stay, marked with its key.
export async function deleteGroup(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var g = await db.prepare('SELECT id, key FROM quest_groups WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestGroupRow, 'id' | 'key'>>();
  if (!g) return json({ error: 'no such quest' }, 404);
  var codes = (await db.prepare('SELECT code FROM quests WHERE group_id = ?1').bind(g.id).all<Pick<QuestRow, 'code'>>()).results;
  var used = codes.length
    ? (await db.prepare('SELECT COUNT(*) AS n FROM held WHERE quest_code IN (SELECT code FROM quests WHERE group_id = ?1)').bind(g.id).first<{ n: number }>() as { n: number }).n
    : 0;
  var scopes = await dropFromScopes(db, g.key);
  if (scopes.stranded.length) return json({ error: strandedRefusal(scopes.stranded) }, 409);
  if (String(body.confirm || '') !== g.key) {
    return json({
      error: (used ? 'This quest has ' + used + ' tab entr' + (used === 1 ? 'y' : 'ies') + ' across its codes. ' : '') +
        'Type ' + g.key + ' exactly to delete it' + (used ? ' and those entries.' : '.')
    }, 428);
  }
  var ledger = await ledgerReady(db);
  // each code's statements land in one batch: its lines voided, then
  // moved with its submissions, then the code itself
  var runs: D1PreparedStatement[][] = ledger ? [[holderStatement(db)]] : [];
  codes.forEach(function (c) {
    runs.push((ledger ? codeGone(db, c.code, session.name).concat(holdStatements(db, c.code)) : []).concat([
      // the old copy of the tab, held to its foreign key on the code
      db.prepare('DELETE FROM completions WHERE quest_code = ?1').bind(c.code),
      db.prepare('DELETE FROM quests WHERE code = ?1').bind(c.code)
    ]));
  });
  runs.push([
    db.prepare('UPDATE quest_files SET deleted_key = ?2 WHERE group_id = ?1').bind(g.id, g.key),
    db.prepare('DELETE FROM quest_group_tags WHERE group_id = ?1').bind(g.id),
    db.prepare('DELETE FROM quest_audiences WHERE group_id = ?1').bind(g.id),
    db.prepare('DELETE FROM quest_groups WHERE id = ?1').bind(g.id)
  ].concat(scopes.writes));
  await runGroups(db, runs);
  await logAction(db, session.name, 'quest-group-delete', g.key, codes.length + ' codes, ' + used + ' entries', 0, 0, 0);
  return json({ ok: true });
}

// Retires every quest currently on the tab: each code becomes code-o,
// hidden from every public read, scores intact. Groups go hidden too.
// Codes already ending in -o are left alone, so it is safe to re-run.
export async function retireAll(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (String(body.confirm || '') !== 'RETIRE') {
    return json({ error: 'Type RETIRE to confirm.' }, 428);
  }
  // the holder of deleted quests is no quest, and keeps its code
  var live = (await codeRows(db)).results.filter(function (c) { return c.code.slice(-RETIRED.length) !== RETIRED && c.code !== DELETED_CODE; });
  var ledger = await ledgerReady(db);
  var runs = live.map(function (c) {
    return renameStatements(db, c.code, c.code + RETIRED,
      { points: c.points, group_id: c.group_id, label: c.label || '', sort: c.sort || 0, hidden: 1,
        scoring: c.scoring || '', most: c.most, bands: c.bands || '' }, ledger);
  });
  var stmts: D1PreparedStatement[] = [];
  stmts.push(db.prepare('UPDATE quest_groups SET hidden = 1, opens_at = \'\''));
  // a retired group keeps its key clear for the new list
  stmts.push(db.prepare("UPDATE quest_groups SET key = key || ?1 WHERE key NOT LIKE '%' || ?1").bind(RETIRED));
  // and goes under Old, out of the dashboard's way
  stmts.push(db.prepare("INSERT OR IGNORE INTO quest_tags (name, dash_hidden, sort) VALUES ('Old', 1, 0)"));
  stmts.push(db.prepare("INSERT OR IGNORE INTO quest_group_tags (group_id, tag_id) SELECT g.id, t.id FROM quest_groups g JOIN quest_tags t ON t.name = 'Old'"));
  await runGroups(db, runs.concat([stmts]));
  await logAction(db, session.name, 'quests-retire', live.length + ' codes', '-', 0, 0, 0);
  return json({ ok: true, retired: live.length });
}

// Loads the SCS.2 list from src/data/scs2-quests.ts: groups whose key
// or codes already exist are skipped, so it is safe to re-run after a
// partial import.
export async function importScs2(env: Env, session: ConsoleSession, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var existingKeys: Record<string, boolean> = {};
  (await db.prepare('SELECT key FROM quest_groups').all<Pick<QuestGroupRow, 'key'>>()).results.forEach(function (r) { existingKeys[r.key.toUpperCase()] = true; });
  var existingNorms: Record<string, boolean> = {};
  (await db.prepare('SELECT norm FROM quests').all<Pick<QuestRow, 'norm'>>()).results.forEach(function (r) { existingNorms[r.norm] = true; });
  var added = 0;
  var skipped: string[] = [];
  var maxSort = (await db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM quest_groups').first<{ n: number }>() as { n: number }).n;
  var have: Record<string, boolean> = {};
  (await regionRows(db)).forEach(function (r) { have[r.name.toUpperCase()] = true; });
  var lastSort = (await db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM quest_regions').first<{ n: number }>() as { n: number }).n;
  var newRegions = REGIONS.filter(function (name) { return !have[name.toUpperCase()]; });
  if (newRegions.length) {
    await db.batch(newRegions.map(function (name, i) {
      return db.prepare('INSERT INTO quest_regions (name, sort) VALUES (?1, ?2)').bind(name, lastSort + i + 1);
    }));
  }
  for (var i = 0; i < SCS2_QUESTS.length; i++) {
    var g = SCS2_QUESTS[i];
    var clash = existingKeys[g.key.toUpperCase()] || g.codes.some(function (c) { return existingNorms[normQuest(c.code)]; });
    if (clash) { skipped.push(g.key); continue; }
    var ins = await db.prepare(
      'INSERT INTO quest_groups (key, name, region, description, flavour, location, coords, submit_kind, prompt, options, sort, hidden) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)'
    ).bind(g.key, g.name, g.region, g.description, g.flavour, g.location, JSON.stringify(g.coords),
      g.submit, g.prompt, JSON.stringify(g.options), maxSort + i + 1).run();
    var gid = ins.meta && ins.meta.last_row_id;
    var ruled = g.rules ? cleanRules(g.rules) : null;
    if (ruled && !('error' in ruled) && ruled.rules) await db.prepare('UPDATE quest_groups SET rules = ?2 WHERE id = ?1').bind(gid, ruled.rules).run();
    var places = rulesOf(ruled && !('error' in ruled) ? ruled.rules : null).tally.awards;
    await db.batch(g.codes.map(function (c, j) {
      existingNorms[normQuest(c.code)] = true;
      // the list that ships with the worker is valid
      var part = cleanPart({ code: c.code, points: c.points, scoring: c.scoring || '', most: c.most, bands: c.bands || '' }, places) as CleanPart;
      return db.prepare('INSERT INTO quests (code, norm, points, group_id, label, sort, hidden, scoring, most, bands) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)')
        .bind(c.code, normQuest(c.code), part.points, gid, c.label, j, part.scoring || '', part.most, part.bands || '');
    }));
    existingKeys[g.key.toUpperCase()] = true;
    added++;
  }
  await logAction(db, session.name, 'quests-import', added + ' quests', '-', 0, 0, 0);
  return json({ ok: true, added: added, skipped: skipped, regions: REGIONS });
}

// ---------- file export and import ----------
// One row per quest. CSV for spreadsheets (multi-line cells for the
// codes, pins and options), JSON for a lossless copy. Import matches
// quests by code: new ones are added, existing ones updated in every
// field, codes matched by code and never removed.

// questions last, so a sheet laid out before it still lines up
var CSV_COLUMNS = ['code', 'name', 'region', 'description', 'flavour', 'location', 'pins', 'answer', 'prompt', 'options', 'order', 'hidden', 'codes', 'questions', 'rules', 'keywords'];

function csvCell(v: unknown): string {
  var t = String(v == null ? '' : v);
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export function parseCsv(text: string): string[][] {
  var rows: string[][] = [];
  var row: string[] = [];
  var field = '';
  var inQuotes = false;
  text = String(text || '').replace(/^\ufeff/, '');
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function groupToRecord(g: DashGroup): QuestRecord {
  return {
    code: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour,
    keywords: g.keywords.join(', '),
    location: g.location, pins: g.coords, answer: g.submit, prompt: g.prompt, options: g.options,
    questions: g.questions.length > 1 ? g.questions : [],
    // allGroups gives every quest its rules
    rules: isDefault(g.rules as QuestRules) ? '' : g.rules as QuestRules,
    order: g.sort, hidden: g.hidden ? 1 : 0,
    codes: g.codes.map(function (c) {
      var out: RecordCode = { code: c.code, label: c.label, points: c.points, hidden: c.hidden ? 1 : 0 };
      if (c.scoring) out.scoring = c.scoring;
      if (c.most != null) out.most = c.most;
      if (c.bands && c.bands.length) out.bands = c.bands;
      return out;
    })
  };
}

// A code's line in the CSV's codes cell: code | label | points, then
// "hidden" or nothing, then how it scores, its most and its bands, each
// only as far as there is something to say.
function codeCell(c: RecordCode): string {
  var cells = [c.code, c.label, c.points, c.hidden ? 'hidden' : '', c.scoring || '',
    c.most != null ? c.most : '', (c.bands || []).map(function (b) { return b.from + ': ' + b.points; }).join(', ')];
  while (cells.length > 3 && cells[cells.length - 1] === '') cells.pop();
  return cells.join(' | ');
}

// `everyone` keeps the quests anyone can see now, the way the public
// list decides it (canSee with no viewer), each with only its codes that
// are not hidden: the same file the full export writes, so it imports
// back the same way.
export async function exportQuests(db: D1Database, format: string, everyone: boolean): Promise<{ body: string; type: string; ext: string }> {
  var all = await allGroups(db);
  var groups = all.groups;
  if (everyone) {
    groups = groups.filter(function (g) { return canSee(g, null); }).map(function (g) {
      return Object.assign({}, g, { codes: g.codes.filter(function (c) { return !c.hidden; }) });
    }).filter(function (g) { return g.codes.length; });
  }
  var records = groups.map(groupToRecord);
  if (format === 'json') {
    return { body: JSON.stringify({ regions: all.regions.map(function (r) { return r.name; }), quests: records }, null, 2), type: 'application/json', ext: 'json' };
  }
  var lines = [CSV_COLUMNS.join(',')];
  records.forEach(function (r) {
    lines.push(CSV_COLUMNS.map(function (col) {
      var v: unknown = r[col as keyof QuestRecord];
      if (col === 'pins') v = r.pins.map(function (p) { return p.label + ' @ ' + p.lat + ', ' + p.lng; }).join('\n');
      else if (col === 'options') v = r.options.join('\n');
      else if (col === 'questions') v = r.questions.length ? JSON.stringify(r.questions) : '';
      else if (col === 'rules') v = r.rules ? JSON.stringify(r.rules) : '';
      else if (col === 'codes') v = r.codes.map(codeCell).join('\n');
      return csvCell(v);
    }).join(','));
  });
  return { body: lines.join('\r\n') + '\r\n', type: 'text/csv', ext: 'csv' };
}

// records from JSON ({quests: [...]}, or a bare list) or CSV text
function parseRecords(text: unknown): { error: string } | { records: FileRecord[]; regions: unknown[] } {
  var t = String(text || '').trim();
  if (!t) return { error: 'The file is empty.' };
  if (t[0] === '{' || t[0] === '[') {
    var data: unknown;
    try { data = JSON.parse(t); } catch (err) { return { error: 'That is not valid JSON.' }; }
    var wrapped = prop(data, 'quests');
    var list = Array.isArray(data) ? data : (Array.isArray(wrapped) ? wrapped : null);
    if (!list) return { error: 'Expected {"quests": [...]}.' };
    var named = prop(data, 'regions');
    return { records: list.map(function (item) {
      var r = fields(item);
      var codes = Array.isArray(r.codes) ? r.codes : [];
      return {
        code: r.code != null ? r.code : r.key, name: r.name, region: r.region, description: r.description, flavour: r.flavour,
        location: r.location, pins: r.pins != null ? r.pins : r.coords, answer: r.answer != null ? r.answer : r.submit, prompt: r.prompt,
        options: r.options, questions: r.questions, order: r.order != null ? r.order : r.sort, hidden: r.hidden,
        rules: 'rules' in r ? (r.rules || '') : undefined,
        keywords: 'keywords' in r ? (r.keywords || '') : undefined,
        codes: codes.map(function (c) {
          var x = c as FileCode;
          return { code: x.code, label: x.label, points: x.points, hidden: x.hidden, scoring: x.scoring, most: x.most, bands: x.bands };
        })
      };
    }), regions: Array.isArray(named) ? named : [] };
  }
  var rows = parseCsv(t);
  if (rows.length < 2) return { error: 'The CSV needs a header row and at least one quest.' };
  var col: Record<string, number> = {};
  rows[0].forEach(function (name, i) { col[String(name).trim().toLowerCase()] = i; });
  if (col.code == null && col.key != null) col.code = col.key;
  if (col.code == null || col.name == null) return { error: 'The CSV needs code and name columns.' };
  var cell = function (row: string[], name: string) { var i = col[name]; return i == null ? '' : (row[i] || ''); };
  var records = rows.slice(1).map(function (row) {
    var codes = cell(row, 'codes').split(/\r?\n/).map(function (line): FileCode | null {
      var parts = line.split('|').map(function (x) { return x.trim(); });
      if (!parts[0]) return null;
      return {
        code: parts[0], label: parts[1] || '', points: parts[2], hidden: /^hidden$/i.test(parts[3] || '') ? 1 : 0,
        scoring: parts.length > 4 ? scoringFromText(parts[4]) : undefined,
        most: parts[5] ? parts[5] : undefined,
        bands: parts[6] ? bandsFromText(parts[6]) : undefined
      };
    }).filter(function (c): c is FileCode { return !!c; });
    return {
      code: cell(row, 'code'), name: cell(row, 'name'), region: cell(row, 'region'), description: cell(row, 'description'),
      flavour: cell(row, 'flavour'), location: cell(row, 'location'), pins: cell(row, 'pins').split(/\r?\n/).join('|'),
      answer: cell(row, 'answer'), prompt: cell(row, 'prompt'), options: cell(row, 'options'), questions: cell(row, 'questions'),
      rules: col.rules == null ? undefined : cell(row, 'rules'),
      keywords: col.keywords == null ? undefined : cell(row, 'keywords'),
      order: cell(row, 'order'), hidden: /^(1|yes|true|hidden)$/i.test(cell(row, 'hidden').trim()) ? 1 : 0, codes: codes
    };
  });
  return { records: records, regions: [] };
}

// "Per unit", "per-unit" or "unit" as the stored word; anything not a
// type passes through for cleanPart to refuse.
function scoringFromText(t: unknown): string {
  var w = String(t || '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
  if (!w || w === 'fixed') return '';
  if (w === 'per unit' || w === 'unit') return 'unit';
  return w;
}

// a file's questions column wins when it lists any; otherwise its one
// answer box is the list
function recordToGroup(r: FileRecord): CleanGroup {
  var listed = cleanQuestions(r.questions);
  return cleanGroup({
    key: r.code, name: r.name, region: r.region, description: r.description, flavour: r.flavour, location: r.location,
    coords: r.pins, submit: r.answer, prompt: r.prompt, options: r.options, sort: r.order, hidden: r.hidden,
    questions: 'questions' in listed && listed.questions.length ? listed.questions : undefined,
    rules: r.rules,
    keywords: r.keywords
  });
}

// What an import would do, row by row: add / update / same / error.
async function importPlan(db: D1Database, text: unknown): Promise<{ error: string } | { rows: PlanLine[]; records: FileRecord[]; regions: unknown[] }> {
  var parsed = parseRecords(text);
  if ('error' in parsed) return parsed;
  var all = await allGroups(db);
  var byKey: Record<string, DashGroup> = {};
  all.groups.forEach(function (g) { byKey[g.key.toUpperCase()] = g; });
  var codeOwner: Record<string, string> = {};
  all.groups.forEach(function (g) { g.codes.forEach(function (c) { codeOwner[normQuest(c.code)] = g.key; }); });
  all.loose.forEach(function (c) { codeOwner[normQuest(c.code)] = ''; });
  // how many teams hold each code, for a scoring type that would move
  // into or out of tiered or counted
  var holding: Record<string, number> = {};
  (await db.prepare('SELECT quest_code AS code, COUNT(*) AS n FROM held GROUP BY quest_code').all<{ code: string; n: number }>()).results
    .forEach(function (h) { holding[h.code] = Number(h.n) || 0; });
  var seen: Record<string, boolean> = {};
  var seenCodes: Record<string, string> = {};
  var rows = parsed.records.map(function (r, i) {
    var g = recordToGroup(r);
    var line: PlanLine = { line: i + 1, key: g.key, name: g.name, status: 'same', detail: '' };
    if (!g.key) return Object.assign(line, { status: 'error', detail: 'no code' });
    if (!g.name) return Object.assign(line, { status: 'error', detail: 'no name' });
    if (reservedCode(g.key)) return Object.assign(line, { status: 'error', detail: reservedCode(g.key) });
    if (seen[g.key.toUpperCase()]) return Object.assign(line, { status: 'error', detail: 'listed twice' });
    seen[g.key.toUpperCase()] = true;
    var codes: FileCode[] = Array.isArray(r.codes) ? r.codes : [];
    if (!codes.length) codes = [{ code: g.key, label: '', points: 0 }];
    for (var j = 0; j < codes.length; j++) {
      var c = codes[j];
      var code = cleanText(c.code, 40);
      if (!code) return Object.assign(line, { status: 'error', detail: 'a code row has no code' });
      if (reservedCode(code)) return Object.assign(line, { status: 'error', detail: reservedCode(code) });
      if (c.scoring != null) {
        var part = cleanPart(Object.assign({}, c, { code: code }), rulesOf(g.rules).tally.awards);
        if ('error' in part) return Object.assign(line, { status: 'error', detail: part.error });
      } else if (!isFinite(Number(c.points))) return Object.assign(line, { status: 'error', detail: code + ' has no points' });
      var n = normQuest(code);
      if (seenCodes[n]) return Object.assign(line, { status: 'error', detail: code + ' is also on ' + seenCodes[n] });
      seenCodes[n] = g.key;
      if (codeOwner[n] && codeOwner[n].toUpperCase() !== g.key.toUpperCase()) {
        return Object.assign(line, { status: 'error', detail: code + ' belongs to ' + codeOwner[n] });
      }
    }
    var cur = byKey[g.key.toUpperCase()];
    if (!cur) return Object.assign(line, { status: 'add', detail: codes.length + ' code' + (codes.length === 1 ? '' : 's') });
    var changed: string[] = [];
    (['name', 'region', 'description', 'flavour', 'location', 'submit', 'prompt', 'sort'] as const).forEach(function (f) {
      if (String(cur[f]) !== String(g[f])) changed.push(f === 'submit' ? 'answer box' : f === 'sort' ? 'order' : f);
    });
    if (JSON.stringify(cur.coords) !== JSON.stringify(g.coords)) changed.push('pins');
    if (JSON.stringify(cur.options) !== JSON.stringify(g.options)) changed.push('options');
    if (cur.questions.length + g.questions.length > 2 && JSON.stringify(cur.questions) !== JSON.stringify(g.questions)) changed.push('questions');
    if (g.rules != null && JSON.stringify(cur.rules) !== JSON.stringify(rulesOf(g.rules))) changed.push('what it takes');
    if (g.keywords != null && cur.keywords.join(', ') !== g.keywords) changed.push('search tags');
    var curCodes: Record<string, DashCode> = {};
    cur.codes.forEach(function (c) { curCodes[normQuest(c.code)] = c; });
    for (var k = 0; k < codes.length; k++) {
      var had = curCodes[normQuest(cleanText(codes[k].code, 40))];
      var to = codes[k].scoring;
      if (had && to != null && crossesBands(had.scoring || '', to === 'fixed' ? '' : String(to)) && holding[had.code]) {
        return Object.assign(line, { status: 'error', detail: heldRefusal(had.code, holding[had.code]) });
      }
    }
    var codeChanges = 0;
    codes.forEach(function (c) {
      var was = curCodes[normQuest(cleanText(c.code, 40))];
      var typeMoved = was && c.scoring != null && (
        (was.scoring || '') !== (c.scoring === 'fixed' ? '' : c.scoring) ||
        JSON.stringify(was.bands || []) !== JSON.stringify(bandsOf(c.bands)) ||
        String(was.most == null ? '' : was.most) !== String(c.most == null ? '' : c.most));
      var pointsMoved = was && !(was.scoring === 'tiered' || was.scoring === 'counted') && Number(was.points) !== Number(c.points);
      if (!was || was.code !== cleanText(c.code, 40) || pointsMoved || typeMoved ||
          (was.label || '') !== cleanText(c.label, 80) || (was.hidden ? 1 : 0) !== (c.hidden ? 1 : 0)) codeChanges++;
    });
    if (codeChanges) changed.push(codeChanges + ' code' + (codeChanges === 1 ? '' : 's'));
    if (!changed.length) return line;
    return Object.assign(line, { status: 'update', detail: changed.join(', ') });
  });
  return { rows: rows, records: parsed.records, regions: parsed.regions };
}

export async function importQuestsPreview(env: Env, body: JsonBody): Promise<Response> {
  var plan = await importPlan(env.DB, body.text);
  if ('error' in plan) return json({ error: plan.error }, 400);
  return json({ ok: true, rows: plan.rows });
}

export async function importQuestsCommit(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var plan = await importPlan(db, body.text);
  if ('error' in plan) return json({ error: plan.error }, 400);
  var rowsPlanned = plan.rows;
  var errors = plan.rows.filter(function (r) { return r.status === 'error'; });
  if (errors.length) return json({ error: errors.length + ' row' + (errors.length === 1 ? '' : 's') + ' would fail. Fix the file first.', rows: plan.rows }, 400);
  // regions named in a JSON export keep their order
  if (plan.regions.length) {
    var have: Record<string, boolean> = {};
    (await regionRows(db)).forEach(function (r) { have[r.name.toUpperCase()] = true; });
    var lastSort = (await db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM quest_regions').first<{ n: number }>() as { n: number }).n;
    var fresh = plan.regions.map(function (n) { return cleanText(n, 60); }).filter(function (n) { return n && !have[n.toUpperCase()]; });
    if (fresh.length) {
      await db.batch(fresh.map(function (name, i) {
        return db.prepare('INSERT INTO quest_regions (name, sort) VALUES (?1, ?2)').bind(name, lastSort + i + 1);
      }));
    }
  }
  var byKey: Record<string, number> = {};
  (await allGroups(db)).groups.forEach(function (g) { byKey[g.key.toUpperCase()] = g.id; });
  var added = 0;
  var updated = 0;
  for (var i = 0; i < plan.rows.length; i++) {
    var line = plan.rows[i];
    if (line.status === 'same') continue;
    var r = plan.records[i];
    var g = recordToGroup(r);
    var codes: FileCode[] = Array.isArray(r.codes) && r.codes.length ? r.codes : [{ code: g.key, label: '', points: 0 }];
    var res = await upsertGroup(db, g, codes.map(function (c, j) {
      var row: Record<string, unknown> = { code: c.code, label: c.label, points: c.points, sort: j, hidden: c.hidden };
      if (c.scoring != null) { row.scoring = c.scoring; row.most = c.most; row.bands = c.bands; }
      return row;
    }), byKey[g.key.toUpperCase()] || 0, session.name);
    if ('error' in res) return json({ error: 'Row ' + line.line + ' (' + g.key + '): ' + res.error, rows: rowsPlanned }, res.status);
    if (line.status === 'add') added++; else updated++;
  }
  await logAction(db, session.name, 'quests-file-import', added + ' added, ' + updated + ' updated', '-', 0, 0, 0);
  return json({ ok: true, added: added, updated: updated, unchanged: plan.rows.length - added - updated });
}

// ---------- files hung on a quest ----------
// A photo quest is a photograph; a puzzle is a PDF. They go in the
// proof bucket under a qst/ prefix and are read by their keys, the
// same capability model the proof files and the message attachments
// use: the random half of the key is the secret.

function groupByKey(db: D1Database, key: unknown): Promise<GroupRead | null> | null {
  var wanted = cleanText(key, 40);
  if (!wanted) return null;
  return db.prepare('SELECT ' + GROUP_COLS + ' FROM quest_groups WHERE key = ?1 COLLATE NOCASE').bind(wanted).first<GroupRead>();
}

// A file and everything kept beside it leave the bucket together. A
// bucket that has already lost them is not worth failing a delete over.
async function dropStored(env: Env, key: string): Promise<void> {
  await deleteStored(env.SUBMIT, key);
}

async function groupFiles(db: D1Database, groupId: number): Promise<Pick<QuestFileRow, 'key' | 'name' | 'type' | 'bytes'>[]> {
  var rows = await db.prepare('SELECT key, name, type, bytes FROM quest_files WHERE group_id = ?1 ORDER BY sort, id')
    .bind(groupId).all<Pick<QuestFileRow, 'key' | 'name' | 'type' | 'bytes'>>();
  return rows.results;
}

// GET /api/quests/file?key= — public, like a proof file: the key must
// be one we handed out, contents never change under it, and Range
// passes through. thumb=1 asks for the small copy the dashboard made;
// a file without one (a PDF) serves whole instead.
export async function serveQuestFile(env: Env, request: Request, url: URL, keyFromPath?: string): Promise<Response> {
  if (!env.SUBMIT) return corsJson({ error: 'Quest files are not switched on.' }, 503);
  var key = keyFromPath || url.searchParams.get('key') || '';
  if (key.indexOf('qst/') !== 0) return corsJson({ error: 'not found' }, 404);
  var row = await env.DB.prepare(
    'SELECT f.id, f.type, f.name, f.bytes, g.key AS quest FROM quest_files f LEFT JOIN quest_groups g ON g.id = f.group_id WHERE f.key = ?1'
  ).bind(key).first<Pick<QuestFileRow, 'id' | 'type' | 'name' | 'bytes'> & { quest: string | null }>();
  if (!row) return corsJson({ error: 'not found' }, 404);
  // a person opening the address gets the file's page, with its quest's
  // code and details while the public can see the quest
  if (wantsPage(request, url, { named: !!keyFromPath, media: isMedia(row.type) })) {
    var shown = row.quest && (await publicQuest(env.DB, row.quest));
    return mediaPage(env, url, { key: key, type: row.type, name: row.name || 'attachment', bytes: row.bytes,
      quest: shown ? row.quest : '', base: '/api/quests/file/' + key.split('/').map(encodeURIComponent).join('/') + '/' });
  }
  var cors = Object.assign({ 'access-control-allow-origin': '*' }, VARY);
  // A link unfurler is answered with the whole picture rather than the
  // page's thumbnail — see isLinkPreview.
  var whole = isLinkPreview(request) && String(row.type || '').indexOf('image/') === 0;
  var asked = !!url.searchParams.get('thumb');
  var cache = whole && asked ? 'private, no-store' : FOREVER;
  // a GIF serves whole: its thumbnail is one frame of it
  if (asked && !animatedType(row.type) && !whole) {
    var small = await serveStoredFile(env.SUBMIT, request, key + '.t', cache, cors);
    if (small) return small;
  }
  // the copy with the metadata taken out, as everywhere else public
  return (await servePublicCopy(env, request, key, row.type, cache, cors)) ||
    corsJson({ error: 'not found' }, 404);
}

// Multipart, like a message's attachments: key names the quest,
// file0..file5 are the files, thumb0..thumb5 the previews the page
// made beside them. In place of file<i> the page may send staged<i>,
// the id of a file it sent straight to R2 (src/staged.ts), already
// under its key with its first bytes checked.
export async function saveGroupFiles(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  var form: FormData;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }
  var g = await groupByKey(env.DB, form.get('key'));
  if (!g) return json({ error: 'no such quest' }, 404);

  // the scan runs past the cap on purpose: a send with too many files
  // is refused rather than quietly losing the ones over the line
  // a file sent in the form, or one sent straight to R2 described by its row
  type Sent = File | { name: string; type: string; size: number };
  var files: { file: Sent; thumb: File | string | null; staged: StagedFile | null }[] = [];
  for (var i = 0; i < MAX_QUEST_FILES + 6; i++) {
    var staged: StagedFile | Refusal | null = null;
    var sent: Sent | string | null = form.get('file' + i);
    if (form.get('staged' + i)) {
      staged = await readStaged(env, session, form.get('staged' + i), 'qst');
      if ('error' in staged) return json({ error: staged.error }, staged.status);
      sent = { name: staged.name, type: staged.type, size: staged.bytes };
    } else if (!isBlobLike(sent)) {
      continue;
    }
    // pictures are the three the stripper can clean, as for messages
    var type = baseType(sent.type);
    // with nothing staged, the file is the form's
    if ((QUEST_PICTURES.indexOf(type) === -1 && type !== 'application/pdf') || (!staged && !(await bytesMatch(sent as File, type)))) {
      return json({ error: (sent.name || 'That file') + ' is not a JPEG, PNG or GIF, or a PDF.' }, 400);
    }
    if (sent.size > MAX_QUEST_FILE_BYTES) {
      return json({ error: (sent.name || 'That file') + ' is over 25MB.' }, 413);
    }
    files.push({ file: sent, thumb: form.get('thumb' + i), staged: staged });
  }
  var held = (await env.DB.prepare('SELECT COUNT(*) AS n FROM quest_files WHERE group_id = ?1').bind(g.id).first<{ n: number }>() as { n: number }).n;
  if (held + files.length > MAX_QUEST_FILES) {
    return json({ error: 'A quest carries at most ' + MAX_QUEST_FILES + ' files.' }, 400);
  }
  if (files.length && !env.SUBMIT) {
    return json({ error: 'Quest files are not switched on (the worker has no SUBMIT bucket).' }, 503);
  }

  // the files the page sent straight to R2 are this save's from here
  var claims = files.map(function (f) { return f.staged; }).filter(function (s): s is StagedFile { return !!s; });
  var taken = await claimStaged(env, claims);
  if (taken) return json({ error: taken.error }, taken.status);
  try {
    var rows: D1PreparedStatement[] = [];
    for (var k = 0; k < files.length; k++) {
      var entry = files[k];
      var name = cleanText(entry.file.name, 120).replace(/[^\w. ()-]/g, '_') || 'file';
      var key: string;
      if (entry.staged) {
        key = entry.staged.key;
      } else {
        key = 'qst/' + randomKey(12);
        // with nothing staged, the file is the form's
        await env.SUBMIT.put(key, entry.file as File, { httpMetadata: { contentType: entry.file.type } });
        await writeBlock(env, key, entry.file.type, entry.file as File);
      }
      // a GIF gets no preview: one frame of it is not a preview of it
      if (!animatedType(entry.file.type)) await storePreview(env, key + '.t', entry.thumb, MAX_THUMB_BYTES);
      rows.push(env.DB.prepare(
        'INSERT INTO quest_files (group_id, key, name, type, bytes, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(g.id, key, name, entry.file.type, entry.file.size, held + k));
      if (entry.staged) rows.push(releaseStaged(env, entry.staged));
    }
    if (rows.length) await env.DB.batch(rows);
  } catch (err) {
    await unclaimStaged(env, claims);
    throw err;
  }
  await logAction(env.DB, session.name, 'quest-files', g.key,
    files.length + ' file' + (files.length === 1 ? '' : 's'), 0, 0, 0);
  return json({ ok: true, files: await groupFiles(env.DB, g.id) });
}

export async function deleteGroupFile(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var row = await env.DB.prepare(
    'SELECT f.id, f.key, f.name, g.key AS quest FROM quest_files f ' +
    'LEFT JOIN quest_groups g ON g.id = f.group_id WHERE f.key = ?1'
  ).bind(String(body.key || '')).first<Pick<QuestFileRow, 'id' | 'key' | 'name'> & { quest: string | null }>();
  if (!row) return json({ error: 'no such file' }, 404);
  await dropStored(env, row.key);
  await env.DB.prepare('DELETE FROM quest_files WHERE id = ?1').bind(row.id).run();
  await logAction(env.DB, session.name, 'quest-file-delete', row.quest || '-', row.name || 'a file', 0, 0, 0);
  return json({ ok: true });
}

// ---------- the question a quest asks ----------
// Organisers open a question partway through the day: press red or
// blue, enter a sealed bid, stake points on a colour, type what the
// photograph shows. One answer per team, changeable while the
// question is open, and for a wager the settle turns those answers
// into points.

// The quest a code or a group key names, if the site can see it. The
// page sends either (a deep link uses the group key, the submit page
// sends the first code), matched the way the tab matches codes.
async function visibleGroupFor(db: D1Database, quest: unknown, teamId: number): Promise<VisibleGroup | null> {
  var norm = normQuest(quest == null ? '' : quest);
  if (!norm) return null;
  var row = await db.prepare(
    'SELECT ' + GROUP_COLS + " FROM quest_groups WHERE hidden = 0 AND UPPER(REPLACE(key, ' ', '')) = ?1"
  ).bind(norm).first<VisibleGroup>();
  if (!row) {
    row = await db.prepare(
      'SELECT g.id, g.key, g.hidden, g.visibility, g.ask_kind, g.ask_prompt, g.ask_options, g.ask_open, g.ask_open_until FROM quests q ' +
      'JOIN quest_groups g ON g.id = q.group_id ' +
      'WHERE q.norm = ?1 AND q.hidden = 0 AND g.hidden = 0'
    ).bind(norm).first<VisibleGroup>();
  }
  // a quest this team cannot see answers exactly as one that is not there
  return row && (await rowVisibleTo(db, row, teamId)) ? row : null;
}

// What one question shows teams of the other answers.
async function revealOf(db: D1Database, groupId: number): Promise<{ reveal: string; live: boolean }> {
  var row = await db.prepare('SELECT ask_reveal, ask_reveal_live FROM quest_groups WHERE id = ?1').bind(groupId).first<Pick<QuestGroupRow, 'ask_reveal' | 'ask_reveal_live'>>();
  var reveal = row && ASK_REVEALS.indexOf(row.ask_reveal) !== -1 ? row.ask_reveal : '';
  return { reveal: reveal, live: !!(row && row.ask_reveal_live) };
}

// One row per option whether or not anyone picked it, and an answer
// that is no longer an option (renamed since) still shows. A wager's
// points are what was staked on the option.
function tallyAnswers(options: unknown[], rows: Pick<QuestResponseRow, 'choice' | 'amount'>[]): Tally[] {
  var order = options.slice();
  rows.forEach(function (r) { if (order.indexOf(r.choice) === -1) order.push(r.choice); });
  return order.map(function (choice) {
    var teams = 0;
    var points = 0;
    rows.forEach(function (r) { if (r.choice === choice) { teams++; points += r.amount; } });
    return { choice: choice, teams: teams, points: Math.round(points * 100) / 100 };
  });
}

// The answers a question shows the teams, hidden teams left out of all
// of it. The reading team's own answer is marked `mine`, so the page
// never has to match team names. A number or a typed answer has no
// tally: what there is to show is how many answered, or every answer.
async function askResults(db: D1Database, groupId: number, ask: Ask, reveal: string, teamId: number): Promise<AskResults> {
  var rows = (await db.prepare(
    'SELECT r.team_id, r.choice, r.amount, t.name AS team FROM quest_responses r ' +
    'JOIN teams t ON t.id = r.team_id WHERE r.group_id = ?1 AND t.hidden = 0 ORDER BY t.name COLLATE NOCASE'
  ).bind(groupId).all<Pick<QuestResponseRow, 'team_id' | 'choice' | 'amount'> & { team: string }>()).results;
  var own = null as (typeof rows)[number] | null;
  rows.forEach(function (r) { if (teamId && r.team_id === teamId) own = r; });
  var out: AskResults = { total: rows.length };
  if (ask.kind === 'choice' || ask.kind === 'wager') {
    var counts = tallyAnswers(ask.options, rows);
    out.counts = counts;
    if (own) {
      var ownChoice = own.choice;
      counts.forEach(function (c) { if (c.choice === ownChoice) c.mine = true; });
    }
    if (ask.kind === 'wager') {
      var settled = await settledOf(db, groupId);
      if (settled) out.winner = settled.winner;
    }
  }
  if (reveal === 'answers') {
    out.answers = rows.map(function (r) {
      var one: { team: string; choice: string; amount: number; mine?: boolean } = { team: r.team, choice: r.choice, amount: r.amount };
      if (r === own) one.mine = true;
      return one;
    });
  }
  return out;
}

// GET /api/quest/ask?quest=SQ41 — what the quest is asking, plus this
// team's answer when the call carries a team's submit session, plus
// everyone's answers when the question shows them (`results`). Never
// cached: the question opens and closes during the run, and the answer
// is the team's own.
export async function questAskRead(request: Request, env: Env, url: URL): Promise<Response> {
  var team = await requireTeam(request, env.DB);
  var group = await visibleGroupFor(env.DB, url.searchParams.get('quest'), team ? team.team_id : 0);
  if (!group) return corsJson({ error: 'No quest by that code.' }, 404, NO_STORE);
  var ask = askFromRow(group);
  if (!ask.kind) return corsJson({ kind: '' }, 200, NO_STORE);
  var response: { choice: string; amount: number } | null = null;
  if (team) {
    var row = await env.DB.prepare(
      'SELECT choice, amount FROM quest_responses WHERE group_id = ?1 AND team_id = ?2'
    ).bind(group.id, team.team_id).first<Pick<QuestResponseRow, 'choice' | 'amount'>>();
    if (row) response = { choice: row.choice, amount: row.amount };
  }
  var shown = await revealOf(env.DB, group.id);
  var results = shown.reveal && (!ask.open || shown.live)
    ? await askResults(env.DB, group.id, ask, shown.reveal, team ? team.team_id : 0)
    : null;
  // A question that is not open reads as no question at all. Its text
  // is often written before the moment it is asked and must not be
  // readable early through this open endpoint. Two exceptions: a team
  // whose answer is on record — they saw the question while it was
  // open, and this is how they read their answer back after it closes —
  // and a question that shows its answers and has some from teams that
  // are not hidden, which means it has been asked.
  if (!ask.open && !response && !(results && results.total)) return corsJson({ kind: '' }, 200, NO_STORE);
  var out: Omit<Ask, 'reveal' | 'reveal_live'> & { response: typeof response; results?: AskResults } = {
    kind: ask.kind, prompt: ask.prompt, options: ask.options,
    open: ask.open, open_until: ask.open_until, response: response
  };
  if (results) out.results = results;
  return corsJson(out, 200, NO_STORE);
}

// POST /api/quest/ask — one answer per team, replaced whenever they
// change their mind, refused once organisers close the question.
export async function questAskWrite(request: Request, env: Env): Promise<Response> {
  var team = await requireTeam(request, env.DB);
  if (!team) return corsJson({ error: 'not signed in' }, 401, NO_STORE);
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) {
    return corsJson({ error: 'body must be JSON' }, 400, NO_STORE);
  }
  var group = await visibleGroupFor(env.DB, body.quest, team.team_id);
  var ask = group ? askFromRow(group) : null;
  if (!group || !ask || !ask.kind) return corsJson({ error: 'That quest is not asking anything.' }, 404, NO_STORE);
  if (!ask.open) return corsJson({ error: 'Responses are closed.' }, 409, NO_STORE);

  var choice = '';
  var amount = 0;
  var given = Number(body.amount);
  if (ask.kind === 'number') {
    if (!isFinite(given) || given < 0 || given !== Math.round(given) || given > MAX_ASK_AMOUNT) {
      return corsJson({ error: 'Answer with a whole number between 0 and ' + MAX_ASK_AMOUNT + '.' }, 400, NO_STORE);
    }
    amount = given;
  } else if (ask.kind === 'text') {
    // the typed answer rides in the choice column. An answer over the
    // cap is refused rather than shortened, so nobody loses the end of
    // theirs without being told.
    choice = cleanText(body.choice, MAX_ASK_TEXT * 4);
    if (!choice) return corsJson({ error: 'Type an answer first.' }, 400, NO_STORE);
    if (choice.length > MAX_ASK_TEXT) {
      return corsJson({ error: 'Keep the answer under ' + MAX_ASK_TEXT + ' characters.' }, 400, NO_STORE);
    }
  } else {
    choice = cleanText(body.choice, MAX_ASK_OPTION);
    if (ask.options.indexOf(choice) === -1) return corsJson({ error: 'Pick one of the options.' }, 400, NO_STORE);
    if (ask.kind === 'wager') {
      if (!isFinite(given) || given <= 0 || given !== Math.round(given) || given > MAX_ASK_AMOUNT) {
        return corsJson({ error: 'Stake a whole number of points, at least 1.' }, 400, NO_STORE);
      }
      amount = given;
    }
  }

  // written only while the question is still open and still the kind the
  // answer was read for: a close, a deadline or a settle since the read
  // above refuses it
  var res = await env.DB.prepare(
    'INSERT INTO quest_responses (group_id, team_id, choice, amount) SELECT ?1, ?2, ?3, ?4 FROM quest_groups ' +
    "WHERE id = ?1 AND ask_open = 1 AND ask_kind = ?5 AND (COALESCE(ask_open_until, '') = '' OR ask_open_until > ?6) " +
    "ON CONFLICT(group_id, team_id) DO UPDATE SET choice = ?3, amount = ?4, updated_at = datetime('now')"
  ).bind(group.id, team.team_id, choice, amount, ask.kind, utcStamp()).run();
  if (!res.meta || !res.meta.changes) return corsJson({ error: 'Responses are closed.' }, 409, NO_STORE);
  return corsJson({ ok: true, choice: choice, amount: amount }, 200, NO_STORE);
}

// What opening a question asks of a quest group, as SQL with ?1 its id:
// no live wager award on it (liveAward's lookup), so a settled wager
// stays shut until the settlement is undone.
var NOT_SETTLED = "NOT EXISTS (SELECT 1 FROM awards WHERE kind = 'wager' AND voided_at IS NULL " +
  'AND (group_id = ?1 OR code IN (SELECT code FROM quests WHERE group_id = ?1)))';
var SETTLED_SHUT = 'This wager is settled. Undo the settlement before taking answers again.';
var PAST_SHUT = 'Closes at has passed. Clear it or set a later time to take answers.';

// The Quests tab's list of polls and wagers: what the quest asks.
// Nothing else about the quest is touched here, and nothing else
// touches these columns — a quest saved or re-imported keeps the
// question it was given. Whether it is taking answers is the desk's
// (openGroupAsk), so a save that sends neither `open` nor `open_until`
// leaves them as they are; one that opens it is held to the desk's
// rules. A question taken off stops taking answers, and one that teams
// have answered keeps its kind, since a number read as a stake, or a
// stake as a number, is a different answer from the one given.
export async function saveGroupAsk(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var g = await groupByKey(db, body.key);
  if (!g) return json({ error: 'no such quest' }, 404);
  var kind = String(body.kind == null ? '' : body.kind);
  if (ASK_KINDS.indexOf(kind) === -1) {
    return json({ error: 'The question must be a choice, a number, a wager, text, or nothing.' }, 400);
  }
  var prompt = cleanText(body.prompt, MAX_ASK_PROMPT);
  var options = parseAskOptions(body.options);
  if (options.length > MAX_ASK_OPTIONS) {
    return json({ error: 'A question takes at most ' + MAX_ASK_OPTIONS + ' options.' }, 400);
  }
  if ((kind === 'choice' || kind === 'wager') && !options.length) {
    return json({ error: 'A ' + kind + ' question needs at least one option.' }, 400);
  }
  var open = 'open' in body ? (body.open ? 1 : 0) : (g.ask_open ? 1 : 0);
  // The deadline is the other half of open: a question with a time on
  // it stops taking answers then, whether or not anyone is watching.
  var until = 'open_until' in body ? readStamp(body.open_until) : (g.ask_open_until || '');
  if (until === null) {
    return json({ error: 'Closes at must be a time like 2026-10-20 14:30 (UTC), or empty.' }, 400);
  }
  if (!kind) open = 0;
  var opening = 'open' in body && !!open;
  if (opening && until && until <= utcStamp()) return json({ error: PAST_SHUT }, 400);
  if (opening && kind === 'wager' && await settledOf(db, g.id)) return json({ error: SETTLED_SHUT }, 409);
  var reveal = String(body.reveal == null ? '' : body.reveal);
  if (ASK_REVEALS.indexOf(reveal) === -1) {
    return json({ error: 'Teams see only their own answer, how many picked each option, or every team\'s answer.' }, 400);
  }
  var kindLocked = g.key + ' has answers from teams, so its question cannot change to another kind: the answers would be read as the new kind.';
  if (kind && g.ask_kind && kind !== g.ask_kind &&
    await db.prepare('SELECT 1 FROM quest_responses WHERE group_id = ?1 LIMIT 1').bind(g.id).first()) {
    return json({ error: kindLocked }, 409);
  }
  // the same two rules again in the statement, for an answer or a settle
  // landing since the reads above. A question added to a quest whose last
  // one was taken off starts with no answers: the answers left behind were
  // to the question that went.
  var shut = opening && kind === 'wager' && await ledgerReady(db);
  var done = await db.batch([
    db.prepare(
      "DELETE FROM quest_responses WHERE group_id = ?1 AND ?2 != '' AND " +
      "(SELECT COALESCE(ask_kind, '') FROM quest_groups WHERE id = ?1) = ''"
    ).bind(g.id, kind),
    db.prepare(
      'UPDATE quest_groups SET ask_kind = ?2, ask_prompt = ?3, ask_options = ?4, ask_open = ?5, ' +
      "ask_open_until = ?6 WHERE id = ?1 AND (?2 = '' OR ask_kind = ?2 OR NOT EXISTS (SELECT 1 FROM quest_responses WHERE group_id = ?1))" +
      (shut ? ' AND ' + NOT_SETTLED : '')
    ).bind(g.id, kind, prompt, JSON.stringify(options), open, until)
  ]);
  var saved = done[1];
  if (!saved.meta || !saved.meta.changes) {
    var now = await groupByKey(db, g.key);
    if (!now) return json({ error: 'no such quest' }, 404);
    return json({ error: kind && now.ask_kind && kind !== now.ask_kind ? kindLocked : SETTLED_SHUT }, 409);
  }
  // Written on its own, and only when sent, so a page from before it
  // leaves it as it was.
  if ('reveal' in body) {
    await db.prepare('UPDATE quest_groups SET ask_reveal = ?2, ask_reveal_live = ?3 WHERE id = ?1')
      .bind(g.id, reveal, body.reveal_live ? 1 : 0).run();
  }
  var shown = await revealOf(db, g.id);
  var live = !!open && (!until || utcStamp() < until);
  await logAction(db, session.name, 'quest-ask', g.key,
    (kind || 'no question') + (kind ? (live ? ', open' : ', closed') : '') +
    (until ? ' until ' + until : '') + (kind && shown.reveal ? ', shows ' + shown.reveal : ''), 0, 0, 0);
  return json({
    ok: true,
    ask: {
      kind: kind, prompt: prompt, options: options, open: live, open_until: until,
      reveal: shown.reveal, reveal_live: shown.live
    }
  });
}

// Every team's answer, with a tally per option beside it. A text
// question has no meaningful tally, so it has no counts: what matters
// there is who answered and when.
export async function groupAskResponses(env: Env, body: JsonBody, scored: (code: string) => boolean): Promise<Response> {
  var db = env.DB;
  var g = await groupByKey(db, body.key);
  if (!g) return json({ error: 'no such quest' }, 404);
  if (!(await scoresGroup(db, g.id, scored))) return notScored();
  var ask = askFromRow(g);
  var rows = (await db.prepare(
    'SELECT r.choice, r.amount, r.updated_at, t.name AS team, t.hidden FROM quest_responses r ' +
    'JOIN teams t ON t.id = r.team_id WHERE r.group_id = ?1 ORDER BY t.name COLLATE NOCASE'
  ).bind(g.id).all<Pick<QuestResponseRow, 'choice' | 'amount' | 'updated_at'> & { team: string; hidden: number }>()).results;

  // a number question sums every answer under one blank row
  var counts = ask.kind !== 'text' ? tallyAnswers(ask.options, rows) : [];
  var shown = await revealOf(db, g.id);

  return json({
    ok: true, kind: ask.kind, prompt: ask.prompt, options: ask.options, open: ask.open,
    open_until: ask.open_until, reveal: shown.reveal, reveal_live: shown.live,
    responses: rows.map(function (r) {
      return { team: r.team, hidden: r.hidden, choice: r.choice, amount: r.amount, updated_at: r.updated_at };
    }),
    counts: counts,
    total: rows.length,
    settled: await settledOf(db, g.id)
  });
}

// Whether the account scores any of a quest's codes, `scored` saying
// whether it scores one: the answers, opening and closing, settling and
// undoing a settlement are all refused to an account limited to other
// quests.
async function scoresGroup(db: D1Database, groupId: number, scored: (code: string) => boolean): Promise<boolean> {
  var codes = (await db.prepare('SELECT code FROM quests WHERE group_id = ?1').bind(groupId).all<Pick<QuestRow, 'code'>>()).results;
  return codes.some(function (c) { return scored(c.code); });
}

function notScored(): Response {
  return json({ error: 'Your account does not score that quest.', no_access: true }, 403);
}

// Taking answers or not, and until when: the day's half of a question,
// run from the quest's desk.
export async function openGroupAsk(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction, scored: (code: string) => boolean): Promise<Response> {
  var db = env.DB;
  var g = await groupByKey(db, body.key);
  if (!g) return json({ error: 'no such quest' }, 404);
  if (!(await scoresGroup(db, g.id, scored))) return notScored();
  if (!g.ask_kind) return json({ error: g.key + ' asks nothing. Add a poll or wager on the Quests tab.' }, 409);
  var open = body.open ? 1 : 0;
  var until = 'open_until' in body ? readStamp(body.open_until) : (g.ask_open_until || '');
  if (until === null) {
    return json({ error: 'Closes at must be a time like 2026-10-20 14:30 (UTC), or empty.' }, 400);
  }
  if (open && until && until <= utcStamp()) return json({ error: PAST_SHUT }, 400);
  if (open && g.ask_kind === 'wager' && await settledOf(db, g.id)) return json({ error: SETTLED_SHUT }, 409);
  // opened only while it still asks something and is not a settled wager,
  // whatever a save or a settle did since the reads above
  var shut = open && await ledgerReady(db);
  var res = await db.prepare(
    "UPDATE quest_groups SET ask_open = ?2, ask_open_until = ?3 WHERE id = ?1 AND (?2 = 0 OR (COALESCE(ask_kind, '') != ''" +
    (shut ? " AND (ask_kind != 'wager' OR " + NOT_SETTLED + ')' : '') + '))'
  ).bind(g.id, open, until).run();
  if (!res.meta || !res.meta.changes) {
    var now = await groupByKey(db, g.key);
    return json({ error: now && now.ask_kind ? SETTLED_SHUT : g.key + ' asks nothing. Add a poll or wager on the Quests tab.' }, 409);
  }
  await logAction(db, session.name, 'quest-ask', g.key, (open ? 'open' : 'closed') + (until ? ' until ' + until : ''), 0, 0, 0);
  var ask = askFromRow(Object.assign({}, g, { ask_open: open, ask_open_until: until }));
  return json({ ok: true, ask: { kind: ask.kind, prompt: ask.prompt, options: ask.options, open: ask.open, open_until: until } });
}

// Every quest that asks something, for the Quests tab's list: the
// question, whether it is taking answers, how many teams have answered
// (hidden teams left out) and, for a wager, its settlement.
export async function groupAsks(env: Env): Promise<Response> {
  var db = env.DB;
  var rows = (await db.prepare(
    'SELECT ' + GROUP_COLS + ', (SELECT COUNT(*) FROM quest_responses r JOIN teams t ON t.id = r.team_id ' +
    'WHERE r.group_id = quest_groups.id AND t.hidden = 0) AS answers ' +
    "FROM quest_groups WHERE COALESCE(ask_kind, '') != '' ORDER BY key COLLATE NOCASE"
  ).all<GroupRead & { answers: number }>()).results;
  var out: object[] = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var ask = askFromRow(r);
    var shown = { reveal: r.ask_reveal || '', live: !!r.ask_reveal && !!r.ask_reveal_live };
    out.push({
      key: r.key, name: r.name, hidden: !!r.hidden, kind: ask.kind, prompt: ask.prompt, options: ask.options,
      open: ask.open, open_until: ask.open_until, reveal: shown.reveal, reveal_live: shown.live,
      answers: Number(r.answers) || 0, settled: ask.kind === 'wager' ? await settledOf(db, r.id) : null
    });
  }
  return json({ ok: true, asks: out });
}

// Settling a wager: every team that picked the winning option gains
// what it staked and everyone else loses it, as one award on the
// quest's first code shown (ledger.ts). Each team's line credits the
// stake divided by what the code is worth, so the standings move by
// exactly the points staked. The question closes before the stakes are
// read, and again with the award.
//
// **A wager is settled once**: the award is made only while no live one
// is on the quest or its code (awardStatements), so a second press, a
// retried request or a different winner picked afterwards changes
// nothing. Undo the settlement to settle it again.

// {winner, at, by, undoable} once settled, null before. Read from the
// live award, or on a database behind the ledger from the stamp the
// quest kept.
async function settledOf(db: D1Database, groupId: number): Promise<Settled | null> {
  var award = await liveAward(db, 'wager', groupId);
  if (award) {
    var basis: { winner?: string } = {};
    try { basis = (JSON.parse(award.basis || '{}') || {}) as { winner?: string }; } catch (err) { basis = {}; }
    return { winner: basis.winner || '', at: award.made_at, by: award.made_by, undoable: await awardUndoable(db, award), id: award.id };
  }
  if (await ledgerReady(db)) return null;
  try {
    var row = await db.prepare('SELECT ask_settled FROM quest_groups WHERE id = ?1').bind(groupId).first<Pick<QuestGroupRow, 'ask_settled'>>();
    var s = JSON.parse((row && row.ask_settled) || 'null') as { winner?: string; at?: string; by?: string } | null;
    return s && s.winner ? { winner: s.winner, at: s.at || '', by: s.by || '', undoable: false } : null;
  } catch (err) {
    return null;
  }
}

function settledAlready(other: Settled | null): Response {
  return json({ error: 'This wager was settled' + (other ? ' on ' + other.winner : '') + ' already.', settled: other }, 409);
}

export async function settleGroupAsk(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction, scored: (code: string) => boolean): Promise<Response> {
  var db = env.DB;
  var g = await groupByKey(db, body.key);
  if (!g) return json({ error: 'no such quest' }, 404);
  if (!(await scoresGroup(db, g.id, scored))) return notScored();
  var ask = askFromRow(g);
  if (ask.kind !== 'wager') return json({ error: 'Only a wager is settled this way.' }, 400);
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  var before = await settledOf(db, g.id);
  if (before) return settledAlready(before);
  var winner = cleanText(body.winner, MAX_ASK_OPTION);
  if (ask.options.indexOf(winner) === -1) {
    return json({ error: 'The winning option has to be one of the options.' }, 400);
  }
  var code = await db.prepare(
    'SELECT code, points FROM quests WHERE group_id = ?1 AND hidden = 0 ORDER BY sort, code LIMIT 1'
  ).bind(g.id).first<Pick<QuestRow, 'code' | 'points'>>();
  if (!code) return json({ error: 'This quest has no visible code to score against.' }, 400);
  if (!code.points) {
    return json({ error: code.code + ' is worth 0 points, so there is nothing to move. Give it points first.' }, 400);
  }

  // The question is closed before the stakes are read: an answer is
  // written only while it is open (questAskWrite), so none can land
  // between the read and the award and go unsettled
  await db.prepare('UPDATE quest_groups SET ask_open = 0 WHERE id = ?1').bind(g.id).run();
  var rows = (await db.prepare('SELECT team_id, choice, amount FROM quest_responses WHERE group_id = ?1')
    .bind(g.id).all<Pick<QuestResponseRow, 'team_id' | 'choice' | 'amount'>>()).results;
  var worth = code.points;
  var moved = 0;
  var given = rows.map(function (r): [number, number] {
    var points = r.choice === winner ? r.amount : -r.amount;
    moved += points;
    return [r.team_id, points / worth];
  });
  // closed again with the award, in case it was opened in between
  var stmts = [db.prepare('UPDATE quest_groups SET ask_open = 0 WHERE id = ?1').bind(g.id)].concat(awardStatements(db, {
    kind: 'wager', group_id: g.id, code: code.code, by: session.name, note: 'Wager settled on ' + winner,
    basis: { winner: winner, stakes: rows.map(function (r) { return [r.team_id, r.choice, r.amount]; }) },
    given: given
  }));
  var done: D1Result[];
  try {
    done = await db.batch(stmts);
  } catch (err) {
    if (!isTaken(err)) throw err;
    done = [];
  }
  // the award row is the statement after the close
  if (!done.length || !done[1].meta || !done[1].meta.changes) return settledAlready(await settledOf(db, g.id));

  await logAction(db, session.name, 'ask-settle', g.key + ' — ' + winner,
    code.code + ', ' + rows.length + ' team' + (rows.length === 1 ? '' : 's'),
    Math.round(moved * 100) / 100, 0, 0);
  return json({ ok: true, settled: rows.length, winner: winner });
}

// Taking a settlement back voids its award: every team is moved back by
// what the settlement moved it, once, and the wager can be settled
// again. The question stays closed. One whose lines were all undone one
// at a time is voided the same way, moving nothing more.
export async function unsettleGroupAsk(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction, scored: (code: string) => boolean): Promise<Response> {
  var db = env.DB;
  var g = await groupByKey(db, body.key);
  if (!g) return json({ error: 'no such quest' }, 404);
  if (!(await scoresGroup(db, g.id, scored))) return notScored();
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  var award = await liveAward(db, 'wager', g.id);
  if (!award) return json({ error: 'This wager has not been settled.' }, 409);
  if (!(await awardUndoable(db, award))) {
    return json({ error: 'This wager was settled before the dashboard kept what it moved, so put the points right on the Points tab.' }, 409);
  }
  var lines = await awardGiven(db, award.id);
  var basis: { winner?: string } = {};
  try { basis = (JSON.parse(award.basis || '{}') || {}) as { winner?: string }; } catch (err) { basis = {}; }
  var done = await db.batch(voidAward(db, award, session.name, 'Settlement undone'));
  if (!done[0].meta || !done[0].meta.changes) return json({ error: 'That settlement was taken back already.' }, 409);
  var moved = lines.reduce(function (sum, l) { return sum + Number(l.points); }, 0);
  await logAction(db, session.name, 'ask-unsettle', g.key + ' — ' + (basis.winner || ''),
    award.code + ', ' + lines.length + ' team' + (lines.length === 1 ? '' : 's'), -Math.round(moved * 100) / 100, 0, 0);
  return json({ ok: true, teams: lines.length, winner: basis.winner || '' });
}

// ---------- who can see a quest, and when it opens ----------
// The rules are in access.ts. What is here writes them: one quest's
// settings from its card, a whole tag's at once, everything at once,
// the team groups, and the clock that opens a quest on time.

var MAX_TAGS = 12;
var WHO = ['everyone', 'teams', 'groups', 'organisers'];

// Opening is a time on each quest, worked out on every read the way a
// scheduled message is: the site asking for the list or the pulse is
// the clock, and the cron in schedule.ts is the floor under it for the
// hours nobody is looking. A due quest goes to everyone, its time comes
// off, and the quests counter moves so open pages offer the new list.
// Each quest opens only while its time is still the one read and still
// due, so a time moved later in between keeps it shut, and of two callers
// at once only the one that opened it logs it and moves the counter.
export async function releaseDue(db: D1Database): Promise<number> {
  var due = (await db.prepare(
    "SELECT id, key, opens_at FROM quest_groups WHERE opens_at != '' AND opens_at <= datetime('now') ORDER BY id LIMIT 200"
  ).all<Pick<QuestGroupRow, 'id' | 'key' | 'opens_at'>>()).results;
  if (!due.length) return 0;
  var opened: string[] = [];
  try {
    var stmts = due.map(function (g) {
      return db.prepare(
        "UPDATE quest_groups SET hidden = 0, visibility = 'everyone', opens_at = '' " +
        "WHERE id = ?1 AND opens_at = ?2 AND opens_at != '' AND opens_at <= datetime('now')"
      ).bind(g.id, g.opens_at);
    });
    for (var i = 0; i < stmts.length; i += 40) {
      var done = await db.batch(stmts.slice(i, i + 40));
      for (var j = 0; j < done.length; j++) {
        if (done[j].meta && done[j].meta.changes) opened.push(due[i + j].key);
      }
    }
  } catch (err) { /* what opened before the failure is still logged */ }
  if (!opened.length) return 0;
  try {
    await db.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      "VALUES ('quest-open', ?1, ?2, 0, 0, 0, 'schedule')"
    ).bind(opened.length + ' quest' + (opened.length === 1 ? '' : 's'), opened.join(' ').slice(0, 60)).run();
  } catch (err) { /* the quests are open; the log line is extra */ }
  await bumpCounter(db, 'quests');
  return opened.length;
}

// visibility, team groups and an opening time from a request, checked.
// 'organisers' is hidden = 1 and leaves the quest's own visibility as
// it was, so showing it again brings back whoever could see it before.
async function cleanAccess(db: D1Database, body: JsonBody): Promise<Access | { error: string }> {
  var who = String(body.visibility == null ? '' : body.visibility);
  if (WHO.indexOf(who) === -1) return { error: 'Choose who can see it: everyone, signed-in teams, team groups or organisers.' };
  var opensAt = readStamp(body.opens_at);
  if (opensAt === null) return { error: 'Opens at must be a time like 2026-10-20 10:30 (UTC), or empty.' };
  var known: Record<number, boolean> = {};
  (await db.prepare('SELECT id FROM audiences').all<Pick<AudienceRow, 'id'>>()).results.forEach(function (r) { known[r.id] = true; });
  var audiences = (Array.isArray(body.audiences) ? body.audiences : [])
    .map(Number).filter(function (id, i, list) { return known[id] && list.indexOf(id) === i; });
  if (who === 'groups' && !audiences.length) return { error: 'Pick at least one team group, or choose another setting.' };
  return { who: who, audiences: audiences, opens_at: opensAt, sentAudiences: Array.isArray(body.audiences) };
}

function accessStatements(db: D1Database, groupIds: number[], a: Access): D1PreparedStatement[] {
  var stmts: D1PreparedStatement[] = [];
  groupIds.forEach(function (id) {
    if (a.who === 'organisers') {
      stmts.push(db.prepare('UPDATE quest_groups SET hidden = 1, opens_at = ?2 WHERE id = ?1').bind(id, a.opens_at));
    } else {
      stmts.push(db.prepare('UPDATE quest_groups SET hidden = 0, visibility = ?2, opens_at = ?3 WHERE id = ?1').bind(id, a.who, a.opens_at));
    }
    if (a.sentAudiences && a.who !== 'organisers') {
      stmts.push(db.prepare('DELETE FROM quest_audiences WHERE group_id = ?1').bind(id));
      a.audiences.forEach(function (aid) {
        stmts.push(db.prepare('INSERT OR IGNORE INTO quest_audiences (group_id, audience_id) VALUES (?1, ?2)').bind(id, aid));
      });
    }
  });
  return stmts;
}

// tag names to ids, making the ones that do not exist yet
async function tagIdsFor(db: D1Database, names: unknown): Promise<{ error: string } | { ids: number[] }> {
  var seen: Record<string, boolean> = {};
  var clean: string[] = [];
  (Array.isArray(names) ? names : String(names == null ? '' : names).split(',')).forEach(function (n) {
    var t = cleanText(n, 40);
    if (t && !seen[t.toUpperCase()]) { seen[t.toUpperCase()] = true; clean.push(t); }
  });
  if (clean.length > MAX_TAGS) return { error: 'A quest takes at most ' + MAX_TAGS + ' tags.' };
  if (clean.length) {
    await db.batch(clean.map(function (n) { return db.prepare('INSERT OR IGNORE INTO quest_tags (name) VALUES (?1)').bind(n); }));
  }
  var byName: Record<string, number> = {};
  (await db.prepare('SELECT id, name FROM quest_tags').all<Pick<QuestTagRow, 'id' | 'name'>>()).results.forEach(function (r) { byName[r.name.toUpperCase()] = r.id; });
  return { ids: clean.map(function (n) { return byName[n.toUpperCase()]; }).filter(Boolean) };
}

function whoText(a: Access): string {
  return a.who === 'organisers' ? 'organisers only' : a.who === 'teams' ? 'signed-in teams' :
    a.who === 'groups' ? a.audiences.length + ' team group' + (a.audiences.length === 1 ? '' : 's') : 'everyone';
}

async function oneGroup(db: D1Database, id: number): Promise<DashGroup | null> {
  return (await allGroups(db)).groups.filter(function (x) { return x.id === id; })[0] || null;
}

// One quest's card: who can see it, when it opens, its tags.
export async function setGroupAccess(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var g = await db.prepare('SELECT id, key FROM quest_groups WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestGroupRow, 'id' | 'key'>>();
  if (!g) return json({ error: 'no such quest' }, 404);
  var a = await cleanAccess(db, body);
  if ('error' in a) return json({ error: a.error }, 400);
  var groupId = g.id;
  var stmts = accessStatements(db, [g.id], a);
  if (body.tags !== undefined) {
    var tags = await tagIdsFor(db, body.tags);
    if ('error' in tags) return json({ error: tags.error }, 400);
    stmts.push(db.prepare('DELETE FROM quest_group_tags WHERE group_id = ?1').bind(g.id));
    tags.ids.forEach(function (tid) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO quest_group_tags (group_id, tag_id) VALUES (?1, ?2)').bind(groupId, tid));
    });
  }
  await db.batch(stmts);
  await logAction(db, session.name, 'quest-access', g.key,
    whoText(a) + (a.opens_at ? ', opens ' + a.opens_at : ''), 0, 0, 0);
  return json({ ok: true, group: await oneGroup(db, g.id) });
}

// A tag: made, renamed, or hidden from the dashboard (or back).
export async function saveTag(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var name = cleanText(body.name, 40);
  if (!name) return json({ error: 'The tag needs a name.' }, 400);
  var id = Number(body.id) || 0;
  var clash = await db.prepare('SELECT id FROM quest_tags WHERE name = ?1 COLLATE NOCASE AND id != ?2').bind(name, id).first();
  if (clash) return json({ error: 'There is already a tag called ' + name + '.' }, 409);
  var dashHidden = body.dash_hidden ? 1 : 0;
  if (id) {
    var cur = await db.prepare('SELECT id FROM quest_tags WHERE id = ?1').bind(id).first();
    if (!cur) return json({ error: 'no such tag' }, 404);
    await db.prepare('UPDATE quest_tags SET name = ?2, dash_hidden = ?3 WHERE id = ?1').bind(id, name, dashHidden).run();
  } else {
    await db.prepare('INSERT INTO quest_tags (name, dash_hidden) VALUES (?1, ?2)').bind(name, dashHidden).run();
  }
  await logAction(db, session.name, 'tag-save', name, dashHidden ? 'hidden from the dashboard' : '-', 0, 0, 0);
  return json(Object.assign({ ok: true }, await allGroups(db)));
}

// A tag goes; its quests stay as they are, without it.
export async function deleteTag(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var tag = await db.prepare('SELECT id, name FROM quest_tags WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestTagRow, 'id' | 'name'>>();
  if (!tag) return json({ error: 'no such tag' }, 404);
  await db.batch([
    db.prepare('DELETE FROM quest_group_tags WHERE tag_id = ?1').bind(tag.id),
    db.prepare('DELETE FROM quest_tags WHERE id = ?1').bind(tag.id)
  ]);
  await logAction(db, session.name, 'tag-delete', tag.name, '-', 0, 0, 0);
  return json(Object.assign({ ok: true }, await allGroups(db)));
}

// Every quest under a tag at once:
//   do: 'open'   open to everyone now (and drop any time)
//   do: 'at'     open to everyone at `opens_at`
//   do: 'clear'  take the time off
//   do: 'set'    who can see them (visibility, audiences), as on a card
export async function applyTag(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var tag = await db.prepare('SELECT id, name FROM quest_tags WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<QuestTagRow, 'id' | 'name'>>();
  if (!tag) return json({ error: 'no such tag' }, 404);
  var ids = (await db.prepare('SELECT group_id FROM quest_group_tags WHERE tag_id = ?1').bind(tag.id).all<Pick<QuestGroupTagRow, 'group_id'>>()).results
    .map(function (r) { return r.group_id; });
  if (!ids.length) return json({ error: 'No quests carry ' + tag.name + '.' }, 400);
  var what = String(body.do || '');
  var stmts: D1PreparedStatement[];
  var note: string;
  if (what === 'open') {
    stmts = ids.map(function (id) {
      return db.prepare("UPDATE quest_groups SET hidden = 0, visibility = 'everyone', opens_at = '' WHERE id = ?1").bind(id);
    });
    note = 'opened';
  } else if (what === 'at' || what === 'clear') {
    var at = what === 'clear' ? '' : readStamp(body.opens_at);
    if (at === null || (what === 'at' && !at)) return json({ error: 'Opens at must be a time like 2026-10-20 10:30 (UTC).' }, 400);
    stmts = ids.map(function (id) { return db.prepare('UPDATE quest_groups SET opens_at = ?2 WHERE id = ?1').bind(id, at); });
    note = at ? 'opens ' + at : 'time cleared';
  } else if (what === 'set') {
    var asked = await cleanAccess(db, Object.assign({}, body, { opens_at: body.opens_at || '' }));
    if ('error' in asked) return json({ error: asked.error }, 400);
    var a = asked;
    var list: D1PreparedStatement[] = [];
    // a tag-wide change of who can see leaves each quest's own time alone
    stmts = list;
    ids.forEach(function (id) {
      if (a.who === 'organisers') list.push(db.prepare('UPDATE quest_groups SET hidden = 1 WHERE id = ?1').bind(id));
      else list.push(db.prepare('UPDATE quest_groups SET hidden = 0, visibility = ?2 WHERE id = ?1').bind(id, a.who));
      if (a.sentAudiences && a.who !== 'organisers') {
        list.push(db.prepare('DELETE FROM quest_audiences WHERE group_id = ?1').bind(id));
        a.audiences.forEach(function (aid) {
          list.push(db.prepare('INSERT OR IGNORE INTO quest_audiences (group_id, audience_id) VALUES (?1, ?2)').bind(id, aid));
        });
      }
    });
    note = whoText(a);
  } else {
    return json({ error: 'Say what to do with the tag: open, at, clear or set.' }, 400);
  }
  await runBatches(db, stmts);
  await logAction(db, session.name, 'tag-apply', tag.name, ids.length + ' quests, ' + note, 0, 0, 0);
  return json({ ok: true, quests: ids.length });
}

// Everything open now, apart from two kinds of quest: the ones under a
// tag hidden from the dashboard (Old), and the ones with their own time
// still to come, which keep it. Typed confirm.
export async function openEverything(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (String(body.confirm || '') !== 'OPEN') return json({ error: 'Type OPEN to confirm.' }, 428);
  var rows = (await db.prepare(
    'SELECT g.id FROM quest_groups g WHERE NOT EXISTS (' +
    '  SELECT 1 FROM quest_group_tags gt JOIN quest_tags t ON t.id = gt.tag_id WHERE gt.group_id = g.id AND t.dash_hidden = 1' +
    ") AND (g.opens_at = '' OR g.opens_at <= datetime('now'))" +
    // only what this changes, so the count is the quests that opened
    " AND (g.hidden = 1 OR COALESCE(g.visibility, 'everyone') != 'everyone' OR g.opens_at != '')"
  ).all<Pick<QuestGroupRow, 'id'>>()).results;
  var stmts = rows.map(function (r) {
    return db.prepare("UPDATE quest_groups SET hidden = 0, visibility = 'everyone', opens_at = '' WHERE id = ?1").bind(r.id);
  });
  if (stmts.length) await runBatches(db, stmts);
  await logAction(db, session.name, 'quests-open-all', rows.length + ' quests', '-', 0, 0, 0);
  return json({ ok: true, opened: rows.length });
}

// A team group: made or renamed, and who is in it (the whole list).
export async function saveAudience(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var name = cleanText(body.name, 60);
  if (!name) return json({ error: 'The team group needs a name.' }, 400);
  var id = Number(body.id) || 0;
  var clash = await db.prepare('SELECT id FROM audiences WHERE name = ?1 COLLATE NOCASE AND id != ?2').bind(name, id).first();
  if (clash) return json({ error: 'There is already a team group called ' + name + '.' }, 409);
  if (id) {
    var cur = await db.prepare('SELECT id FROM audiences WHERE id = ?1').bind(id).first();
    if (!cur) return json({ error: 'no such team group' }, 404);
    await db.prepare('UPDATE audiences SET name = ?2 WHERE id = ?1').bind(id, name).run();
  } else {
    id = (await db.prepare('INSERT INTO audiences (name) VALUES (?1)').bind(name).run()).meta.last_row_id;
  }
  var teams: Record<number, boolean> = {};
  (await db.prepare('SELECT id FROM teams').all<Pick<TeamRow, 'id'>>()).results.forEach(function (r) { teams[r.id] = true; });
  var members = (Array.isArray(body.team_ids) ? body.team_ids : []).map(Number)
    .filter(function (t, i, list) { return teams[t] && list.indexOf(t) === i; });
  var stmts = [db.prepare('DELETE FROM audience_teams WHERE audience_id = ?1').bind(id)];
  members.forEach(function (t) {
    stmts.push(db.prepare('INSERT INTO audience_teams (audience_id, team_id) VALUES (?1, ?2)').bind(id, t));
  });
  await runBatches(db, stmts);
  await logAction(db, session.name, 'team-group-save', name, members.length + ' team' + (members.length === 1 ? '' : 's'), 0, 0, 0);
  return json(Object.assign({ ok: true, id: id }, await allGroups(db)));
}

// A team group goes, with its members and the quests' and messages'
// links to it. A quest or message left showing to team groups with none
// of them is seen by no team until it is given another.
export async function deleteAudience(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var a = await db.prepare('SELECT id, name FROM audiences WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<AudienceRow, 'id' | 'name'>>();
  if (!a) return json({ error: 'no such team group' }, 404);
  await db.batch([
    db.prepare('DELETE FROM message_audiences WHERE audience_id = ?1').bind(a.id),
    db.prepare('DELETE FROM audience_teams WHERE audience_id = ?1').bind(a.id),
    db.prepare('DELETE FROM quest_audiences WHERE audience_id = ?1').bind(a.id),
    db.prepare('DELETE FROM audiences WHERE id = ?1').bind(a.id)
  ]);
  await logAction(db, session.name, 'team-group-delete', a.name, '-', 0, 0, 0);
  return json(Object.assign({ ok: true }, await allGroups(db)));
}

// The dashboard's "as a team sees it": the keys of the quests one team
// (or nobody signed in, team_id 0) would get.
export async function visibleKeys(env: Env, url: URL): Promise<Response> {
  var teamId = Number(url.searchParams.get('team_id')) || 0;
  var viewer = teamId ? await viewerFor(env.DB, teamId) : null;
  var all = await allGroups(env.DB);
  return json({ ok: true, keys: all.groups.filter(function (g) { return canSee(g, viewer); }).map(function (g) { return g.key; }) });
}

// ---------- router: the public reads and the one public write ----------

export async function handleQuestApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  var path = url.pathname;
  // The public list (/api/questlist) is a cached read in index.ts.
  // A signed-in team's list: everything the public list has plus what
  // this team may see. Never cached, since it is theirs.
  if (path === '/api/questlist/team' && request.method === 'GET') {
    var team = await requireTeam(request, env.DB);
    if (!team) return corsJson({ error: 'not signed in' }, 401, NO_STORE);
    var mine = await questListPayload(env.DB, await viewerFor(env.DB, team.team_id));
    mine.team = team.team_name;
    return corsJson(mine, 200, { 'cache-control': 'private, no-store' });
  }
  // Neither of these goes through apiResponse, so the tab freeze does
  // not reach them: a frozen tab stops the standings, not a quest the
  // organisers are running.
  if (path === '/api/quests/file' && request.method === 'GET') return serveQuestFile(env, request, url);
  // the same file at a path ending in its name, which the file's page uses
  var namedFile = path.match(/^\/api\/quests\/file\/(qst\/[^/]+)\/[^/]*$/);
  if (namedFile && request.method === 'GET') return serveQuestFile(env, request, url, decodeURIComponent(namedFile[1]));
  if (path === '/api/quest/ask') {
    if (request.method === 'GET') return questAskRead(request, env, url);
    if (request.method === 'POST') return questAskWrite(request, env);
  }
  return null;
}
