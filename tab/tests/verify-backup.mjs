// Run with: node tests/verify-backup.mjs
// `npm run backup` against a pretend wrangler and a pretend R2. A
// backup that quietly copies nothing is found out on the day it is
// needed, so what is checked is that a run leaves a database export and
// every file behind, and that a second run fetches only what is new.
//
// The request signing is held to AWS's own published example rather
// than to itself: R2 refuses a request whose signature it cannot
// reproduce, and that is not something a stub can tell us.
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sign, localPath } from '../scripts/backup.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---------------- the signature ----------------
// AWS's signature version 4 test suite, "get-vanilla".
const empty = createHash('sha256').update('').digest('hex');
const vanilla = sign({
  method: 'GET', host: 'example.amazonaws.com', path: '/', query: {}, payloadHash: empty,
  now: new Date('2015-08-30T12:36:00Z'), region: 'us-east-1', service: 'service',
  keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
});
check('requests are signed the way AWS\'s published example is',
  vanilla.authorization === 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  vanilla.authorization);

// ---------------- a pretend R2 ----------------
// It checks each request's signature by working it out again from what
// arrived, the way R2 does, so a path or query encoded one way on the
// wire and another way in the signature is refused here too.
const KEY_ID = 'test-key-id';
const SECRET = 'test-secret';
const OBJECTS = {
  'sub/abc123': 'the original photo',
  'sub/abc123.t': 'its thumbnail',
  'msg/poster one.png': 'a file name with a space',
  'slide/q(1).jpg': 'brackets, which need encoding',
  'drop/a/b/deep.pdf': 'a deep key'
};
const PAGE = 2;   // a small page, so the listing has to follow its token
const seen = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const path = url.pathname.split('/').map(decodeURIComponent).join('/');
  const query = Object.fromEntries(url.searchParams);
  const auth = req.headers.authorization || '';
  const signed = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1] || '';
  const headers = {};
  signed.split(';').filter((h) => h !== 'host' && h !== 'x-amz-date').forEach((h) => { headers[h] = req.headers[h]; });
  const amz = req.headers['x-amz-date'] || '';
  const again = sign({
    method: req.method, host: req.headers.host, path, query, headers,
    payloadHash: req.headers['x-amz-content-sha256'],
    now: new Date(amz.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')),
    region: 'auto', service: 's3', keyId: KEY_ID, secret: SECRET
  });
  if (!auth || again.authorization !== auth) {
    seen.push('refused ' + path);
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>');
    return;
  }
  const [, bucket, ...rest] = path.split('/');
  if (bucket !== 'scs-submissions') { res.writeHead(404); res.end('<Error><Code>NoSuchBucket</Code></Error>'); return; }
  if (!rest.length) {
    seen.push('list');
    const keys = Object.keys(OBJECTS).sort();
    const from = query['continuation-token'] ? Number(query['continuation-token']) : 0;
    const page = keys.slice(from, from + PAGE);
    const more = from + PAGE < keys.length;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0"?><ListBucketResult>' +
      page.map((k) => '<Contents><Key>' + esc(k) + '</Key><Size>' + Buffer.byteLength(OBJECTS[k]) + '</Size></Contents>').join('') +
      '<IsTruncated>' + more + '</IsTruncated>' + (more ? '<NextContinuationToken>' + (from + PAGE) + '</NextContinuationToken>' : '') +
      '</ListBucketResult>');
    return;
  }
  const key = rest.join('/');
  seen.push('get ' + key);
  if (!(key in OBJECTS)) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
  res.writeHead(200);
  res.end(OBJECTS[key]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const endpoint = 'http://127.0.0.1:' + server.address().port;

// ---------------- a pretend wrangler ----------------
const dir = mkdtempSync(join(tmpdir(), 'scs-backup-'));
const bin = join(dir, 'wrangler');
writeFileSync(bin, '#!/usr/bin/env node\n' +
  "const a=process.argv.slice(2);const fs=require('node:fs');const p=require('node:path');" +
  "if(a[0]==='d1'&&a[1]==='list'){process.stdout.write(JSON.stringify([{name:'scs-scores',uuid:'11111111-2222-3333-4444-555555555555'}]));process.exit(0)}" +
  "if(a[0]==='d1'&&a[1]==='export'){const o=a[a.indexOf('--output')+1];fs.mkdirSync(p.dirname(o),{recursive:true});" +
  "fs.writeFileSync(o,'CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT);\\nINSERT INTO teams VALUES (1, \\'Loco Motive\\');\\n');process.exit(0)}" +
  'process.exit(2);');
chmodSync(bin, 0o755);
const out = join(dir, 'backups');

const run = (args, extra) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(BOT, 'scripts', 'backup.mjs')].concat(args), {
    cwd: BOT,
    env: Object.assign({}, process.env, { WRANGLER_BIN: bin, BACKUP_DIR: out }, extra || {})
  });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  child.on('close', (code) => resolve({ code, text }));
});
const R2 = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET, R2_ENDPOINT: endpoint };

// ---------------- the database alone ----------------
const plain = await run([], R2);
const sql = existsSync(out) ? readdirSync(out).filter((f) => /^scs-scores-\d{4}-\d\d-\d\dT\d{4}Z\.sql$/.test(f)) : [];
check('npm run backup writes the database as a dated SQL file and touches no bucket',
  plain.code === 0 && sql.length === 1 && /INSERT INTO teams/.test(readFileSync(join(out, sql[0]), 'utf8')) && seen.length === 0,
  JSON.stringify({ code: plain.code, sql, seen, text: plain.text.trim().split('\n').slice(-2) }));

// ---------------- with the photos ----------------
const first = await run(['--photos'], R2);
const mirror = join(out, 'files', 'scs-submissions');
const landed = Object.keys(OBJECTS).filter((k) => {
  const f = localPath(mirror, k);
  return existsSync(f) && readFileSync(f, 'utf8') === OBJECTS[k];
});
const lists = seen.filter((s) => s === 'list').length;
check('--photos mirrors every file in the bucket, across pages of the listing, with no request refused',
  first.code === 0 && landed.length === Object.keys(OBJECTS).length && lists === 3 && !seen.some((s) => /^refused/.test(s)),
  JSON.stringify({ code: first.code, landed: landed.length, lists, refused: seen.filter((s) => /^refused/.test(s)), text: first.text.trim().split('\n').slice(-3) }));

seen.length = 0;
OBJECTS['sub/new456'] = 'sent in since';
const second = await run(['--photos'], R2);
const gets = seen.filter((s) => s.startsWith('get '));
check('a second run fetches only what is new',
  second.code === 0 && gets.length === 1 && gets[0] === 'get sub/new456',
  JSON.stringify({ code: second.code, gets }));

const missing = await run(['--photos'], { R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' });
check('--photos without a token says which settings are missing before exporting anything',
  missing.code === 1 && /R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/.test(missing.text) && !/Exporting/.test(missing.text),
  missing.text.trim());

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
