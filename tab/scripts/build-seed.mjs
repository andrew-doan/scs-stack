// Rebuilds seed.sql from the tab exports in data/.
//   node scripts/build-seed.mjs
// Reads score-database.csv (quest -> points per unit) and
// quest-tracker.csv (quest rows x team columns, cells are amounts) and
// writes INSERTs for teams, quests and the ledger's opening lines. A code
// the sheet counted above one for some team is per unit (src/parts.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// small real CSV parser: quoted fields, embedded commas and quotes
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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

const norm = (code) => code.toUpperCase().replace(/\s+/g, '');
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// ---- quests and their per-unit points ----
const scoreRows = parseCsv(readFileSync(join(root, 'data/score-database.csv'), 'utf8'));
const quests = new Map(); // norm -> { code, points }
for (const [code, points] of scoreRows.slice(1)) {
  if (!code) continue;
  const n = norm(code);
  const p = Number(points);
  if (quests.has(n) && quests.get(n).points !== p) {
    throw new Error(`duplicate quest ${code} with conflicting points`);
  }
  quests.set(n, { code: code.trim(), points: p });
}

// ---- teams and completion amounts ----
const trackRows = parseCsv(readFileSync(join(root, 'data/quest-tracker.csv'), 'utf8'));
const teams = trackRows[0].slice(1).map((name) => name.trim()).filter(Boolean);

const completions = []; // [teamIndex, questCode, amount]
const missing = new Set();
for (const row of trackRows.slice(1)) {
  const code = (row[0] || '').trim();
  if (!code) continue;
  const quest = quests.get(norm(code));
  if (!quest) { missing.add(code); continue; }
  teams.forEach((_, i) => {
    const cell = (row[i + 1] || '').trim();
    if (cell === '') return;
    const amount = Number(cell);
    if (Number.isNaN(amount)) throw new Error(`bad amount ${JSON.stringify(cell)} for ${code}`);
    completions.push([i, quest.code, amount]);
  });
}
if (missing.size) {
  console.warn('tracker rows with no score entry (skipped):', [...missing].join(', '));
}

// ---- write the seed ----
const lines = [
  '-- Generated from data/*.csv by scripts/build-seed.mjs — do not hand-edit.',
  'DELETE FROM entries;',
  'DELETE FROM completions;',
  'DELETE FROM teams;',
  'DELETE FROM quests;',
  ''
];
teams.forEach((name, i) => {
  lines.push(`INSERT INTO teams (id, name) VALUES (${i + 1}, ${q(name)});`);
});
lines.push('');
const counted = new Set(completions.filter(([, , amount]) => amount > 1 && Number.isInteger(amount)).map(([, code]) => code));
for (const { code, points } of quests.values()) {
  lines.push(`INSERT INTO quests (code, norm, points, scoring) VALUES (${q(code)}, ${q(norm(code))}, ${points}, ${q(counted.has(code) ? 'unit' : '')});`);
}
lines.push('');
// the ledger: what the sheet holds, as one line each
for (const [i, code, amount] of completions) {
  lines.push(
    'INSERT INTO entries (team_id, code, units, points, source_kind, note, made_by) ' +
    `SELECT ${i + 1}, code, ${amount}, ROUND(${amount} * points, 2), 'balance', 'From the committee''s sheet', 'seed' FROM quests WHERE code = ${q(code)};`
  );
}
lines.push(
  "INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1) ON CONFLICT(name) DO NOTHING;",
  ''
);

writeFileSync(join(root, 'seed.sql'), lines.join('\n'));
console.log(`seed.sql: ${teams.length} teams, ${quests.size} quests, ${completions.length} lines`);
