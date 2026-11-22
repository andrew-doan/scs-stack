// Points put on a team in a test the way the worker puts them on: a line
// on the ledger (src/ledger.ts), which the tab reads through the view
// `held`. Shared by the worker suites in this folder; they write to the
// raw node:sqlite database rather than through the shim.

// A line of `units` of `code` for `team`, worth units times the code's
// points: a balance unless a source is named.
export function credit(raw, team, code, units, opts = {}) {
  raw.prepare("INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1) ON CONFLICT(name) DO NOTHING").run();
  raw.prepare(
    'INSERT INTO entries (team_id, code, units, points, source_kind, source_id, note, made_by, at) ' +
    "SELECT ?, code, ?, ROUND(? * points, 2), ?, ?, ?, ?, COALESCE(?, datetime('now')) FROM quests WHERE code = ?"
  ).run(team, units, units, opts.kind || 'balance', opts.id ?? null, opts.note || '', opts.by || 'test', opts.at || null, code);
}

// Every live line a team holds on a code, voided.
export function uncredit(raw, team, code, reason) {
  raw.prepare("UPDATE entries SET voided_at = datetime('now'), voided_by = 'test', void_reason = ? WHERE team_id = ? AND code = ? AND voided_at IS NULL")
    .run(reason || 'test', team, code);
}

// What a team holds on a code, as the tab reads it: 0 for nothing.
export function heldOn(raw, team, code) {
  const row = raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(team, code);
  return row ? Math.round(row.amount * 1e6) / 1e6 : 0;
}

// What a team holds on its live lines, by code.
export function linesHeld(raw, team) {
  const out = {};
  raw.prepare('SELECT code, SUM(units) AS units FROM entries WHERE team_id = ? AND voided_at IS NULL GROUP BY code')
    .all(team).forEach(r => { out[r.code] = Math.round(r.units * 1e6) / 1e6; });
  return out;
}

// The tab as its readers see it (the view `held`) against the ledger
// added up here, line by line, for every team and code still there:
// the board built both ways, units and points.
export function ledgerAgrees(raw) {
  const tab = {};
  raw.prepare('SELECT team_id, quest_code, amount, points FROM held').all()
    .forEach(r => { tab[r.team_id + '\n' + r.quest_code] = [r.amount, r.points]; });
  const teams = new Set(raw.prepare('SELECT id FROM teams').all().map(r => r.id));
  const codes = new Set(raw.prepare('SELECT code FROM quests').all().map(r => r.code));
  const lines = {};
  raw.prepare('SELECT team_id, code, units, points, voided_at FROM entries').all().forEach(r => {
    if (r.voided_at || !teams.has(r.team_id) || !codes.has(r.code)) return;
    const key = r.team_id + '\n' + r.code;
    const sum = lines[key] = lines[key] || [0, 0];
    sum[0] += r.units;
    sum[1] += r.points;
  });
  const keys = new Set([...Object.keys(tab), ...Object.keys(lines)]);
  const off = [];
  keys.forEach(k => {
    const a = tab[k] || [0, 0];
    const sum = lines[k] || [0, 0];
    const there = Math.abs(sum[0]) > 0.000001 || Math.abs(sum[1]) > 0.000001;
    const b = there ? sum : [0, 0];
    if (Math.abs(a[0] - b[0]) > 0.000001 || Math.abs(a[1] - b[1]) > 0.005) off.push([k.replace('\n', ' '), a, b]);
  });
  return off;
}
