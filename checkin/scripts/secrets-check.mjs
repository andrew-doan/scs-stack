// Which of the worker's secrets are actually set on Cloudflare.
//
//   npm run secrets:check
//
// The other half of "is it where I expect". A secret that was never
// uploaded does not fail anything: the code checks `configured()` and
// the thing it guards simply stays off — no push, no Turnstile, no
// short links, the encoder answering 503 — so the symptom is a feature
// that is missing rather than an error anybody sees. This lists what
// the repo says the worker takes, against what the account has.
//
// It reads names only. `wrangler secret list` never returns a value and
// neither does this; nothing is uploaded, changed or printed but names.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { wrangler, writeConfig, ROOT } from './deploy.mjs';

// A value still reading PASTE… is the file as it was committed, which
// is the same as unset — `configured()` in the worker reads it that way
// too, so the two agree about what "set" means.
export function stillPlaceholder(value) {
  return /^PASTE/i.test(String(value || ''));
}

// Names declared in [vars] cannot also be secrets: a secret and a var
// of the same name is refused at deploy, and the message does not say
// which one is the duplicate.
export function varNames(toml) {
  const block = /\n\[vars\]([\s\S]*?)(?=\n\[|$)/.exec('\n' + toml);
  if (!block) return [];
  const out = [];
  const re = /^\s*([A-Z_][A-Z0-9_]*)\s*=/gm;
  let m;
  while ((m = re.exec(block[1]))) out.push(m[1]);
  return out;
}

// What the example file says each secret is for, without the PASTE.
export function purpose(value) {
  return String(value || '').replace(/^PASTE\s*/i, '').trim();
}

function main() {
  const example = JSON.parse(readFileSync(join(ROOT, 'secrets.example.json'), 'utf8'));
  const want = Object.keys(example);
  const vars = varNames(readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'));

  const clash = want.filter(n => vars.indexOf(n) !== -1);
  if (clash.length) {
    console.log('These are named in both secrets.example.json and [vars] in wrangler.toml:\n');
    for (const n of clash) console.log('  ' + n);
    console.log('\nA deploy refuses that, and does not say which name is the duplicate.');
    console.log('One of the two has to go.\n');
  }

  try { writeConfig(); } catch (err) {
    console.error(err.message);
    return 1;
  }

  const res = wrangler(['secret', 'list', '--config', 'wrangler.deploy.toml'], 'all');
  const text = String(res.stdout || '') + String(res.stderr || '');
  let live;
  try {
    live = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)).map(r => r.name);
  } catch (err) {
    console.error('could not read the secret list:\n' + text);
    return 1;
  }

  const set = want.filter(n => live.indexOf(n) !== -1);
  const unset = want.filter(n => live.indexOf(n) === -1);
  const extra = live.filter(n => want.indexOf(n) === -1);

  console.log(set.length + ' of ' + want.length + ' secrets are set on this worker.\n');
  if (unset.length) {
    console.log('Not set, and what each one turns off:\n');
    for (const n of unset) console.log('  ' + n.padEnd(20) + purpose(example[n]));
    console.log('\n  Some of these are meant to be left unset — the example file says so');
    console.log('  in the line beside each. To set one, fill it in and upload the lot:\n');
    console.log('    cp secrets.example.json secrets.json   # gitignored, if you have not already');
    console.log('    npm run secrets\n');
    console.log('  A value still reading PASTE… uploads, and the worker reads it as unset.\n');
  }
  if (extra.length) {
    console.log('Set on the worker but not named in secrets.example.json:\n');
    for (const n of extra) console.log('  ' + n);
    console.log('\n  Either the repo has forgotten one, or it is left over from something');
    console.log('  that has gone. Nothing reads it.\n');
  }
  if (!unset.length && !extra.length) {
    console.log('Every secret the repo names is set, and nothing else is.');
  }

  // The local file, if there is one. `npm run secrets` uploads whatever
  // is in it, placeholders included — so a name can be listed as set
  // above and still be doing nothing.
  const local = join(ROOT, 'secrets.json');
  if (existsSync(local)) {
    let mine = {};
    try { mine = JSON.parse(readFileSync(local, 'utf8')); } catch (err) { mine = null; }
    if (!mine) {
      console.log('\nsecrets.json is not readable as JSON. npm run secrets would refuse it.');
    } else {
      const pasted = Object.keys(mine).filter(n => stillPlaceholder(mine[n]));
      if (pasted.length) {
        console.log('\nStill reading PASTE… in your local secrets.json:\n');
        for (const n of pasted) console.log('  ' + n);
        console.log('\n  These upload like any other value and the worker reads them as');
        console.log('  unset, so one can be listed as set above and still do nothing.');
      }
    }
  }
  return clash.length ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
