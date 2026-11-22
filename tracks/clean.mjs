#!/usr/bin/env node
// Cleans the GPX tracks teams sent for the GPS quest into cleaned GPX
// files for the organisers, with a report of what was done to each. The
// replay's routes are cleaned and saved on the dashboard's Routes tab,
// which runs the same cleaner in the browser.
//
//   node tracks/clean.mjs <folder of .gpx files> [--out <folder>] [--times <folder>]
//
// The cleaning itself is website/tab/replay/track-clean.js; this is
// the files and folders around it. What it does and why is in
// tracks/CLAUDE.md. tracks/teams.json names the team each file belongs
// to, for the name inside the cleaned file.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRANSIT = path.join(ROOT, 'website', 'assets', 'transit.geojson');
const TEAMS = path.join(ROOT, 'tracks', 'teams.json');
const clean = createRequire(import.meta.url)('../website/tab/replay/track-clean.js');

const DEBUG = !!process.env.TRACK_DEBUG;
const log = DEBUG ? (line) => console.log(line) : null;

function readTrips(dir) {
  return clean.trips(fs.readdirSync(dir).filter(f => /\.json$/.test(f))
    .map(f => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) })));
}

function main() {
  const args = process.argv.slice(2);
  const inDir = args.find((a, i) => !a.startsWith('--') && !['--out', '--times'].includes(args[i - 1]));
  if (!inDir) { console.error('usage: node tracks/clean.mjs <folder of .gpx files> [--out <folder>] [--times <stringline folder>]'); process.exit(1); }
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(inDir, 'cleaned');
  const trips = args.includes('--times') ? readTrips(args[args.indexOf('--times') + 1]) : [];
  const teams = fs.existsSync(TEAMS) ? JSON.parse(fs.readFileSync(TEAMS, 'utf8')) : {};
  fs.mkdirSync(outDir, { recursive: true });
  const net = clean.network(JSON.parse(fs.readFileSync(TRANSIT, 'utf8')));
  const files = fs.readdirSync(inDir).filter(f => /\.gpx$/i.test(f) && !f.startsWith('._')).sort();
  const report = [];
  for (const f of files) {
    if (DEBUG) console.log('== ' + f);
    const text = fs.readFileSync(path.join(inDir, f), 'utf8');
    const raw = clean.readGpx(text);
    const team = ((teams[f] || {}).team || '').trim();
    const res = clean.clean(net, raw, { trips, log });
    if (DEBUG) {
      for (let k = 1; k < res.pts.length; k++) {
        const a = res.pts[k - 1], b = res.pts[k], d = clean.dist(a, b), dt = b.t - a.t;
        if (d > 200 && d / Math.max(1, dt) > 30) console.log(`    JUMP ${clean.clock(a.t)} ${a.src} -> ${clean.clock(b.t)} ${b.src} ${Math.round(d)}m in ${dt.toFixed(1)}s`);
      }
    }
    const label = team || clean.gpxName(text) || f.replace(/\.gpx$/i, '');
    fs.writeFileSync(path.join(outDir, f.replace(/\.gpx$/i, '') + ' (cleaned).gpx'), clean.toGpx(label, res.pts));
    report.push(`${f}${team ? ' → ' + team : ' (no team yet)'}`);
    const span = res.pts.length ? `, ${clean.clock(res.pts[0].t)}–${clean.clock(res.pts[res.pts.length - 1].t)}` : '';
    report.push(`  ${raw.length} points in, ${res.pts.length} out${span}`);
    for (const n of res.notes) report.push('  ' + n);
  }
  fs.writeFileSync(path.join(outDir, 'report.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`\nCleaned GPX in ${outDir}`);
}

main();
