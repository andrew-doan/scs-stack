// Run with: node tests/verify-dash-bundle.mjs   (needs npm install in tab/)
// The dashboard page reaches the browser two ways and every other suite
// sees only one of them. Under Node, '#dash-files' is
// src/dash/files-node.js, which reads the page's files (dash.css,
// dash.html and the script's parts in src/dash/js/) from disk. In the
// deployed worker it is src/dash/files.js, which imports the same files
// as Text modules through the [[rules]] block in wrangler.toml, and
// lists the parts in an order of its own. A rule
// that stops matching one of them does not always fail the deploy:
// esbuild bundles a .css it was not told about as a stylesheet and the
// import comes back {}, so the page would go out with "[object Object]"
// for its styles while every Node suite passes. This builds the bundle
// the deploy uploads (wrangler deploy --dry-run), runs it in workerd,
// and compares /dash and /dash/spinner with what the worker serves
// under Node.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (!ok && detail ? '  ' + detail : ''));
  if (!ok) failures++;
  return ok;
}

const ENV = {
  TURNSTILE_SITE_KEY: '0x4AAAAAAABkMYinukE8nzY', TURNSTILE_SECRET: 'secret',
  PUBLIC_API: 'https://files.scs.andyrew.space'
};

// the bundle's modules as the deploy uploads them, in a workerd config
// listening on a port of its own choosing
function config(dir) {
  // Everything wrangler wrote beside index.js is a module the bundle
  // imports and a [[rules]] block made Text; the map and the README are
  // not uploaded.
  const modules = ['(name = "index.js", esModule = embed "index.js")'].concat(
    readdirSync(dir).filter(f => f !== 'index.js' && f !== 'README.md' && !f.endsWith('.map'))
      .map(f => '(name = ' + JSON.stringify(f) + ', text = embed ' + JSON.stringify(f) + ')'));
  const bindings = Object.entries(ENV)
    .map(([k, v]) => '(name = ' + JSON.stringify(k) + ', text = ' + JSON.stringify(v) + ')');
  return 'using Workerd = import "/workerd/workerd.capnp";\n' +
    'const config :Workerd.Config = (\n' +
    '  services = [ (name = "main", worker = .tab) ],\n' +
    '  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],\n' +
    ');\n' +
    'const tab :Workerd.Worker = (\n' +
    '  modules = [ ' + modules.join(', ') + ' ],\n' +
    '  bindings = [ ' + bindings.join(', ') + ' ],\n' +
    '  compatibilityDate = "2026-07-01",\n' +
    ');\n';
}

// workerd reports the port it took on the control descriptor
function listening(server) {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(0), 15000);
    server.stdio[3].on('data', d => {
      buf += d;
      for (const line of buf.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.event === 'listen' && msg.socket === 'http') { clearTimeout(timer); resolve(msg.port); }
      }
    });
    server.on('exit', () => { clearTimeout(timer); resolve(0); });
  });
}

async function run(out) {
  let wrangler, workerd;
  try {
    const pkg = require.resolve('wrangler/package.json');
    wrangler = join(dirname(pkg), require(pkg).bin.wrangler);
    workerd = require('workerd').default;
  } catch (err) {
    return check('wrangler and workerd are installed (npm install in tab/)', false, err.message);
  }

  const built = spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', out], {
    cwd: BOT, encoding: 'utf8', env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' })
  });
  if (!check('the worker bundles the way npm run deploy bundles it', built.status === 0,
    (built.stdout + built.stderr).split('\n').filter(l => /ERROR|✘/.test(l)).join(' | '))) return;

  writeFileSync(join(out, 'config.capnp'), config(out));
  const server = spawn(workerd, ['serve', join(out, 'config.capnp'), '--control-fd=3'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d; });
  try {
    const port = await listening(server);
    if (!check('workerd runs the bundle', port > 0, stderr.trim().split('\n').slice(-3).join(' | '))) return;

    const mod = await import(BOT + '/src/index.ts');
    for (const path of ['/dash', '/dash/spinner']) {
      const deployed = await fetch('http://127.0.0.1:' + port + path);
      const deployedBody = Buffer.from(await deployed.arrayBuffer());
      const local = await mod.default.fetch(new Request('https://dashboard.example' + path), ENV, { waitUntil() {} });
      const localBody = Buffer.from(await local.arrayBuffer());
      let at = 0;
      while (at < localBody.length && localBody[at] === deployedBody[at]) at++;
      check('the deployed bundle serves ' + path + ' byte for byte as the worker does under Node',
        deployed.status === 200 && local.status === 200 && Buffer.compare(deployedBody, localBody) === 0,
        'status ' + deployed.status + '/' + local.status + ', ' + deployedBody.length + '/' + localBody.length +
        ' bytes, first difference at byte ' + at + ': ' + JSON.stringify(deployedBody.subarray(at, at + 60).toString()));
    }
  } finally {
    if (server.exitCode === null) await new Promise(r => { server.on('exit', r); server.kill(); });
  }
}

const out = mkdtempSync(join(tmpdir(), 'scs-dash-bundle-'));
try { await run(out); } finally { rmSync(out, { recursive: true, force: true }); }

console.log(failures ? failures + ' failure(s)' : 'all passed');
process.exit(failures ? 1 : 0);
