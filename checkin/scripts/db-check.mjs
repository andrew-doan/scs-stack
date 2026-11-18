// Compares the live D1 database against schema.sql and says exactly
// what it is missing.
//
//   npm run db:check
//
// Why this exists. The worker turns "no such column: X" into "the
// database is behind the code: run npm run db:migrate", and that is the
// right advice for almost everything — but not for a column whose
// migration was never written. `db:migrate` then runs clean and changes
// nothing, `db:schema` cannot help either (CREATE TABLE IF NOT EXISTS
// over a table that already exists does nothing), and there is no way
// to tell from the outside which of the three situations you are in.
// This reads the live schema and tells you.
//
// It checks four things, because they fail in four different ways and
// only the first one announces itself:
//
//   tables      missing, and every query against one is an error
//   columns     missing, and every query naming one is an error
//   indexes     missing, and nothing is an error — the queries still
//               answer, just slowly, and a UNIQUE one has quietly
//               stopped enforcing what it was put there for
//   constraints left over, and nothing is an error either — a UNIQUE
//               the schema has since dropped is still refusing rows
//               the code expects to be able to insert
//
// It only reads. Anything it finds is printed as the SQL that would fix
// it, for you to run — a script that quietly alters the live database
// during an event is not something anybody wants.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { wrangler, writeConfig, ROOT, dbName } from './deploy.mjs';

const DB = dbName();
// gitignored, like the other generated files beside it
const REPAIR = 'wrangler.repair.sql';

// Which migration would add each thing, so a gap can be reported as
// "run db:migrate" rather than as SQL to type in. Without this the
// report reads the same whether the migration is missing or simply has
// not been run, and those want opposite things done about them.
export function covers(files) {
  const byTable = {};
  const byColumn = {};
  const byIndex = {};
  const byRebuild = {};
  for (const [name, sql] of files) {
    let m;
    const alter = /ALTER\s+TABLE\s+([A-Za-z_]\w*)\s+ADD\s+COLUMN\s+([A-Za-z_]\w*)/gi;
    while ((m = alter.exec(sql))) byColumn[m[1] + '.' + m[2]] = name;
    const create = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)/gi;
    while ((m = create.exec(sql))) if (!byTable[m[1]]) byTable[m[1]] = name;
    const index = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)/gi;
    while ((m = index.exec(sql))) if (!byIndex[m[1]]) byIndex[m[1]] = name;
    // A file that drops a table is rebuilding it, and rebuilding is the
    // only way to change a column constraint.
    const drop = /DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+([A-Za-z_]\w*)/gi;
    while ((m = drop.exec(sql))) byRebuild[m[1]] = name;
  }
  return { byTable, byColumn, byIndex, byRebuild };
}

// Tables and their columns, as schema.sql declares them. The file is
// plain DDL: one column to a line, constraints on lines of their own.
export function declared(sql) {
  const out = {};
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)\s*\(([\s\S]*?)\n\)\s*;/gi;
  let m;
  while ((m = re.exec(sql))) {
    const cols = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/--.*/, '').trim().replace(/,$/, '');
      if (!line) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
      const name = /^([A-Za-z_]\w*)/.exec(line);
      if (name) cols.push({ name: name[1], decl: line });
    }
    out[m[1]] = cols;
  }
  return out;
}

// Indexes, as schema.sql declares them. Compared by what they mean
// rather than by their text: the table, the columns, whether they are
// UNIQUE and what they are restricted to. Two spellings of the same
// index are the same index; a UNIQUE one that has lost its WHERE clause
// is a different one, and refuses rows the code expects to insert.
export function declaredIndexes(sql) {
  const out = [];
  const re = /CREATE\s+(UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\s*\(([^)]*)\)([^;]*);/gi;
  let m;
  while ((m = re.exec(sql))) {
    out.push({
      name: m[2],
      table: m[3],
      unique: !!m[1],
      cols: m[4].split(',').map(s => s.trim()).filter(Boolean).join(', '),
      where: m[5].replace(/\s+/g, ' ').trim(),
      sql: m[0].replace(/\s+/g, ' ').trim()
    });
  }
  return out;
}

// The same reading of an index, taken from what SQLite stored. An
// auto-index — the one SQLite makes for a column marked UNIQUE — has no
// SQL at all and is reported as a constraint instead.
export function readIndex(name, sql) {
  const parsed = declaredIndexes(String(sql || '').replace(/;?\s*$/, ';'));
  return parsed.length ? parsed[0] : { name: name, table: '', unique: false, cols: '', where: '', sql: '' };
}

export function sameIndex(a, b) {
  return a.unique === b.unique && a.table === b.table &&
    a.cols.toLowerCase() === b.cols.toLowerCase() &&
    a.where.toLowerCase() === b.where.toLowerCase();
}

// The CREATE TABLE for one table, as schema.sql writes it.
export function createFor(sql, table) {
  const re = new RegExp(
    'CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+' + table + '\\s*\\([\\s\\S]*?\\n\\)\\s*;', 'i');
  const m = re.exec(sql);
  return m ? m[0] : '';
}

// Columns a CREATE TABLE marks UNIQUE on the column itself, which is
// the one thing in a schema that no migration can change: SQLite has no
// DROP CONSTRAINT, so the table has to be copied, dropped and renamed.
// Reading them off both sides is the only way to tell whether a rebuild
// that was meant to be run by hand ever was.
//
// The body is split on commas at depth 0 rather than on newlines: the
// live text is whatever was typed when the table was made, which is not
// necessarily laid out one column to a line.
export function uniqueColumns(create) {
  const text = String(create || '').replace(/--[^\n]*/g, '');
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close < open) return [];
  const parts = [];
  let cur = '';
  let depth = 0;
  let inString = false;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i];
    if (inString) { cur += ch; if (ch === "'") inString = false; continue; }
    if (ch === "'") { inString = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = [];
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(line)) continue;
    if (!/\bUNIQUE\b/i.test(line)) continue;
    const name = /^([A-Za-z_]\w*)/.exec(line);
    if (name) out.push(name[1]);
  }
  return out;
}

// What a live table is missing, given what it has.
export function missing(want, have) {
  return want.filter(c => have.indexOf(c.name) === -1);
}

function query(sql) {
  const res = wrangler(
    ['d1', 'execute', DB, '--remote', '--config', 'wrangler.deploy.toml', '--json', '--command', sql],
    'all'
  );
  const text = String(res.stdout || '');
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('[')));
    return parsed[0] && parsed[0].results ? parsed[0].results : [];
  } catch (err) {
    throw new Error('could not read the database:\n' + text + String(res.stderr || ''));
  }
}

function main() {
  const schema = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
  const want = declared(schema);
  const wantIndexes = declaredIndexes(schema);
  const dir = join(ROOT, 'migrations');
  const known = covers(readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => [f, readFileSync(join(dir, f), 'utf8')]));

  try { writeConfig(); } catch (err) {
    console.error(err.message);
    return 1;
  }

  let liveTables;
  let liveIndexes;
  try {
    liveTables = query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    liveIndexes = query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'");
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const live = liveTables.map(r => r.name);
  const createdAs = {};
  for (const row of liveTables) createdAs[row.name] = row.sql || '';

  const fixes = [];
  const absent = [];
  const rebuilds = [];
  for (const table of Object.keys(want)) {
    if (live.indexOf(table) === -1) { absent.push(table); continue; }
    const have = query("SELECT name FROM pragma_table_info('" + table + "')").map(r => r.name);
    for (const col of missing(want[table], have)) {
      fixes.push({ table, col: col.name, sql: 'ALTER TABLE ' + table + ' ADD COLUMN ' + col.decl + ';' });
    }
    // A CREATE TABLE is stored verbatim, so the live text is the
    // schema.sql that made it — which is what makes this comparable.
    // Without the text there is nothing to compare, and guessing would
    // report every UNIQUE in the schema as missing.
    if (!createdAs[table]) continue;
    const wantUnique = uniqueColumns(createFor(schema, table));
    const haveUnique = uniqueColumns(createdAs[table]);
    for (const col of haveUnique) {
      if (wantUnique.indexOf(col) === -1) rebuilds.push({ table, col, extra: true });
    }
    for (const col of wantUnique) {
      if (have.indexOf(col) !== -1 && haveUnique.indexOf(col) === -1) {
        rebuilds.push({ table, col, extra: false });
      }
    }
  }

  const byName = {};
  for (const row of liveIndexes) byName[row.name] = row;
  const lostIndexes = [];
  const wrongIndexes = [];
  for (const want1 of wantIndexes) {
    if (absent.indexOf(want1.table) !== -1) continue;   // the table itself is the gap
    const row = byName[want1.name];
    if (!row) { lostIndexes.push(want1); continue; }
    const live1 = readIndex(row.name, row.sql);
    if (!sameIndex(want1, live1)) wrongIndexes.push({ want: want1, have: live1, sql: row.sql });
  }

  console.log('Checked ' + Object.keys(want).length + ' tables and ' + wantIndexes.length +
    ' indexes in schema.sql against ' + DB + '.\n');
  if (!absent.length && !fixes.length && !lostIndexes.length && !wrongIndexes.length && !rebuilds.length) {
    console.log('The live database has every table, column and index the code expects,');
    console.log('and no constraint the schema has since dropped.');
    console.log('If the site is still saying the database is behind, the worker is the');
    console.log('thing that is behind: run npm run deploy.');
    return 0;
  }

  if (absent.length) {
    console.log('Tables that are not there at all:');
    for (const t of absent) {
      console.log('  ' + t.padEnd(22) + (known.byTable[t] ? 'migrations/' + known.byTable[t] : ''));
    }
    console.log('\n  Fix: npm run db:schema   (it only creates what is missing)\n');
  }
  if (fixes.length) {
    const held = fixes.filter(f => known.byColumn[f.table + '.' + f.col]);
    const orphan = fixes.filter(f => !known.byColumn[f.table + '.' + f.col]);
    console.log('Columns that are not there:');
    for (const f of fixes) {
      const where = known.byColumn[f.table + '.' + f.col];
      console.log('  ' + (f.table + '.' + f.col).padEnd(30) +
        (where ? 'migrations/' + where : 'no migration adds this'));
    }
    console.log('\n  npm run db:schema cannot add a column. Re-running a CREATE TABLE over');
    console.log('  a table that already exists does nothing at all — it does not compare');
    console.log('  columns — so it exits successfully and changes nothing.\n');
    if (held.length) {
      console.log('  ' + held.length + ' of these have a migration and are simply not applied:\n');
      console.log('    npm run db:migrate\n');
      console.log('  If that has already been run, it did not get this far. It stops at the');
      console.log('  first real error and says which file, so run it again and read the top');
      console.log('  of the output rather than the end.\n');
    }
    if (orphan.length) {
      console.log('  These have no migration at all. They are written out to the file');
      console.log('  named below rather than printed to paste at a shell: the SQL has');
      console.log("  DEFAULT '' in it, and depending on the shell those two quotes are");
      console.log('  eaten, which leaves wrangler with nothing and it answers "SQL code');
      console.log('  did not contain a statement". Run the file, then add it to');
      console.log('  migrations/ so the next database does not need it run by hand.\n');
      let awkward = 0;
      const lines = [];
      for (const f of orphan) {
        // SQLite will not add a NOT NULL column with no default to a table
        // that already has rows, so say so rather than letting the ALTER
        // fail with a message about a null value
        const hard = /\bNOT\s+NULL\b/i.test(f.sql) && !/\bDEFAULT\b/i.test(f.sql);
        console.log('  ' + f.sql + (hard ? '        <- see below' : ''));
        lines.push(f.sql);
        if (hard) awkward++;
      }
      const out = join(ROOT, REPAIR);
      writeFileSync(out, '-- Written by npm run db:check. Not committed.\n' + lines.join('\n') + '\n');
      console.log('\n  Written to ' + REPAIR + '. Run it with:\n');
      console.log('    npx wrangler d1 execute ' + DB + ' --remote \\');
      console.log('      --config wrangler.deploy.toml --file=' + REPAIR);
      if (awkward) {
        console.log('\n  The lines marked above are NOT NULL with no default, and SQLite will');
        console.log('  refuse to add one to a table that has rows in it. That usually means');
        console.log('  the table is far enough behind to be worth rebuilding: copy the rows');
        console.log('  out, drop it, run npm run db:schema, copy them back.');
      }
    }
    console.log('');
  }
  if (lostIndexes.length) {
    console.log('Indexes that are not there:');
    for (const i of lostIndexes) {
      console.log('  ' + i.name.padEnd(30) +
        (known.byIndex[i.name] ? 'migrations/' + known.byIndex[i.name] : 'schema.sql'));
    }
    console.log('\n  Nothing reports a missing index. Every query still answers — a plain');
    console.log('  one just reads the whole table, and a UNIQUE one has stopped refusing');
    console.log('  the duplicate it was put there to refuse.\n');
    console.log('  Fix: npm run db:schema. Unlike a column, an index CAN be added to a');
    console.log('  table that already exists, and every one in schema.sql is written');
    console.log('  CREATE INDEX IF NOT EXISTS, so running it again creates the missing');
    console.log('  ones and leaves the rest alone.\n');
  }
  if (wrongIndexes.length) {
    console.log('Indexes that are there but say something else:');
    for (const w of wrongIndexes) {
      console.log('  ' + w.want.name);
      console.log('    schema.sql  ' + w.want.sql);
      console.log('    live        ' + String(w.sql || '').replace(/\s+/g, ' ').trim());
    }
    console.log('\n  An index can be dropped, so this one is straightforward to correct:');
    console.log('  DROP INDEX <name>, then npm run db:schema to put the right one back.\n');
  }
  if (rebuilds.length) {
    console.log('Column constraints that do not match schema.sql:');
    for (const r of rebuilds) {
      console.log('  ' + (r.table + '.' + r.col).padEnd(30) +
        (r.extra ? 'live table still has UNIQUE on it' : 'live table has no UNIQUE on it'));
    }
    const files = [];
    for (const r of rebuilds) {
      const f = known.byRebuild[r.table];
      if (f && files.indexOf(f) === -1) files.push(f);
    }
    console.log('\n  SQLite has no DROP CONSTRAINT: a constraint written into a CREATE');
    console.log('  TABLE can only be changed by copying the rows out, dropping the table,');
    console.log('  creating it again and copying them back. That is why no ordinary');
    console.log('  migration closes this gap and why db:migrate cannot.\n');
    if (files.length) {
      console.log('  The migration that rebuilds it has been written and has not been run:\n');
      for (const f of files) console.log('    migrations/' + f);
      console.log('\n  Run it once, by hand:\n');
      console.log('    npx wrangler d1 execute ' + DB + ' --remote \\');
      console.log('      --config wrangler.deploy.toml --file=migrations/' + files[0]);
      console.log('\n  Read it first. It drops a table, so it is the one file here that');
      console.log('  cannot be run twice.\n');
    } else {
      console.log('  No file in migrations/ rebuilds this table. One needs writing.\n');
    }
  }
  return 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
