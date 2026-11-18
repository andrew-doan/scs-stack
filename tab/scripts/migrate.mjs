// Applies the files in migrations/ that the remote D1 database has not
// had yet.
//
//   npm run db:migrate          the new ones
//   npm run db:migrate -- --all every file again
//
// What it has applied is kept in the database itself, in `_migrations`
// (a file's name and when). The first run against a database from
// before that table has nothing recorded, so it offers every file, as a
// run always used to, and records each; the runs after it offer only
// what is new. `--all` offers every file again, for a database put
// right by hand, and records them too. A file recorded and then edited
// is not offered again: a migration that needs changing is a new file.
//
// What this replaced, and why:
//
//   node scripts/deploy.mjs --dry && for f in migrations/*.sql; do
//     wrangler d1 execute <db> --remote --config wrangler.deploy.toml --file=$f || exit 1; done
//
// Two things were wrong with it. It is a POSIX shell loop, so on
// Windows it did not run at all. And `|| exit 1` stops at the first
// error — but an `ALTER TABLE ADD COLUMN` that has already been applied
// IS an error ("duplicate column name"), and SQLite has no
// `ADD COLUMN IF NOT EXISTS`. So a database that had had any of these
// before stopped on an old file and never reached the new ones, which
// is the exact failure the command existed to prevent.
//
// This runner knows the difference. A statement that fails because it
// is already there is counted and passed over; anything else stops the
// run and is printed in full. A file is tried whole first, because one
// wrangler call is much faster than one per statement, and only a file
// that comes back "already there" is retried a statement at a time —
// D1 stops at the failing statement, so the ones after it would
// otherwise be skipped.
//
// The SQL goes with --command, never --file. With --remote, --file goes
// through D1's import API: the database stops answering queries while
// it runs, and a file that fails is undone by resetting the whole
// database to where it was. An ALTER that is already applied is a
// failure, so a run over a database that was up to date reset it once
// for every file holding one and again for each such ALTER on its own,
// and a reset can come back as {"D1_RESET_DO":true} instead of the
// SQLite error behind it. That is
// not an already-applied message, so the run stopped there. --command
// is an ordinary query: the database keeps answering, and a failure
// comes back in SQLite's own words.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { wrangler, writeConfig, ROOT, dbName } from './deploy.mjs';

const DB = dbName();
const DIR = join(ROOT, 'migrations');

// Split a migration into statements. The files are DDL with `--`
// comments and at least one of those comments contains a semicolon, so
// comments come out before the split; single-quoted strings are
// respected because DEFAULT values hold both quotes and parentheses.
export function statements(sql) {
  const out = [];
  let current = '';
  let inString = false;
  let inComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inComment) {
      if (ch === '\n') { inComment = false; current += ch; }
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { inComment = true; i++; continue; }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === ';') { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

// The two ways SQLite says "that is already there". Everything else is
// a real failure and stops the run.
export function alreadyApplied(text) {
  return /duplicate column name|already exists/i.test(String(text || ''));
}

// What actually gets sent.
//
// This used to be `sql.endsWith(';') ? sql : sql + ';\n'`, and every
// file in migrations/ ends with `;` followed by a newline — so
// endsWith(';') was false for all of them and a second semicolon went
// on the end, leaving an empty statement between the two.
//
// Locally that is invisible: wrangler splits the SQL itself and drops
// empty statements. With `--remote` D1 splits it server side, and that
// parser rejects the empty one with
//
//   ✘ [ERROR] SQL code did not contain a statement.
//
// which is not one of the two "already applied" messages, so the runner
// treated it as a real failure and stopped — on the first file, every
// time, leaving every migration after it unapplied while every local
// test passed.
//
// Rebuilding from statements() rather than patching the end of the
// string makes it impossible to reintroduce: comments are gone, empty
// statements cannot survive the split, and a file that ends in a
// comment cannot produce a comment-only statement either.
export function payload(sql) {
  const parts = statements(sql);
  return parts.length ? parts.join(';\n') + ';\n' : '';
}

// --command carries the SQL as one argument, and on Windows that goes
// through cmd.exe, where a newline ends the command. So every run of
// whitespace becomes one space, except inside a quoted string. Comments
// are already gone (payload), so nothing depends on a line ending.
export function oneLine(sql) {
  return String(sql).split("'")
    .map((part, i) => i % 2 ? part : part.replace(/\s+/g, ' '))
    .join("'").trim();
}

// Which files the runner will apply and which it will only name.
//
// A `.once` file rebuilds a table — copy the rows out, drop it, create
// it again, copy them back — rather than altering one. There is no way
// for SQL like that to say it has already been done, and re-running it
// against a table that is already the new shape would do the whole
// thing again: with the rows copied first that is harmless, and one
// wrong line in it is the roster gone. So it is listed for a person to
// read and run, and never applied by a loop.
export function split(all) {
  return {
    files: all.filter(f => !f.endsWith('.once.sql')),
    once: all.filter(f => f.endsWith('.once.sql'))
  };
}

// The files still to offer: every one not recorded as applied.
export function pending(files, applied) {
  const done = new Set(applied);
  return files.filter(f => !done.has(f));
}

// The rows of the first result in what `wrangler d1 execute --json`
// prints, which may have other lines before the JSON.
export function rowsOf(output) {
  const text = String(output || '');
  const at = text.indexOf('[');
  if (at < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(at));
    return (parsed[0] && parsed[0].results) || [];
  } catch (err) {
    return [];
  }
}

function d1(command, json) {
  const args = ['d1', 'execute', DB, '--remote', '--config', 'wrangler.deploy.toml', '--command', command];
  if (json) args.push('--json');
  const res = wrangler(args, 'all');
  return { ok: res.status === 0, output: String(res.stdout || '') + String(res.stderr || '') };
}

// The ledger, made if it is not there, and what it holds. Null when it
// could not be read: then every file is offered, as before the ledger.
function appliedFiles() {
  const made = d1('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (!made.ok) return null;
  const read = d1('SELECT name FROM _migrations', true);
  if (!read.ok) return null;
  return rowsOf(read.output).map(r => r.name);
}

function record(file) {
  return d1("INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('" +
    file.replace(/'/g, "''") + "', datetime('now'))").ok;
}

function runSql(sql) {
  const body = payload(sql);
  // nothing but comments: there is no statement to send and no failure
  if (!body) return { ok: true, output: '' };
  const res = wrangler(
    ['d1', 'execute', DB, '--remote', '--config', 'wrangler.deploy.toml', '--command', oneLine(body)],
    'all'
  );
  return {
    ok: res.status === 0,
    output: String(res.stdout || '') + String(res.stderr || '')
  };
}

// The files that are left for a person, printed the same way whether
// anything else ran or not.
function listOnce(once) {
  if (!once.length) return;
  console.log('\nNot run, because re-running them would redo the whole thing:');
  for (const f of once) console.log('  migrations/' + f);
  console.log('\nnpm run db:check will say whether they are still needed.');
}

function main() {
  const { files, once } = split(readdirSync(DIR).filter(f => f.endsWith('.sql')).sort());
  if (!files.length) {
    console.log('No migrations to run.');
    listOnce(once);
    return 0;
  }

  try {
    writeConfig();
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  let todo = files;
  if (process.argv.indexOf('--all') === -1) {
    const done = appliedFiles();
    if (done === null) {
      console.log('Could not read the list of applied migrations, so every file is offered.');
    } else {
      todo = pending(files, done);
      if (files.length - todo.length) {
        console.log((files.length - todo.length) + ' already applied and recorded; offering ' + todo.length + '.');
      }
    }
  }
  if (!todo.length) {
    console.log('Nothing new to apply.');
    listOnce(once);
    return 0;
  }

  let applied = 0;
  let skipped = 0;

  for (const file of todo) {
    const sql = readFileSync(join(DIR, file), 'utf8');
    const whole = runSql(sql);
    if (whole.ok) {
      applied++;
      record(file);
      console.log('applied  ' + file);
      continue;
    }
    if (!alreadyApplied(whole.output)) {
      console.error('\n' + file + ' failed:\n' + whole.output.trim());
      console.error('\nStopped here. Nothing after this file has been applied.');
      return 1;
    }
    // Part of this file is already there. D1 stops at the statement
    // that failed, so the rest of the file has to be offered one at a
    // time or everything after it would be skipped.
    const parts = statements(sql);
    let ran = 0;
    let had = 0;
    for (const part of parts) {
      const one = runSql(part);
      if (one.ok) { ran++; continue; }
      if (alreadyApplied(one.output)) { had++; continue; }
      console.error('\n' + file + ' failed on:\n  ' + part.replace(/\s+/g, ' ').slice(0, 120));
      console.error('\n' + one.output.trim());
      console.error('\nStopped here. Nothing after this file has been applied.');
      return 1;
    }
    if (ran) applied++; else skipped++;
    record(file);
    console.log((ran ? 'applied  ' : 'already  ') + file +
      '  (' + ran + ' new, ' + had + ' already there)');
  }

  console.log('\n' + applied + ' migration' + (applied === 1 ? '' : 's') + ' applied, ' +
    skipped + ' already up to date.');
  listOnce(once);
  return 0;
}

// importable for the tests, which check the two judgement calls above
// without going near a network
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
