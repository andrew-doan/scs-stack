// The dashboard's Map tab: where each team was last known to be, and
// when it last sent anything in.
//
// Nothing here tracks a phone. A team's place is the map pin of the
// newest submission it has on a quest that has one (quest_groups.coords),
// which is as good as the team being there when it sent the proof. An
// organiser's entry on such a quest counts too, since an organiser
// scoring a team at a checkpoint is standing beside it. A deleted
// submission does not count: deleting is how a wrong one is taken away.
//
// Most quests have one pin. One with several is resolved by what was
// sent: the ticked codes (or an organiser entry's codes) are matched to
// the pins by name, then by position when the quest has as many codes as
// pins. A quest with several pins and nothing to choose between them
// (The Star or Crown) is placed between them when they are within
// NEAR_KM of each other, and otherwise not used, so the team falls back
// to the submission before it.

import { json, fields } from './shared.ts';
import type { Env, QuestGroupRow, QuestRow, SubmissionRow, TeamRow } from './types.ts';

// A quest's map pin (quest_groups.coords).
interface Pin {
  label: string;
  lat: number;
  lng: number;
}

var NEAR_KM = 3;
// how many pinned submissions per team are looked at, newest first,
// before giving up on placing it
var LOOK_BACK = 5;

function readJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch (err) { return null; }
}

function squash(s: unknown): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  var lat = (a.lat + b.lat) / 2 * Math.PI / 180;
  var dx = (b.lng - a.lng) * 111.32 * Math.cos(lat);
  var dy = (b.lat - a.lat) * 110.57;
  return Math.sqrt(dx * dx + dy * dy);
}

export function cleanPins(text: string | null | undefined): Pin[] {
  var pins = readJson(text);
  if (!Array.isArray(pins)) return [];
  return pins.filter(function (p) {
    return p && isFinite(Number(fields(p).lat)) && isFinite(Number(fields(p).lng));
  }).map(function (p) {
    var f = fields(p);
    return { label: String(f.label || ''), lat: Number(f.lat), lng: Number(f.lng) };
  });
}

// The codes a submission was about: what the team ticked, what an
// organiser credited, or the code it was sent under.
export function chosenCodes(row: Pick<SubmissionRow, 'answer' | 'credit' | 'quest_code'>): unknown[] {
  var answer = fields(readJson(row.answer));
  if (answer.kind === 'codes' && Array.isArray(answer.value) && answer.value.length) return answer.value;
  var credit = fields(readJson(row.credit));
  if (Array.isArray(credit.codes) && credit.codes.length) return credit.codes;
  return [row.quest_code];
}

// {lat, lng, place} for one submission, or null when its pins cannot
// say where the team was. With between false, a quest whose pins the
// codes cannot choose from is not placed between them either (the
// replay's rule: one place or none).
export function placeFor(pins: Pin[], codes: { code: string; label: string }[], chosen: unknown[], between?: boolean): { lat: number; lng: number; place: string } | null {
  if (!pins.length) return null;
  if (pins.length === 1) return { lat: pins[0].lat, lng: pins[0].lng, place: pins[0].label };
  var hit: Pin[] = [];
  chosen.forEach(function (code) {
    var at = -1;
    for (var i = 0; i < codes.length; i++) if (codes[i].code === code) at = i;
    if (at === -1) return;
    var want = squash(codes[at].label);
    var pin: Pin | null = null;
    if (want) {
      pin = pins.filter(function (p) {
        var have = squash(p.label);
        return have && (have.indexOf(want) === 0 || want.indexOf(have) === 0);
      })[0] || null;
    }
    if (!pin && codes.length === pins.length) pin = pins[at];
    if (pin && hit.indexOf(pin) === -1) hit.push(pin);
  });
  if (hit.length) {
    var first = hit[0];
    return {
      lat: first.lat, lng: first.lng,
      place: first.label + (hit.length > 1 ? ' and ' + (hit.length - 1) + ' more' : '')
    };
  }
  if (between === false) return null;
  var mid = {
    lat: pins.reduce(function (s, p) { return s + p.lat; }, 0) / pins.length,
    lng: pins.reduce(function (s, p) { return s + p.lng; }, 0) / pins.length
  };
  if (pins.some(function (p) { return km(p, mid) > NEAR_KM; })) return null;
  return {
    lat: mid.lat, lng: mid.lng,
    place: pins.length === 2 ? pins[0].label + ' or ' + pins[1].label : 'One of ' + pins.length + ' places'
  };
}

function round(n: number): number { return Math.round(n * 1e5) / 1e5; }

export async function teamMap(env: Env): Promise<Response> {
  var db = env.DB;
  type Listed = Pick<TeamRow, 'id' | 'name' | 'hidden'> & { last_sent: string | null };
  var teams = await db.prepare(
    "SELECT t.id, t.name, t.hidden, (SELECT MAX(s.submitted_at) FROM submissions s WHERE s.team_id = t.id AND s.added_by = '') AS last_sent " +
    'FROM teams t ORDER BY t.name COLLATE NOCASE'
  ).all<Listed>();
  var rows = (await db.prepare(
    'SELECT * FROM (SELECT s.id, s.team_id, s.quest_code, s.submitted_at, s.status, s.answer, s.added_by, s.credit, ' +
    'g.id AS group_id, g.key AS group_key, g.name AS group_name, g.coords, ' +
    'ROW_NUMBER() OVER (PARTITION BY s.team_id ORDER BY s.submitted_at DESC, s.id DESC) AS n ' +
    'FROM submissions s JOIN quests q ON q.code = s.quest_code JOIN quest_groups g ON g.id = q.group_id ' +
    "WHERE s.status <> 'deleted' AND g.coords NOT IN ('', '[]')) WHERE n <= ?1 " +
    'ORDER BY team_id, n'
  ).bind(LOOK_BACK).all<Pick<SubmissionRow, 'id' | 'team_id' | 'quest_code' | 'submitted_at' | 'status' | 'answer' | 'added_by' | 'credit'> & { group_id: number; group_key: string; group_name: string; coords: QuestGroupRow['coords']; n: number }>()).results;

  var codesOf: Record<number, { code: string; label: string }[]> = {};
  var groupIds: number[] = [];
  rows.forEach(function (r) { if (groupIds.indexOf(r.group_id) === -1) groupIds.push(r.group_id); });
  if (groupIds.length) {
    (await db.prepare(
      'SELECT code, label, group_id FROM quests WHERE hidden = 0 AND group_id IN (SELECT value FROM json_each(?1)) ' +
      'ORDER BY group_id, sort, norm'
    ).bind(JSON.stringify(groupIds)).all<Pick<QuestRow, 'code' | 'label'> & { group_id: number }>()).results.forEach(function (q) {
      (codesOf[q.group_id] = codesOf[q.group_id] || []).push({ code: q.code, label: q.label });
    });
  }

  var at: Record<number, { lat: number; lng: number; place: string; quest: string; quest_name: string; status: string; at: string; organiser: boolean }> = {};
  rows.forEach(function (r) {
    if (at[r.team_id]) return;
    var place = placeFor(cleanPins(r.coords), codesOf[r.group_id] || [], chosenCodes(r));
    if (!place) return;
    at[r.team_id] = {
      lat: round(place.lat), lng: round(place.lng), place: place.place,
      quest: r.group_key, quest_name: r.group_name, status: r.status,
      at: r.submitted_at, organiser: !!r.added_by
    };
  });

  return json({
    ok: true,
    teams: teams.results.map(function (t) {
      return { id: t.id, name: t.name, hidden: !!t.hidden, last_sent: t.last_sent || '', seen: at[t.id] || null };
    })
  });
}
