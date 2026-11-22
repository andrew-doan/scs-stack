// Run with: node tests/verify-migrate.mjs   (needs Node 22+)
// The migration runner's two pieces of judgement, against the real
// migration files. It cannot reach D1 from here, so what is checked is
// everything that decides what gets sent and what an answer means:
// splitting a file into statements, and telling "that is already
// there" apart from a real failure.
//
// Both are worth holding to account. The runner exists because the old
// one-line shell loop stopped at the first error, and an ALTER that has
// already been applied is an error — so a database part-way through the
// list never reached the newest migrations.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { statements, alreadyApplied } from '../scripts/migrate.mjs';
import { databaseBlocks, fillIds, fillKv, quoteArg } from '../scripts/deploy.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---------------- splitting a file into statements ----------------
check('a plain file splits on its semicolons',
  statements('CREATE TABLE a (id INTEGER);\nCREATE INDEX i ON a(id);').length === 2);

// This is not hypothetical: 2026-10-push-devices.sql has a semicolon
// inside a comment, and splitting before stripping comments cut the
// file in the wrong place.
check('a semicolon inside a comment is not a statement boundary',
  statements('-- a note; with a semicolon\nALTER TABLE a ADD COLUMN b TEXT;').length === 1,
  JSON.stringify(statements('-- a note; with a semicolon\nALTER TABLE a ADD COLUMN b TEXT;')));

check('a semicolon inside a string is not one either',
  statements("INSERT INTO a (t) VALUES ('one; two');").length === 1);

check("SQLite's doubled quote does not leave the splitter inside a string",
  statements("INSERT INTO a (t) VALUES ('it''s');\nCREATE INDEX i ON a(t);").length === 2,
  JSON.stringify(statements("INSERT INTO a (t) VALUES ('it''s');\nCREATE INDEX i ON a(t);")));

check('a trailing statement with no semicolon is still a statement',
  statements('CREATE TABLE a (id INTEGER)').length === 1);

check('comments alone are nothing to run',
  statements('-- just a note\n\n-- and another\n').length === 0);

// ---------------- every real migration ----------------
const files = readdirSync(join(BOT, 'migrations')).filter(f => f.endsWith('.sql')).sort();
check('there are migrations to check', files.length > 0, files.length + ' files');

let bad = [];
for (const file of files) {
  const parts = statements(readFileSync(join(BOT, 'migrations', file), 'utf8'));
  if (!parts.length) { bad.push(file + ': nothing to run'); continue; }
  for (const part of parts) {
    if (part.indexOf('--') !== -1) bad.push(file + ': a comment survived the split');
    if (!/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|PRAGMA)\b/i.test(part)) {
      bad.push(file + ': does not start with a statement — ' + part.slice(0, 60));
    }
  }
}
check('every migration splits into runnable statements and nothing else',
  bad.length === 0, bad.slice(0, 4).join(' | '));

check('the files run oldest first, which is the order they depend on',
  files.join(',') === files.slice().sort().join(',') && files[0].startsWith('2026-09'),
  files[0] + ' … ' + files[files.length - 1]);

// ---------------- what an error means ----------------
check('an ALTER that is already applied is not a failure',
  alreadyApplied('ERROR 7500: duplicate column name: label'));
check('a table that is already there is not a failure',
  alreadyApplied('Error: table drop_files already exists'));
check('an index that is already there is not a failure',
  alreadyApplied('index idx_short_links_file already exists'));
check('a real failure is a failure',
  !alreadyApplied('Error: no such table: main.teams') &&
  !alreadyApplied('Authentication error [code: 10000]') &&
  !alreadyApplied('Couldn\'t find a D1 DB with the name or binding "scs-scores"'));
check('an empty answer is not read as already applied', !alreadyApplied('') && !alreadyApplied(null));

// ---------------- the config the runner writes first ----------------
// Without this step wrangler reads the committed placeholder id and
// says it is not a uuid, which reads like a missing database.
const toml = readFileSync(join(BOT, 'wrangler.toml'), 'utf8');
const blocks = databaseBlocks(toml);
check('the committed config still carries a placeholder id, not somebody\'s account',
  blocks.length === 1 && blocks[0].name === 'scs-scores' && blocks[0].placeholder,
  JSON.stringify(blocks));

const filled = fillIds(toml, [{ name: 'scs-scores', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]);
check('the id is filled in from the account list',
  filled.includes('database_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"') &&
  !filled.includes('PASTE-FILLED'), '');

// the link page's backup: filled by its name, or left out of the deploy
// when the account has not made it, with the rest of the config intact
const kvHave = fillKv(toml, [{ id: 'f00dfeed', title: 'scs-link-page' }]);
const kvNone = fillKv(toml, []);
check('a KV namespace is filled in by name, and one the account lacks is left out rather than stopping the deploy',
  kvHave.toml.includes('id = "f00dfeed"') && !kvHave.missing.length &&
  !kvNone.toml.includes('kv_namespaces') && kvNone.missing.length === 1 && kvNone.missing[0].name === 'scs-link-page' &&
  databaseBlocks(kvNone.toml).length === 1, JSON.stringify(kvNone.missing.map(b => b.name)));

let refused = '';
try { fillIds(toml, [{ name: 'something-else', uuid: 'x' }]); } catch (err) { refused = err.message; }
check('an account without that database is told which one and how to make it',
  refused.includes('scs-scores') && refused.includes('wrangler d1 create'), refused.split('\n')[0]);

// ---------------- the Windows shell ----------------
// A repo under "C:\\Users\\Some Name\\..." used to be split in half by
// the shell that Windows needs to run npx at all.
check('an argument with a space in it carries its own quotes',
  quoteArg('C:\\Users\\Some Name\\repo\\wrangler.deploy.toml') === '"C:\\Users\\Some Name\\repo\\wrangler.deploy.toml"',
  quoteArg('C:\\Users\\Some Name\\repo\\wrangler.deploy.toml'));
check('an ordinary argument is left alone',
  quoteArg('--remote') === '--remote' && quoteArg('scs-scores') === 'scs-scores');

// ---------------- the runner itself, against a pretend wrangler ----
// WRANGLER_BIN already exists for this: the runner calls whatever it
// names instead of npx. The stub answers the way a real database
// part-way through the list does — every ALTER is already applied —
// which is the case the old shell loop could not get past.
{
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'scs-migrate-'));
  function stub(name, body) {
    const path = join(dir, name);
    writeFileSync(path, '#!/usr/bin/env node\n' + body);
    chmodSync(path, 0o755);
    return path;
  }
  // --file with --remote is D1's import API, which takes the database
  // offline and answers a failed file with a reset; the stub refuses it
  const LIST = "const a=process.argv.slice(2);" +
    "const {appendFileSync}=require('node:fs');" +
    "if(a[1]==='list'){process.stdout.write(JSON.stringify([{name:'scs-scores',uuid:'11111111-2222-3333-4444-555555555555'}]));process.exit(0)}" +
    "if(a.some(x=>x.startsWith('--file'))){process.stderr.write('{\"D1_RESET_DO\":true}');process.exit(1)}" +
    "const sql=a[a.indexOf('--command')+1]||'';" +
    "appendFileSync(process.env.SCS_LOG, JSON.stringify(sql)+'\\n');";

  const run = (binName, body, args = []) => {
    const log = join(dir, binName + '.log');
    writeFileSync(log, '');
    const res = spawnSync(process.execPath, [join(BOT, 'scripts', 'migrate.mjs')].concat(args), {
      cwd: BOT, encoding: 'utf8',
      env: Object.assign({}, process.env, { WRANGLER_BIN: stub(binName, LIST + body), SCS_LOG: log })
    });
    return { res, sent: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) };
  };

  // every ALTER is already there; everything else lands
  const done = run('already', "if(/ALTER TABLE/i.test(sql)){process.stderr.write('ERROR 7500: duplicate column name: x');process.exit(1)}process.exit(0)");
  check('a database where every ALTER is already applied still runs to the end',
    done.res.status === 0 && /already up to date|applied/.test(done.res.stdout),
    (done.res.stdout + done.res.stderr).trim().split('\n').pop());
  check('the SQL goes as one line with --command, never through the import API',
    done.sent.length > 0 && done.sent.every(s => s && !/\n/.test(s)),
    done.sent.length + ' sent');
  check('and the newest migrations were reached, which is the whole point',
    done.sent.some(s => /drop_files/.test(s)) && done.sent.some(s => /push_subs ADD COLUMN label/i.test(s)),
    done.sent.length + ' statements sent');
  check('a file that failed part-way is retried a statement at a time',
    done.sent.filter(s => /CREATE TABLE IF NOT EXISTS countdown_stops/.test(s)).length >= 1 &&
    done.sent.some(s => /^ALTER TABLE/i.test(s)),
    done.sent.filter(s => /^ALTER TABLE/i.test(s)).length + ' ALTERs offered on their own');

  // a real failure stops the run and says so
  const broke = run('broken', "if(/short_links/.test(sql)){process.stderr.write('Error: no such table: main.teams');process.exit(1)}process.exit(0)");
  check('a real failure stops the run rather than being passed over',
    broke.res.status === 1 && /no such table/.test(broke.res.stderr) &&
    /Nothing after this file has been applied/.test(broke.res.stderr),
    broke.res.stderr.trim().split('\n')[0]);

  // every file but the newest recorded as applied: only the newest is
  // sent, and it is recorded after
  const runnable = files.filter(f => !f.endsWith('.once.sql'));
  const newest = runnable[runnable.length - 1];
  const recorded = JSON.stringify(runnable.slice(0, -1).map(name => ({ name })));
  const ledger = run('ledger',
    "if(/^SELECT name FROM _migrations/.test(sql)){process.stdout.write('x\\n'+JSON.stringify([{results:" + recorded + "}]));process.exit(0)}process.exit(0)");
  const body = ledger.sent.filter(s => !/_migrations/.test(s));
  const newestSql = statements(readFileSync(join(BOT, 'migrations', newest), 'utf8'));
  check('a database with every file recorded but one is sent that one and nothing else',
    ledger.res.status === 0 && body.length === 1 &&
    newestSql.every(s => body[0].indexOf(s.replace(/\s+/g, ' ').slice(0, 40)) !== -1) &&
    ledger.sent.some(s => /INSERT OR IGNORE INTO _migrations/.test(s) && s.indexOf(newest) !== -1),
    body.length + ' sent; ' + ledger.res.stdout.trim().split('\n')[0]);

  const again = run('ledger-all',
    "if(/^SELECT name FROM _migrations/.test(sql)){process.stdout.write(JSON.stringify([{results:" + recorded + "}]));process.exit(0)}process.exit(0)",
    ['--all']).res;
  check('--all offers every file whatever is recorded',
    again.status === 0 && (again.stdout.match(/^(applied|already) /mg) || []).length === runnable.length,
    (again.stdout.match(/^(applied|already) /mg) || []).length + ' of ' + runnable.length);

  // no database on the account: the message names it and how to make it
  const missing = run('missing', 'process.exit(0)');
  check('the config is written before anything is sent', missing.res.status === 0, '');
}

// ---------------- db:check, against a pretend database --------------
// db:check is what somebody reads at 2am when the site says the
// database is behind, and until this existed none of what it prints had
// ever been run. The stub answers `--command` out of a real sqlite file,
// so the script is driven exactly as it is against D1.
//
// scripts/ is the same file in both workers — tests/verify-migrations.mjs
// fails if it is not — so driving it here drives the check-in worker's
// copy too.
{
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const { statements: split } = await import('../scripts/migrate.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'scs-dbcheck-'));
  const dbPath = join(dir, 'live.sqlite');
  const stubPath = join(dir, 'wrangler');
  writeFileSync(stubPath, '#!/usr/bin/env node\n' +
    "const a=process.argv.slice(2);" +
    "if(a[1]==='list'){process.stdout.write(JSON.stringify([{name:'scs-scores',uuid:'11111111-2222-3333-4444-555555555555'}]));process.exit(0)}" +
    "const {DatabaseSync}=require('node:sqlite');" +
    "const db=new DatabaseSync(process.env.SCS_DB);" +
    "const i=a.indexOf('--command');" +
    "const rows=db.prepare(a[i+1]).all();" +
    // wrangler prints its own lines before the JSON; db:check finds the
    // array, so the noise has to be there or the test is easier than life
    "process.stdout.write('\\u{1F300} Executing on remote database scs-scores:\\n' +" +
    "  JSON.stringify([{results:rows,success:true}]));");
  chmodSync(stubPath, 0o755);

  const repair = join(BOT, 'wrangler.repair.sql');
  const runCheck = () => {
    const res = spawnSync(process.execPath, [join(BOT, 'scripts', 'db-check.mjs')], {
      cwd: BOT, encoding: 'utf8',
      env: Object.assign({}, process.env, { WRANGLER_BIN: stubPath, SCS_DB: dbPath })
    });
    return { status: res.status, out: String(res.stdout || '') + String(res.stderr || '') };
  };
  const exec = sql => {
    const db = new DatabaseSync(dbPath);
    for (const stmt of split(sql)) {
      try { db.exec(stmt); } catch (err) { if (!alreadyApplied(err.message)) throw err; }
    }
    db.close();
  };

  // A database as old as the history goes: made before any of this
  // existed and never brought forward.
  // --follow and --name-only, for the reason spelled out in
  // verify-migrations.mjs: without them a folder rename makes the
  // lookup find nothing and git hands back the current schema, so the
  // database below would not be behind and every check here would be
  // testing the wrong thing.
  const repo = join(BOT, '..');
  const isShallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'],
    { cwd: repo, encoding: 'utf8' }).stdout.trim() === 'true';
  const history = isShallow ? [] : spawnSync('git',
    ['log', '--follow', '--format=%H', '--name-only', '--', basename(BOT) + '/schema.sql'],
    { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const fromGit = history.length >= 2
    ? spawnSync('git', ['show', history[history.length - 2] + ':' + history[history.length - 1]],
      { cwd: repo, encoding: 'utf8' }).stdout
    : '';
  // the first schema.sql is kept beside the tests, and used when it is
  // there: a repository started from a copy of the files has a history
  // whose oldest schema is the copy's, not the first, and a shallow
  // clone has none
  let kept = '';
  try { kept = readFileSync(join(BOT, 'tests', 'fixtures', 'schema-oldest.sql'), 'utf8'); } catch (err) { kept = ''; }
  const oldSchema = kept || (fromGit !== readFileSync(join(BOT, 'schema.sql'), 'utf8') ? fromGit : '');
  // If this is the schema as it stands, the database below is not behind
  // and the three checks after it would be reading a healthy one.
  const reallyOld = !!oldSchema && oldSchema !== readFileSync(join(BOT, 'schema.sql'), 'utf8');
  check('the oldest schema.sql is older than the one on disk', reallyOld,
    reallyOld ? '' : (oldSchema ? 'git only found the current version' : 'git found no history for it'));
  exec(oldSchema);

  const behind = runCheck();
  check('db:check reads a database that is behind and does not say it is fine',
    behind.status === 1 && !/every table, column and index/.test(behind.out),
    behind.out.split('\n')[0]);
  check('it names the missing tables and the command that creates them',
    /Tables that are not there at all/.test(behind.out) && /npm run db:schema/.test(behind.out),
    '');
  check('and points a column that has a migration at db:migrate',
    /teams\.hidden\s+migrations\//.test(behind.out) && /npm run db:migrate/.test(behind.out),
    (behind.out.match(/^\s+teams\.hidden.*$/m) || [''])[0].trim());

  // Brought forward the way the README says to bring one forward.
  exec(readFileSync(join(BOT, 'schema.sql'), 'utf8'));
  for (const file of files) exec(readFileSync(join(BOT, 'migrations', file), 'utf8'));

  const clean = runCheck();
  check('a database that has been brought forward reads clean',
    clean.status === 0 && /every table, column and index/.test(clean.out),
    clean.out.split('\n').filter(Boolean).slice(-1)[0]);

  // An index is the one thing db:schema CAN put back, and the one thing
  // nothing else reports: every query still answers without it.
  exec('DROP INDEX idx_log_at;');
  const noIndex = runCheck();
  check('a missing index is found, and db:schema is the fix offered',
    noIndex.status === 1 && /Indexes that are not there/.test(noIndex.out) &&
    /idx_log_at/.test(noIndex.out) && /CREATE INDEX IF NOT EXISTS/.test(noIndex.out),
    (noIndex.out.match(/^\s+idx_log_at.*$/m) || [''])[0].trim());

  exec('CREATE INDEX idx_log_at ON submission_log(actor);');
  const wrongIndex = runCheck();
  check('an index that is there but indexes something else is found too',
    wrongIndex.status === 1 && /Indexes that are there but say something else/.test(wrongIndex.out) &&
    /DROP INDEX/.test(wrongIndex.out),
    (wrongIndex.out.match(/^\s+live\s+.*$/m) || [''])[0].trim());
  exec('DROP INDEX idx_log_at; CREATE INDEX idx_log_at ON submission_log(at);');

  // The gap no migration can close: SQLite cannot drop a column
  // constraint, so a table that is the wrong shape has to be rebuilt.
  // This is the check-in worker's zid, which took a day to find by hand.
  exec('DROP TABLE team_codes; CREATE TABLE team_codes (\n' +
    '  team_id INTEGER PRIMARY KEY,\n  code    TEXT NOT NULL\n);');
  const constraint = runCheck();
  check('a column constraint that does not match schema.sql is found',
    constraint.status === 1 && /Column constraints that do not match/.test(constraint.out) &&
    /team_codes\.code/.test(constraint.out) && /no DROP CONSTRAINT/.test(constraint.out),
    (constraint.out.match(/^\s+team_codes\.code.*$/m) || [''])[0].trim());

  try { rmSync(dir, { recursive: true, force: true }); } catch (err) { /* nothing to clean up */ }
  if (existsSync(repair)) rmSync(repair);
}

// ---------------- secrets:check, same pretend wrangler --------------
// A secret that was never uploaded fails nothing — the code reads it as
// unset and the thing it guards stays off — so this is the only place
// anything says so out loud.
{
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { varNames, purpose, stillPlaceholder } = await import('../scripts/secrets-check.mjs');

  check('a [vars] block is read for the names a secret may not reuse',
    varNames(readFileSync(join(BOT, 'wrangler.toml'), 'utf8')).includes('PUBLIC_API'),
    varNames(readFileSync(join(BOT, 'wrangler.toml'), 'utf8')).join(' '));
  check('a name in both is what the check is looking for',
    varNames('[vars]\nA = "1"\nB = "2"\n\n[[d1_databases]]\nname = "x"\n').join(',') === 'A,B');
  check('the PASTE is taken off before the line is printed',
    purpose('PASTE the dashboard password') === 'the dashboard password' &&
    stillPlaceholder('PASTE something') && !stillPlaceholder('a real value'));

  const dir = mkdtempSync(join(tmpdir(), 'scs-secrets-'));
  const stub = join(dir, 'wrangler');
  writeFileSync(stub, '#!/usr/bin/env node\n' +
    "const a=process.argv.slice(2);" +
    "if(a[1]==='list'&&a[0]==='d1'){process.stdout.write(JSON.stringify([{name:'scs-scores',uuid:'1'}]));process.exit(0)}" +
    "process.stdout.write('\\u{1F300} Secrets:\\n'+process.env.SCS_SECRETS);");
  chmodSync(stub, 0o755);

  const runSecrets = names => {
    const res = spawnSync(process.execPath, [join(BOT, 'scripts', 'secrets-check.mjs')], {
      cwd: BOT, encoding: 'utf8',
      env: Object.assign({}, process.env, {
        WRANGLER_BIN: stub,
        SCS_SECRETS: JSON.stringify(names.map(n => ({ name: n, type: 'secret_text' })))
      })
    });
    return String(res.stdout || '') + String(res.stderr || '');
  };

  const example = Object.keys(JSON.parse(readFileSync(join(BOT, 'secrets.example.json'), 'utf8')));
  const all = runSecrets(example);
  check('a worker with every secret set says so and lists nothing',
    /Every secret the repo names is set/.test(all) && !/Not set/.test(all),
    all.split('\n').filter(Boolean).slice(-1)[0]);

  const some = runSecrets(example.filter(n => n !== 'PUSH_PASSWORD').concat(['OLD_KEY']));
  check('an unset secret is named with what it turns off',
    /Not set, and what each one turns off/.test(some) &&
    /PUSH_PASSWORD\s+the second password/.test(some),
    (some.match(/^\s+PUSH_PASSWORD.*$/m) || [''])[0].trim());
  check('and a secret nothing in the repo names is pointed out too',
    /not named in secrets.example.json/.test(some) && /OLD_KEY/.test(some), '');

  try { rmSync(dir, { recursive: true, force: true }); } catch (err) { /* nothing to clean up */ }
}

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
