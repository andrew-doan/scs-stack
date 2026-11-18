// Every change to schema.sql has to be reachable by a live database.
//
//   node tests/verify-migrations.mjs
//
// The bug this exists for: teams.hidden was added to schema.sql with a
// comment telling whoever ran the database to do a one-off ALTER by
// hand, and no file went into migrations/. Nothing caught it, because
// every other suite builds its database from schema.sql and so always
// had the column. The live database could not get it from anywhere —
// db:migrate had nothing to apply and db:schema cannot add a column to
// a table that already exists — so the site answered "no such column:
// hidden — the database is behind" while the command that message names
// ran clean.
//
// So this suite does what no other one does: it builds a database the
// way a real one was built, from an old schema.sql, brings it forward
// with migrations/ exactly as scripts/migrate.mjs would, and checks that
// what comes out matches schema.sql as it stands now — tables, columns,
// indexes and the column constraints that only a rebuild can change.
//
// This file and the four scripts it covers are the same in both
// workers, and the last check here is that they still are.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { statements, alreadyApplied, payload, oneLine, split } from '../scripts/migrate.mjs';
import { declaredIndexes, uniqueColumns, readIndex, sameIndex } from '../scripts/db-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const HERE = basename(ROOT);
let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

// The oldest schema.sql in the history is the worst case a live database
// can be in: made before any of this existed and never rebuilt.
//
// `--follow` tracks the file across a folder rename and `--name-only`
// says what it was called at each commit, so the oldest copy is read
// from wherever it lived then. Both are needed. Without them a rename
// makes the lookup find nothing, `git show :<path>` falls back to the
// file as it stands *now*, and the suite builds its "old" database from
// the current schema — so it compares the schema with itself and passes
// while testing nothing at all. That is the one way this test can go
// quiet, so it is checked rather than assumed.
// `--reverse` cannot be used here. It is applied before the rename walk
// finishes, so the history comes back one commit long — the rename
// itself — and that commit's copy is the current file. The list is read
// newest first instead, and the last pair is the oldest.
function oldestSchema() {
  const out = execFileSync('git',
    ['log', '--follow', '--format=%H', '--name-only', '--', HERE + '/schema.sql'],
    { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (out.length < 2) return null;
  return execFileSync('git', ['show', out[out.length - 2] + ':' + out[out.length - 1]],
    { cwd: REPO, encoding: 'utf8' });
}
const current = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
// A repository started from a copy of the files has no older version in
// its history, so the first schema.sql is kept beside the tests as well.
function keptOldest() {
  try { return readFileSync(join(ROOT, 'tests', 'fixtures', 'schema-oldest.sql'), 'utf8'); } catch (err) { return null; }
}
function oldestOrKept() {
  let fromGit = null;
  try { fromGit = oldestSchema(); } catch (err) { fromGit = null; }
  return fromGit !== null && fromGit !== current ? fromGit : keptOldest();
}
const found = oldestOrKept();
// Not "was something found" but "is it actually older". Both ways this
// can go wrong hand back the current schema, and then the suite builds
// its old database out of the new schema and compares the file with
// itself: every check below passes and none of them tests anything.
check('the oldest schema.sql in the history is older than the one on disk',
  found !== null && found !== current,
  found === null
    ? 'git has no commit for ' + HERE + '/schema.sql — a folder rename that has not been committed does this'
    : found === current ? 'the only version git found is the current one' : '');
const oldest = found === null ? current : found;
const all = readdirSync(join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();

function shape(db) {
  const out = {};
  for (const t of db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    out[t.name] = db.prepare("SELECT name FROM pragma_table_info('" + t.name + "')")
      .all().map(r => r.name).sort();
  }
  return out;
}

function indexes(db) {
  const out = {};
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all()) {
    if (r.sql) out[r.name] = readIndex(r.name, r.sql);
  }
  return out;
}

function constraints(db) {
  const out = {};
  for (const t of db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    out[t.name] = uniqueColumns(t.sql).sort();
  }
  return out;
}

// Statements offered one at a time, the way scripts/migrate.mjs offers
// them: one that is already there is passed over, anything else is a
// real failure and is reported.
function apply(db, sql) {
  for (const stmt of statements(sql)) {
    try { db.exec(stmt); }
    catch (err) {
      if (alreadyApplied(err.message)) continue;
      return err.message + '\n    ' + stmt.replace(/\s+/g, ' ').slice(0, 120);
    }
  }
  return null;
}

// A live database, brought forward the way the README says to bring one
// forward: npm run db:schema, which creates whatever tables and indexes
// are not there yet, and then npm run db:migrate. Starting from the
// oldest schema.sql in the history, because that is the worst a real
// database can be — made before any of this existed and never rebuilt.
//
// The .once files go in too, in the same order: they are run by hand
// rather than by the runner, but a database that is up to date has had
// them, and the order they are meant to be run in is the order the rest
// are applied in.
const live = new DatabaseSync(':memory:');
apply(live, oldest);
apply(live, current);                                   // npm run db:schema

let stopped = null;
for (const file of all) {
  const err = apply(live, readFileSync(join(ROOT, 'migrations', file), 'utf8'));
  if (err) { stopped = file + ': ' + err; break; }
}
check('every migration applies to a database that has only ever had db:schema run on it',
  !stopped, stopped || '');

// And a fresh one, which is what every other suite runs against.
const fresh = new DatabaseSync(':memory:');
fresh.exec(current);

const want = shape(fresh);
const have = shape(live);

const gaps = [];
for (const table of Object.keys(want)) {
  if (!have[table]) { gaps.push('the whole of ' + table); continue; }
  for (const col of want[table]) {
    if (have[table].indexOf(col) === -1) gaps.push(table + '.' + col);
  }
}
check('a live database brought forward ends up matching schema.sql',
  gaps.length === 0,
  gaps.length ? gaps.join(', ') + '  — add a file to migrations/ for each' : '');

// Indexes are the half of a schema nothing notices is gone: the queries
// still answer, a plain index's just read the whole table, and a UNIQUE
// one has stopped refusing the duplicate it was put there to refuse. A
// rebuild that forgets to re-create one leaves exactly that.
const wantIdx = indexes(fresh);
const haveIdx = indexes(live);
const idxGaps = [];
for (const name of Object.keys(wantIdx)) {
  if (!haveIdx[name]) { idxGaps.push(name + ' is not there'); continue; }
  if (!sameIndex(wantIdx[name], haveIdx[name])) idxGaps.push(name + ' says something else');
}
check('and every index schema.sql declares', idxGaps.length === 0, idxGaps.join(', '));

// SQLite has no DROP CONSTRAINT, so a UNIQUE written into a CREATE
// TABLE can only be changed by rebuilding the table. A live database
// still carrying one the schema has dropped refuses rows the code
// expects to insert, and nothing about that reads as a schema problem —
// it reads as the worker answering 500.
const wantCon = constraints(fresh);
const haveCon = constraints(live);
const conGaps = [];
for (const table of Object.keys(wantCon)) {
  if (!haveCon[table]) continue;                        // already reported above
  for (const col of haveCon[table]) {
    if (wantCon[table].indexOf(col) === -1) conGaps.push(table + '.' + col + ' is still UNIQUE');
  }
  for (const col of wantCon[table]) {
    if (haveCon[table].indexOf(col) === -1) conGaps.push(table + '.' + col + ' is not UNIQUE');
  }
}
check('and the column constraints, which only a rebuild can change',
  conGaps.length === 0, conGaps.join(', '));

// A file that drops a table cannot be run twice, and the runner can
// only know that from the name. One of these applied on a loop is the
// roster copied, dropped and copied back every time db:migrate runs.
const { files: willRun } = split(all);
const unsafe = [];
for (const file of all) {
  const body = statements(readFileSync(join(ROOT, 'migrations', file), 'utf8')).join('\n');
  if (!/\bDROP\s+TABLE\b/i.test(body)) continue;
  if (willRun.indexOf(file) !== -1) unsafe.push(file);
}
check('a migration that drops a table is named .once.sql and left for a person',
  unsafe.length === 0, unsafe.join(', '));

// What the runner actually sends has to contain no empty statement.
// With `--remote` D1 splits the SQL server side, and that parser answers
// "SQL code did not contain a statement" for an empty one, which is not
// an already-applied message, so the run stops. Every file ends in
// ";\n", so the old "add a semicolon unless it ends in one" left a
// trailing empty statement in all of them and the run stopped on the
// first. It goes as one line (`--command` through cmd.exe on Windows,
// where a newline ends the command).
const badPayload = [];
for (const file of all) {
  const source = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  const sent = oneLine(payload(source));
  // split the way D1 would: on every semicolon, and look for a piece
  // with nothing in it
  const pieces = sent.split(';').slice(0, -1);
  const empty = pieces.filter(p => !p.trim()).length;
  const same = statements(sent).length === statements(source).length;
  const lines = /\n/.test(sent);
  if (empty || !same || lines) {
    badPayload.push(file + (empty ? ' (' + empty + ' empty)' : '') + (same ? '' : ' (statement count changed)') +
      (lines ? ' (more than one line)' : ''));
  }
}
check('what the runner sends is one line with no empty statement in it',
  badPayload.length === 0, badPayload.join(', '));
check('a quoted string keeps its spaces when the SQL is put on one line',
  oneLine("ALTER TABLE t\n  ADD COLUMN c TEXT DEFAULT 'a  b';\n") === "ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'a  b';",
  JSON.stringify(oneLine("ALTER TABLE t\n  ADD COLUMN c TEXT DEFAULT 'a  b';\n")));

// And the same for a single statement, which is the retry path.
check('a lone statement is sent with exactly one semicolon',
  payload('ALTER TABLE t ADD COLUMN c INTEGER') === 'ALTER TABLE t ADD COLUMN c INTEGER;\n' &&
  payload('ALTER TABLE t ADD COLUMN c INTEGER;\n') === 'ALTER TABLE t ADD COLUMN c INTEGER;\n',
  JSON.stringify(payload('ALTER TABLE t ADD COLUMN c INTEGER;\n')));

// A file with nothing but comments has nothing to send, and that is not
// a failure — it used to become a lone semicolon.
check('a comment-only file sends nothing at all', payload('-- just a note\n') === '');

// The comment that started it: schema.sql must not tell anyone to run
// DDL by hand. If it needs running, it needs a file in migrations/.
const byHand = current.split('\n')
  .filter(l => /^\s*--/.test(l) && /\bALTER\s+TABLE\b/i.test(l))
  .map(l => l.trim());
check('schema.sql asks nobody to run an ALTER by hand', byHand.length === 0, byHand.join(' | '));

// db:check reads schema.sql with one parser and the live database with
// another, and calls a difference between them a fault. So the two have
// to agree about a database that is right: every index in schema.sql,
// read from the file, has to match the same index read back out of
// sqlite_master after that file made it. db:check runs against a
// database this suite cannot reach, so this is the only place those
// parsers are exercised at all.
const readGaps = [];
for (const want1 of declaredIndexes(current)) {
  if (!wantIdx[want1.name]) { readGaps.push(want1.name + ' was not read from schema.sql'); continue; }
  if (!sameIndex(want1, wantIdx[want1.name])) readGaps.push(want1.name + ' reads differently');
}
if (declaredIndexes(current).length !== Object.keys(wantIdx).length) {
  readGaps.push(declaredIndexes(current).length + ' read, ' + Object.keys(wantIdx).length + ' created');
}
check("db:check's two readings of an index agree about a database that is right",
  readGaps.length === 0, readGaps.join(', '));

// The scripts and this suite are copies, because the check-in
// worker cannot import from the bot's folder — it is a separate worker
// with its own package. Copies drift, so they are compared here: a fix
// made in one and not the other fails in both.
const WORKERS = ['tab', 'checkin'];
const SHARED = ['scripts/deploy.mjs', 'scripts/migrate.mjs', 'scripts/db-check.mjs',
  'scripts/d1-run.mjs', 'scripts/secrets-check.mjs', 'scripts/backup.mjs', 'tests/verify-migrations.mjs'];
const drift = [];
for (const worker of WORKERS) {
  if (worker === HERE) continue;
  if (!existsSync(join(REPO, worker))) continue;
  for (const file of SHARED) {
    const theirs = join(REPO, worker, file);
    if (!existsSync(theirs)) { drift.push(worker + '/' + file + ' is missing'); continue; }
    if (readFileSync(theirs, 'utf8') !== readFileSync(join(ROOT, file), 'utf8')) {
      drift.push(worker + '/' + file + ' differs');
    }
  }
}
check('the database scripts are the same file in every worker', drift.length === 0, drift.join(', '));

console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
