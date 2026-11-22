// What a deleted quest leaves behind. Its codes come off the tab, and a
// new quest may be given one of them, so nothing of the old quest may stay
// under the code for the new one to take over: its submissions (which
// Review, the team's Already sent, a challenge's count and the gallery
// find by code), its lines on the ledger and its awards all move to one
// loose, hidden code, DELETED, each keeping the code it came from in
// `deleted_from` (migration 2026-12-deleted-quests.sql). The lines and
// awards are voided first (codeGone in ledger.ts), so none of it counts.
// The quest's own files stay where they are and are still served by
// their keys, with the quest's key in quest_files.deleted_key.
//
// Wherever a submission's quest is named, one in the holder reads as the
// quest it came from, "SQ12 (deleted)". A reader looks the code up only
// for a row that is in the holder.

export var DELETED_CODE = 'DELETED';
var DELETED_LABEL = 'Deleted quests';

// The holder, made the first time anything is deleted, the way the
// adjustments' code is: worth nothing and hidden.
export function holderStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO quests (code, norm, points, group_id, label, sort, hidden) VALUES (?1, ?1, 0, NULL, ?2, 0, 1) ON CONFLICT DO NOTHING'
  ).bind(DELETED_CODE, DELETED_LABEL);
}

// A deleted code's submissions, and its lines and awards once codeGone
// has voided them in the same batch, moved to the holder. Nothing live
// moves, so the unique indexes on a live line and a live award hold.
export function holdStatements(db: D1Database, code: string): D1PreparedStatement[] {
  return [
    db.prepare('UPDATE submissions SET quest_code = ?2, deleted_from = ?1 WHERE quest_code = ?1').bind(code, DELETED_CODE),
    db.prepare('UPDATE entries SET code = ?2, deleted_from = ?1 WHERE code = ?1 AND voided_at IS NOT NULL').bind(code, DELETED_CODE),
    db.prepare('UPDATE awards SET code = ?2, deleted_from = ?1 WHERE code = ?1 AND voided_at IS NOT NULL').bind(code, DELETED_CODE)
  ];
}

// "SQ12 (deleted)", or "Deleted quest" where the code is not known.
export function deletedName(from: string | null | undefined): string {
  return from ? from + ' (deleted)' : 'Deleted quest';
}

// How a row in the holder is found: a submission or a line by its id, or
// a submission by the key of one of its files.
export type FoundBy = 'submissions' | 'entries' | 'files';
var FROM_SQL: Record<FoundBy, string> = {
  submissions: 'SELECT id AS k, deleted_from AS f FROM submissions WHERE id IN (SELECT value FROM json_each(?1))',
  entries: 'SELECT id AS k, deleted_from AS f FROM entries WHERE id IN (SELECT value FROM json_each(?1))',
  files: 'SELECT f.r2_key AS k, s.deleted_from AS f FROM submission_files f JOIN submissions s ON s.id = f.submission_id ' +
    'WHERE f.r2_key IN (SELECT value FROM json_each(?1))'
};

// The code each of these came from, by id or key: one read for the lot,
// none for an empty list.
export async function cameFrom(db: D1Database, by: FoundBy, keys: (number | string)[]): Promise<Record<string, string>> {
  var out: Record<string, string> = {};
  if (!keys.length) return out;
  (await db.prepare(FROM_SQL[by]).bind(JSON.stringify(keys)).all<{ k: number | string; f: string }>()).results
    .forEach(function (r) { out[String(r.k)] = r.f || ''; });
  return out;
}

// Rows naming their submission's quest in `field`: each one in the holder
// is renamed for the quest it came from, `key` saying how to find it.
// Answers what each came from, by key.
export async function nameDeleted<T extends object>(db: D1Database, rows: T[], field: string, by: FoundBy, key: (row: T) => number | string): Promise<Record<string, string>> {
  var held = rows.filter(function (r) { return (r as unknown as Record<string, unknown>)[field] === DELETED_CODE; });
  var from = await cameFrom(db, by, held.map(key));
  held.forEach(function (r) { (r as unknown as Record<string, unknown>)[field] = deletedName(from[String(key(r))]); });
  return from;
}
