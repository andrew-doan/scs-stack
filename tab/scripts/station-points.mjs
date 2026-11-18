// Writes src/data/stations.ts: where each station on the submit page's
// list (src/data/places.ts) is, read from the site's transit map
// (website/assets/transit.geojson), so the worker can tell which station
// a photo was taken at. Run it again when either list changes:
//   node scripts/station-points.mjs
// A name on the list the map does not have is given its point here, and
// one the map has twice (a station on two kinds of line) keeps both.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PLACES } = await import(join(BOT, 'src', 'data', 'places.ts'));
const map = JSON.parse(readFileSync(join(BOT, '..', 'website', 'assets', 'transit.geojson'), 'utf8'));

// on the list, not on the map: the platforms, read off the map by hand
const EXTRA = {
  'Killara': [[-33.76617, 151.16219]],
  'Central Chalmers Street': [[-33.88434, 151.20735]],
  'Central Grand Concourse': [[-33.88262, 151.20632]]
};

const norm = (s) => String(s).toLowerCase().replace(/['’.]/g, '').replace(/\s+/g, ' ').trim();
const points = {};
map.features.forEach((f) => {
  if (!f.geometry || f.geometry.type !== 'Point' || !f.properties || !f.properties.name) return;
  const [lng, lat] = f.geometry.coordinates;
  (points[norm(f.properties.name)] = points[norm(f.properties.name)] || []).push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
});
const out = {};
const missing = [];
PLACES.stations.forEach((name) => {
  const found = EXTRA[name] || points[norm(name)];
  if (found) out[name] = found;
  else missing.push(name);
});
if (missing.length) {
  console.error('No point for ' + missing.join(', ') + '. Add them to EXTRA.');
  process.exit(1);
}
const lines = Object.keys(out).map((name) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(out[name]));
writeFileSync(join(BOT, 'src', 'data', 'stations.ts'),
  '// Where each station on the submit page\'s list is (places.ts), [lat, lng]\n' +
  '// for each of its points, so the worker can tell which station a photo\n' +
  '// was taken at (src/visits.ts). Written by scripts/station-points.mjs\n' +
  '// from website/assets/transit.geojson; run that rather than editing this.\n' +
  'export var STATION_POINTS: Record<string, number[][]> = {\n' + lines.join(',\n') + '\n};\n');
console.log('Wrote ' + Object.keys(out).length + ' stations.');
