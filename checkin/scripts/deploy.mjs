// Deploys the worker without anyone editing wrangler.toml first.
//
// wrangler needs the D1 database's id in the config, and the id is
// different for every account, so the committed wrangler.toml carries
// a placeholder. This script asks wrangler for the databases the
// account has, matches them by name, writes the filled-in config to
// wrangler.deploy.toml (ignored by git) and deploys with that. Every
// other per-account value is a secret (see secrets.example.json), so
// nothing in the repo ever needs a local edit.
//
//   npm run deploy            deploy
//   npm run deploy -- --dry   write wrangler.deploy.toml and stop
//
// Extra arguments go straight to `wrangler deploy`.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'wrangler.toml');
const OUTPUT = join(ROOT, 'wrangler.deploy.toml');
const WRANGLER = process.env.WRANGLER_BIN || 'npx';
const WRANGLER_ARGS = process.env.WRANGLER_BIN ? [] : ['wrangler'];

// Windows needs a shell to run npx at all (it is npx.cmd, and node
// refuses to spawn a .cmd without one), and a shell re-parses the
// command line — so every argument has to carry its own quotes or a
// repo living under "C:\\Users\\Some Name\\..." is split in half.
export function quoteArg(arg) {
  return /[\s"]/.test(String(arg)) ? '"' + String(arg).replace(/"/g, '\\"') + '"' : String(arg);
}

// capture: false = let wrangler print, 'stdout' = read its output,
// 'all' = read both, which is how the migration runner tells an
// already-applied ALTER apart from a real failure.
export function wrangler(args, capture) {
  const shell = process.platform === 'win32';
  const whole = WRANGLER_ARGS.concat(args);
  const res = spawnSync(
    shell ? quoteArg(WRANGLER) : WRANGLER,
    shell ? whole.map(quoteArg) : whole,
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: capture === 'all' ? ['inherit', 'pipe', 'pipe']
        : capture ? ['inherit', 'pipe', 'inherit']
        : 'inherit',
      shell: shell
    }
  );
  if (res.error) throw res.error;
  return res;
}

// the d1_databases blocks: name and whether the id still needs filling
export function databaseBlocks(toml) {
  const blocks = [];
  const re = /\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(toml))) {
    const body = m[1];
    const name = (body.match(/database_name\s*=\s*"([^"]+)"/) || [])[1];
    const id = (body.match(/database_id\s*=\s*"([^"]*)"/) || [])[1];
    blocks.push({ name, id, placeholder: !id || /^PASTE/i.test(id) });
  }
  return blocks;
}

// the config with every placeholder id replaced from the account's list
export function fillIds(toml, databases) {
  let out = toml;
  for (const block of databaseBlocks(toml)) {
    if (!block.placeholder) continue;
    const found = databases.find(d => d.name === block.name);
    if (!found) {
      throw new Error('No D1 database called "' + block.name + '" on this account. Create it first:\n  npx wrangler d1 create ' + block.name);
    }
    const id = found.uuid || found.id;
    out = out.replace(
      new RegExp('(database_name\\s*=\\s*"' + block.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[\\s\\S]*?database_id\\s*=\\s*")[^"]*(")'),
      '$1' + id + '$2'
    );
  }
  return out;
}

// The kv_namespaces blocks whose id is a placeholder naming the
// namespace: `id = "PASTE-KV:<name>"`. A KV binding is something a
// feature can run without, so one the account does not have is left out
// of the deploy with a line saying how to make it, rather than stopping
// the deploy.
export function kvBlocks(toml) {
  const blocks = [];
  const re = /\[\[kv_namespaces\]\]([\s\S]*?)(?=\n\s*\n|\n\[|$)/g;
  let m;
  while ((m = re.exec(toml))) {
    const id = (m[1].match(/\bid\s*=\s*"([^"]*)"/) || [])[1] || '';
    const name = (id.match(/^PASTE-KV:(.+)$/i) || [])[1];
    blocks.push({ whole: m[0], binding: (m[1].match(/binding\s*=\s*"([^"]+)"/) || [])[1], name, placeholder: !!name });
  }
  return blocks;
}

// The config with each placeholder KV id filled from the account's list
// (matched on the title, or a title ending in -<name>, which is what an
// older wrangler made), and each one the account does not have taken out.
export function fillKv(toml, namespaces) {
  let out = toml;
  const missing = [];
  for (const block of kvBlocks(toml)) {
    if (!block.placeholder) continue;
    const found = namespaces.find(n => n.title === block.name || String(n.title).endsWith('-' + block.name));
    if (found) out = out.replace(block.whole, block.whole.replace(/(\bid\s*=\s*")[^"]*(")/, '$1' + found.id + '$2'));
    else { out = out.replace(block.whole, ''); missing.push(block); }
  }
  return { toml: out, missing };
}

function listKv() {
  const res = wrangler(['kv', 'namespace', 'list'], true);
  if (res.status !== 0) return [];
  const text = String(res.stdout || '');
  const start = text.indexOf('[');
  try { return start === -1 ? [] : JSON.parse(text.slice(start)); } catch (err) { return []; }
}

function listDatabases() {
  const res = wrangler(['d1', 'list', '--json'], true);
  if (res.status !== 0) throw new Error('wrangler d1 list failed. Are you logged in? (npx wrangler login)');
  const text = String(res.stdout || '');
  const start = text.indexOf('[');
  if (start === -1) throw new Error('wrangler d1 list gave no JSON:\n' + text);
  return JSON.parse(text.slice(start));
}

// The database this worker owns, read from its own wrangler.toml. The
// other scripts in this folder take the name from here rather than
// spelling it out, so they are the same file in both workers and a
// difference between the two copies is a real difference rather than a
// stale one.
export function dbName() {
  const blocks = databaseBlocks(readFileSync(SOURCE, 'utf8'));
  if (!blocks.length) throw new Error('No [[d1_databases]] block in wrangler.toml');
  return blocks[0].name;
}

// Fill in the placeholder ids and write wrangler.deploy.toml. Both the
// deploy and the migration runner start here: without it wrangler
// reads the committed placeholder and fails saying the id is not a
// uuid, which reads like a missing database. A KV namespace is looked
// up only for a deploy (`{kv: true}`); the migration runner needs none
// and leaves the block out without asking wrangler.
export function writeConfig(opts) {
  const toml = readFileSync(SOURCE, 'utf8');
  let filled = toml;
  const pending = databaseBlocks(toml).filter(b => b.placeholder);
  if (pending.length) {
    const databases = listDatabases();
    filled = fillIds(toml, databases);
    for (const b of pending) {
      const found = databases.find(x => x.name === b.name);
      console.log('D1 ' + b.name + ' → ' + (found.uuid || found.id));
    }
  }
  if (kvBlocks(filled).some(b => b.placeholder)) {
    const lookUp = !!(opts && opts.kv);
    const kv = fillKv(filled, lookUp ? listKv() : []);
    filled = kv.toml;
    for (const b of lookUp ? kv.missing : []) {
      console.log('KV ' + b.name + ' is not on this account, so ' + b.binding + ' is left out of this deploy. Make it with:\n  npx wrangler kv namespace create ' + b.name);
    }
  }
  writeFileSync(OUTPUT, '# Generated by scripts/deploy.mjs from wrangler.toml. Do not edit, do not commit.\n' + filled);
  return OUTPUT;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const passthrough = args.filter(a => a !== '--dry');
  try { writeConfig({ kv: true }); } catch (err) { console.error(err.message); process.exit(1); }
  if (dry) { console.log('Wrote ' + OUTPUT); process.exit(0); }
  const res = wrangler(['deploy', '--config', OUTPUT].concat(passthrough), false);
  process.exit(res.status === null ? 1 : res.status);
}
