// A copy of this worker's data on your own computer.
//
//   npm run backup                 the database, as SQL
//   npm run backup -- --photos     the database, and every file in the
//                                  worker's R2 bucket
//
// The database comes out as one SQL file through `wrangler d1 export`,
// named for the database and the time (UTC), in backups/. It is a whole
// copy — every table, schema and rows — and loads into a local database
// with `wrangler d1 execute <db> --local --file=<it>`. Cloudflare's own
// Time Travel can already put the live database back to any minute of
// the last 30 days; this is the copy that is not in Cloudflare.
//
// --photos mirrors the bucket into backups/files/<bucket>/, one file per
// object under its own key. A file already there at the same size is not
// fetched again, so the second run takes only what is new. Wrangler
// cannot list a bucket, so this goes to R2 directly with an R2 API token
// (read-only is enough), from backup.json beside this worker's
// package.json or from the environment:
//
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// backup.json and backups/ are git-ignored. Both hold what people typed
// into the sign-up form: keep them off shared drives and delete them
// once they are not needed.
//
// This file is the same in every worker (the check-in worker's bucket is
// its QR images), and tests/verify-migrations.mjs fails if the copies
// differ.
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { wrangler, writeConfig, ROOT, dbName } from './deploy.mjs';

const OUT = process.env.BACKUP_DIR || join(ROOT, 'backups');   // only the tests move it
const AT_ONCE = 4;   // files downloaded side by side

// ---------------- AWS signature version 4 ----------------
// R2's S3 API checks every request against the token's secret this way.
// Written out rather than pulled in from the AWS SDK, which is
// megabytes for two calls; tests/verify-backup.mjs holds it to AWS's
// own published example.

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986: encodeURIComponent leaves these five alone and AWS does not
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function sign(o) {
  const amzDate = o.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers = Object.assign({ host: o.host, 'x-amz-date': amzDate }, o.headers || {});
  const names = Object.keys(headers).sort();
  const query = o.query || {};
  const canonical = [
    o.method,
    o.path.split('/').map(enc).join('/'),
    Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&'),
    names.map((n) => n + ':' + String(headers[n]).trim() + '\n').join(''),
    names.join(';'),
    o.payloadHash
  ].join('\n');
  const scope = day + '/' + o.region + '/' + o.service + '/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = hmac('AWS4' + o.secret, day);
  key = hmac(key, o.region);
  key = hmac(key, o.service);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return Object.assign({}, headers, {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + o.keyId + '/' + scope +
      ', SignedHeaders=' + names.join(';') + ', Signature=' + signature
  });
}

// ---------------- R2 ----------------

export function r2Settings(env) {
  let file = {};
  const path = join(ROOT, 'backup.json');
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { throw new Error('backup.json is not valid JSON: ' + err.message); }
  }
  const pick = (name) => (env[name] || file[name] || '').trim();
  const s = {
    account: pick('R2_ACCOUNT_ID'),
    keyId: pick('R2_ACCESS_KEY_ID'),
    secret: pick('R2_SECRET_ACCESS_KEY'),
    // only the tests point this anywhere else
    endpoint: pick('R2_ENDPOINT')
  };
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    .filter((n, i) => ![s.account, s.keyId, s.secret][i] || /^PASTE/.test([s.account, s.keyId, s.secret][i]));
  if (missing.length) return { missing };
  if (!s.endpoint) s.endpoint = 'https://' + s.account + '.r2.cloudflarestorage.com';
  return s;
}

function r2Request(s, method, path, query) {
  const url = new URL(s.endpoint);
  const headers = sign({
    method, host: url.host, path, query,
    headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    payloadHash: 'UNSIGNED-PAYLOAD',
    keyId: s.keyId, secret: s.secret, region: 'auto', service: 's3', now: new Date()
  });
  delete headers.host;
  const qs = Object.keys(query || {}).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  return fetch(url.origin + path.split('/').map(enc).join('/') + (qs ? '?' + qs : ''), { method, headers });
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

// Every object in the bucket, a thousand a page.
export async function listBucket(s, bucket) {
  const all = [];
  let token = '';
  for (;;) {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await r2Request(s, 'GET', '/' + bucket, query);
    const xml = await res.text();
    if (!res.ok) throw new Error('R2 refused the list of ' + bucket + ' (' + res.status + '): ' + r2Error(xml));
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
      const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
      if (key) all.push({ key: unxml(key[1]), size: size ? Number(size[1]) : -1 });
    }
    const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    if (!more || !next) return all;
    token = unxml(next[1]);
  }
}

function r2Error(xml) {
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(xml || '');
  const msg = /<Message>([\s\S]*?)<\/Message>/.exec(xml || '');
  return [code && code[1], msg && unxml(msg[1])].filter(Boolean).join(': ') || 'no reason given';
}

// A key as a path on this computer. Keys are made by the worker, but an
// old one carries a file's own name, and Windows refuses a few
// characters in a file name that R2 does not mind.
export function localPath(base, key) {
  return join(base, ...key.split('/').filter(Boolean).map((part) =>
    part === '.' || part === '..' ? '_' : part.replace(/[<>:"|?*\\]/g, '_')));
}

async function fetchObject(s, bucket, key, file) {
  const res = await r2Request(s, 'GET', '/' + bucket + '/' + key);
  if (!res.ok) throw new Error(res.status + ' ' + r2Error(await res.text()));
  mkdirSync(dirname(file), { recursive: true });
  // written beside the real name and moved into place, so a run cut off
  // part way never leaves a short file that the next run would keep
  const part = file + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, file);
}

export async function mirrorBucket(s, bucket, base, log) {
  const objects = await listBucket(s, bucket);
  const dir = join(base, bucket);
  const todo = objects.filter((o) => {
    const file = localPath(dir, o.key);
    return !(existsSync(file) && statSync(file).size === o.size);
  });
  const bytes = todo.reduce((n, o) => n + Math.max(o.size, 0), 0);
  log(bucket + ': ' + objects.length + ' files, ' + todo.length + ' to fetch (' + mb(bytes) + ')');
  const failed = [];
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const o = todo[next++];
      const file = localPath(dir, o.key);
      try { await fetchObject(s, bucket, o.key, file); }
      catch (err) {
        failed.push(o.key + ' (' + err.message + ')');
        try { unlinkSync(file + '.part'); } catch (e) { /* nothing was written */ }
      }
      done++;
      if (done % 25 === 0 || done === todo.length) log('  ' + done + ' of ' + todo.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, todo.length) }, worker));
  return { total: objects.length, fetched: todo.length - failed.length, failed };
}

function mb(n) { return (n / 1e6).toFixed(1) + ' MB'; }

// ---------------- the database ----------------

export function stamp(now) {
  return now.toISOString().slice(0, 16).replace(/:/g, '') + 'Z';
}

function bucketNames() {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
  return Array.from(toml.matchAll(/\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/g)).map((m) => m[1]);
}

async function main() {
  const args = process.argv.slice(2);
  const photos = args.includes('--photos');
  const log = (line) => console.log(line);
  mkdirSync(OUT, { recursive: true });

  // the photos need a token the database does not: ask before spending
  // a minute on the export
  let r2 = null;
  if (photos) {
    r2 = r2Settings(process.env);
    if (r2.missing) {
      console.error('--photos needs an R2 API token. Put ' + r2.missing.join(', ') +
        ' in backup.json (see backup.example.json) or the environment.');
      process.exit(1);
    }
  }

  const db = dbName();
  const config = writeConfig();
  const file = join(OUT, db + '-' + stamp(new Date()) + '.sql');
  log('Exporting ' + db + '…');
  const res = wrangler(['d1', 'export', db, '--remote', '--output', relative(ROOT, file), '--config', relative(ROOT, config)], false);
  if (res.status !== 0 || !existsSync(file) || !statSync(file).size) {
    console.error('The export did not finish. Nothing was written to ' + relative(ROOT, file) + '.');
    process.exit(1);
  }
  log('Database: ' + relative(ROOT, file) + ' (' + mb(statSync(file).size) + ')');

  if (!photos) return;
  let failures = 0;
  for (const bucket of bucketNames()) {
    const r = await mirrorBucket(r2, bucket, join(OUT, 'files'), log);
    log(bucket + ': ' + r.fetched + ' fetched, ' + (r.total - r.fetched - r.failed.length) + ' already here' +
      (r.failed.length ? ', ' + r.failed.length + ' failed' : '') + ' → ' + relative(ROOT, join(OUT, 'files', bucket)));
    r.failed.slice(0, 20).forEach((f) => console.error('  could not fetch ' + f));
    failures += r.failed.length;
  }
  if (failures) {
    console.error(failures + ' files did not come down. Run it again to fetch just those.');
    process.exit(1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
