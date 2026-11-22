// Run with: node tests/verify-quests.mjs   (needs Node 22+ for node:sqlite)
// The one quest list: retiring the old tab quests to -o, importing the
// SCS.2 list, the public /api/questlist read, the console group editor
// (edit, add, rename, hide), submissions with answer boxes, and
// accepting several codes at once.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { credit } from './ledger-fixture.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(BOT + '/src/index.ts');
const { QUESTS: SCS2, REGIONS } = await import(BOT + '/src/data/scs2-quests.ts');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

const bucket = new Map();
const SUBMIT = {
  async put(key, value, opts) { bucket.set(key, { bytes: new Uint8Array(await value.arrayBuffer()), meta: (opts && opts.httpMetadata) || {} }); },
  async get(key) { const hit = bucket.get(key); return hit ? { body: hit.bytes, size: hit.bytes.length, httpMetadata: hit.meta } : null; }
};
let purges = 0;
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { purges++; return true; } } };

const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const post = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

let questSignIn = await consoleSignIn(post, 'Alex', 'tab-pass');
let r = { status: questSignIn.session ? 200 : 401, json: async () => questSignIn };
const sess = (await r.json()).session;

// ---------------- the seeded tab before anything ----------------
r = await get('/api/console/quests', sess);
let data = await r.json();
const seededCodes = data.loose.length;
check('the seeded quests have no groups yet', data.ok && data.groups.length === 0 && seededCodes > 100, 'loose=' + seededCodes);
r = await get('/api/questlist');
data = await r.json();
check('/api/questlist is public, CORS-open and empty of groups',
  r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && data.groups.length === 0 && data.places.stations.length > 200, '');

const tabBefore = await db.prepare('SELECT COUNT(*) AS n, SUM(amount) AS a FROM held').first();
const teamBefore = await db.prepare(
  'SELECT t.name, SUM(c.amount * q.points) AS pts FROM held c JOIN quests q ON q.code = c.quest_code JOIN teams t ON t.id = c.team_id GROUP BY t.id ORDER BY pts DESC LIMIT 1'
).first();

// ---------------- retire ----------------
r = await post('/api/console/quests/retire', {}, sess);
check('retiring asks for the typed word', r.status === 428, 'status=' + r.status);
r = await post('/api/console/quests/retire', { confirm: 'RETIRE' }, sess);
data = await r.json();
check('RETIRE renames every live code to code-o', r.status === 200 && data.retired === seededCodes, JSON.stringify(data));
const live = await db.prepare("SELECT COUNT(*) AS n FROM quests WHERE code NOT LIKE '%-o'").first();
const hiddenN = await db.prepare('SELECT COUNT(*) AS n FROM quests WHERE hidden = 1').first();
check('no code is left without -o and all are hidden', live.n === 0 && hiddenN.n === seededCodes, JSON.stringify({ live: live.n, hidden: hiddenN.n }));
const tabAfter = await db.prepare('SELECT COUNT(*) AS n, SUM(amount) AS a FROM held').first();
check('every tab entry followed its code', tabAfter.n === tabBefore.n && tabAfter.a === tabBefore.a, JSON.stringify(tabAfter));
const s1 = await db.prepare("SELECT code, norm FROM quests WHERE code = 'S1-o'").first();
check('the norm carries the suffix too', !!s1 && s1.norm === 'S1-O', JSON.stringify(s1));
r = await get('/api/leaderboard');
data = await r.json();
check('scores are untouched by the retire', data.teams[0].name === teamBefore.name && data.teams[0].points === teamBefore.pts,
  JSON.stringify(data.teams[0]));
r = await get('/api/quests');
data = await r.json();
check('retired codes leave the public quest read', data.quests.length === 0, 'quests=' + data.quests.length);
r = await post('/api/console/quests/retire', { confirm: 'RETIRE' }, sess);
check('retiring again is a no-op', (await r.json()).retired === 0, '');

// ---------------- import ----------------
r = await post('/api/console/quests/import-scs2', {}, sess);
data = await r.json();
const codeCount = SCS2.reduce((n, g) => n + g.codes.length, 0);
check('the SCS.2 list imports every group', data.ok && data.added === SCS2.length && data.skipped.length === 0, JSON.stringify({ added: data.added, skipped: data.skipped.length }));
const liveNow = await db.prepare('SELECT COUNT(*) AS n FROM quests WHERE hidden = 0').first();
check('every code from the list is on the tab', liveNow.n === codeCount, 'codes=' + liveNow.n + ' expected=' + codeCount);
r = await post('/api/console/quests/import-scs2', {}, sess);
data = await r.json();
check('a second import skips everything already there', data.added === 0 && data.skipped.length === SCS2.length, '');

r = await get('/api/questlist');
data = await r.json();
check('the public list carries the regions in order and only visible groups',
  data.regions.join('|') === REGIONS.join('|') && data.groups.length === SCS2.length, JSON.stringify(data.regions));
const sq46 = data.groups.find(g => g.key === 'SQ46');
check('a multi-code quest ships its codes with labels and points',
  sq46 && sq46.codes.length === 11 && sq46.codes[0].code === 'SQ46-1' && sq46.codes[0].points === 100 && sq46.submit === 'codes', JSON.stringify(sq46 && sq46.codes[0]));
const sq1 = data.groups.find(g => g.key === 'SQ1');
check('the station quest asks for stations', sq1.submit === 'pick' && sq1.options[0] === '@stations' && sq1.coords.length === 0, '');
const sq40 = data.groups.find(g => g.key === 'SQ40');
check('descriptions keep their markdown, flavour rides separately',
  sq40.description.includes('**Note:**') && sq40.flavour.length > 0 && sq40.coords.length === 1 && sq40.location === 'Wondabyne Station', '');
check('no group leaks hidden, sort or ids', !('hidden' in sq40) && !('id' in sq40) && !('sort' in sq40), '');
r = await get('/api/quests');
data = await r.json();
check('/api/quests lists every live code with its group', data.quests.length === codeCount && data.quests.find(q => q.code === 'SQ46-1').group === 'SQ46' && typeof data.groups === 'object',
  'quests=' + data.quests.length);

// ---------------- editing a group ----------------
r = await get('/api/console/quests', sess);
data = await r.json();
const group = data.groups.find(g => g.key === 'SQ40');
check('the console sees groups with ids and their codes', !!group && group.id > 0 && group.codes.length === 1 && data.loose.length === seededCodes, '');
purges = 0;
r = await post('/api/console/quests/group/save', {
  id: group.id, key: 'SQ40', name: 'Wondabyne', region: group.region,
  description: 'Whole team on the platform.\n\n__Bonus:__ public transport from Central.',
  flavour: 'No road leads here.', location: 'Wondabyne Station',
  coords: 'Platform @ -33.4934, 151.2487\nWharf @ -33.4950, 151.2500',
  submit: 'text', prompt: 'Which carriage?', options: '',
  codes: [{ was: 'SQ40', code: 'SQ40', label: '', points: 1000 }, { code: 'SQ40-B', label: 'Public transport bonus', points: 150 }]
}, sess);
data = await r.json();
check('a save updates every field and adds a code', r.status === 200 && data.group.codes.length === 2 && data.group.coords.length === 2 &&
  data.group.submit === 'text' && data.group.codes[0].points === 1000, JSON.stringify(data.group && data.group.codes));
check('the save purged the public reads', purges > 0, 'purges=' + purges);
r = await get('/api/questlist');
const pub = (await r.json()).groups.find(g => g.key === 'SQ40');
check('the site sees the change at once', pub.codes[1].code === 'SQ40-B' && pub.coords[1].label === 'Wharf' && pub.prompt === 'Which carriage?', '');
// pins saved while the dashboard's lines were read as one pin come back
// as the pins they were, on the site and in the editor
raw.prepare('UPDATE quest_groups SET coords = ? WHERE id = ?').run(JSON.stringify([
  { label: 'Platform @ -33.4934, 151.2487 Wharf @ -33.495, 151.25 Bridge', lat: -33.49, lng: 151.25 }]), group.id);
const unfolded = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'SQ40').coords;
check('pins sent one a line are kept apart, and pins folded into one by the old save read as the pins they were',
  data.group.coords.map(c => c.label).join() === 'Platform,Wharf' &&
  JSON.stringify(unfolded) === JSON.stringify([{ label: 'Platform', lat: -33.4934, lng: 151.2487 }, { label: 'Wharf', lat: -33.495, lng: 151.25 },
    { label: 'Bridge', lat: -33.49, lng: 151.25 }]), JSON.stringify({ saved: data.group.coords, unfolded }));

r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: group.region,
  codes: [{ was: 'SQ40', code: 'sq 46-1', points: 1000 }] }, sess);
check('a code clashing with another quest is refused', r.status === 409, 'status=' + r.status);
r = await post('/api/console/quests/group/save', { key: 'SQ1', name: 'Clash', region: 'Central Region', codes: [] }, sess);
check('a group key clashing with another group is refused', r.status === 409, 'status=' + r.status);
// the codes the EOI award, adjustments and deleted quests hold are not a
// quest's to take, however they are written
{
  const kept = await Promise.all([
    post('/api/console/quests/group/save', { key: 'KQ1', name: 'Kept', region: '', codes: [{ code: 'EOI', points: 5 }] }, sess),
    post('/api/console/quests/group/save', { key: 'adj', name: 'Kept', region: '', codes: [{ code: 'KQ2', points: 5 }] }, sess),
    post('/api/console/quests/add', { code: 'Deleted', points: 5 }, sess),
    post('/api/console/quests/file/preview', { text: JSON.stringify({ quests: [{ code: 'KQ3', name: 'Kept', codes: [{ code: 'ADJ', points: 5 }] }] }) }, sess)
  ]);
  const said = await Promise.all(kept.map(x => x.json()));
  check('a quest saved, added or imported with EOI, ADJ or DELETED, in any case, is refused and takes nothing',
    kept.slice(0, 3).every(x => x.status === 400) && said[3].rows && said[3].rows[0].status === 'error' && /kept for adjustments/.test(said[3].rows[0].detail) &&
    !raw.prepare("SELECT 1 FROM quest_groups WHERE key IN ('KQ1', 'adj')").get() && !raw.prepare("SELECT 1 FROM quests WHERE norm IN ('DELETED', 'KQ2')").get(),
    JSON.stringify(said.map(s => s.error || s.rows)));
}

// a rename moves the tab entries and submissions with it
const team = await db.prepare('SELECT id, name FROM teams ORDER BY id LIMIT 1').first();
credit(raw, team.id, 'SQ40-B', 1);
// what a submission credited and the codes its team ticked name the code
// too, and so does an award's record of the code it paid on
const creditedRow = (await db.prepare("INSERT INTO submissions (team_id, quest_code, status, credit, answer) VALUES (?1, 'SQ40', 'accepted', ?2, ?3)")
  .bind(team.id, JSON.stringify({ codes: ['SQ40', 'SQ40-B'], amount: 1, counts: { 'SQ40-B': 2 } }),
    JSON.stringify({ kind: 'codes', value: ['SQ40-B'], more: [{ kind: 'text', value: 'SQ40-B' }] })).run()).meta.last_row_id;
await db.prepare("UPDATE quest_groups SET tally_settled = ?2 WHERE id = ?1")
  .bind(group.id, JSON.stringify({ at: '2026-10-20 01:00:00', by: 'Runner', id: 'x', code: 'SQ40-B', given: [[team.id, 1]] })).run();
r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: group.region,
  codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }, { was: 'SQ40-B', code: 'SQ40-PT', label: 'Public transport bonus', points: 150, hidden: 1 }] }, sess);
data = await r.json();
const moved = await db.prepare("SELECT quest_code FROM held WHERE team_id = ?1 AND quest_code = 'SQ40-PT'").bind(team.id).first();
const stale = await db.prepare("SELECT COUNT(*) AS n FROM quests WHERE code = 'SQ40-B'").first();
check('renaming a code re-keys its tab entries', r.status === 200 && !!moved && stale.n === 0, JSON.stringify(data));
const renamedSub = await db.prepare('SELECT credit, answer FROM submissions WHERE id = ?1').bind(creditedRow).first();
const renamedStamp = JSON.parse((await db.prepare('SELECT tally_settled FROM quest_groups WHERE id = ?1').bind(group.id).first()).tally_settled);
check('a rename reaches what submissions credited, the codes a team ticked and an award\u2019s code, and leaves typed answers alone',
  renamedSub.credit === JSON.stringify({ codes: ['SQ40', 'SQ40-PT'], amount: 1, counts: { 'SQ40-PT': 2 } }) &&
  JSON.stringify(JSON.parse(renamedSub.answer)) === JSON.stringify({ kind: 'codes', value: ['SQ40-PT'], more: [{ kind: 'text', value: 'SQ40-B' }] }) &&
  renamedStamp.code === 'SQ40-PT',
  JSON.stringify({ renamedSub, renamedStamp }));
await db.prepare("UPDATE quest_groups SET tally_settled = '' WHERE id = ?1").bind(group.id).run();
await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(creditedRow).run();
r = await get('/api/questlist');
const pub2 = (await r.json()).groups.find(g => g.key === 'SQ40');
check('a hidden code stays off the site but on the console', pub2.codes.length === 1 && data.group.codes.length === 2 && data.group.codes[1].hidden === 1, '');
r = await get('/api/console/team/receipt?team_id=' + team.id, sess);
data = await r.json();
const scoreRow = [].concat.apply([], (data.quests || []).map(q => q.held)).find(c => c.code === 'SQ40-PT');
check('the team\u2019s ledger still shows the hidden code the team holds', !!scoreRow && scoreRow.amount === 1, JSON.stringify(scoreRow));

// ---------------- submissions with answers ----------------
r = await post('/api/console/codes/generate', {}, sess);
r = await get('/api/console/codes', sess);
const code = (await r.json()).codes.find(c => c.name === team.name).code;
r = await post('/api/submit/login', { team_name: team.name, code });
const teamSess = (await r.json()).session;
const send = (quest, answer) => {
  const f = new FormData();
  f.append('quest', quest);
  if (answer !== undefined) f.append('answer', answer);
  const proof = new Uint8Array(64);
  proof.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
  proof.set([0xFF, 0xD9], 62);
  f.append('files', new File([proof], 'proof.jpg', { type: 'image/jpeg' }), 'proof.jpg');
  return front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
};
r = await send('SQ40-PT');
check('a hidden code cannot be submitted against', r.status === 400, 'status=' + r.status);
r = await send('s1-o');
check('a retired code cannot be submitted against', r.status === 400, 'status=' + r.status);
r = await send('sq1', JSON.stringify({ kind: 'pick', value: ['Wondabyne', 'Central', '<b>x</b>'] }));
data = await r.json();
const pickId = data.id;
check('a pick answer is stored with the submission', r.status === 200 && data.quest === 'SQ1', JSON.stringify(data));
r = await send('SQ1', 'not json');
check('a malformed answer is refused', r.status === 400, 'status=' + r.status);
r = await send('SQ1', JSON.stringify({ kind: 'bogus', value: 1 }));
check('an unknown answer kind is refused', r.status === 400, 'status=' + r.status);
r = await send('SQ46-1', JSON.stringify({ kind: 'codes', value: ['SQ46-1', 'SQ46-7'] }));
data = await r.json();
const codesId = data.id;
check('a codes answer lands under the submitted code', r.status === 200 && data.quest === 'SQ46-1', JSON.stringify(data));
r = await get('/api/submit/mine', teamSess);
data = await r.json();
const mine = data.submissions.find(s => s.id === pickId);
check('mine returns the answer parsed, text kept verbatim (pages render it as text)', mine.answer.kind === 'pick' && mine.answer.value.length === 3 && mine.answer.value[2] === '<b>x</b>', JSON.stringify(mine.answer));

r = await get('/api/console/submissions?status=pending', sess);
data = await r.json();
const review = data.submissions.find(s => s.id === codesId);
check('the review list carries the answer, the quest name and the group codes',
  review.answer.value[1] === 'SQ46-7' && review.quest_name === 'The Macquaries of Sydney' && review.codes.length === 11 && review.group_key === 'SQ46',
  JSON.stringify({ name: review.quest_name, codes: review.codes.length }));

const before = await db.prepare('SELECT COUNT(*) AS n FROM held WHERE team_id = ?1').bind(team.id).first();
r = await post('/api/console/submissions/accept', { id: codesId, codes: ['SQ46-1', 'SQ46-7', 'SQ46-1'] }, sess);
data = await r.json();
const after = await db.prepare('SELECT COUNT(*) AS n FROM held WHERE team_id = ?1').bind(team.id).first();
check('accepting credits each ticked code once', r.status === 200 && data.codes.length === 2 && after.n === before.n + 2 && data.quest === 'SQ46-1 + SQ46-7',
  JSON.stringify(data));
r = await post('/api/console/submissions/accept', { id: pickId, codes: ['SQ46-2'] }, sess);
check('a code from another quest cannot be credited', r.status === 400, 'status=' + r.status);
r = await post('/api/console/submissions/accept', { id: pickId, codes: ['SQ1', 'SQ1-B'] }, sess);
data = await r.json();
check('two parts of the same quest can be credited together', r.status === 200 && data.codes.join(',') === 'SQ1,SQ1-B', JSON.stringify(data));
r = await get('/api/quests');
data = await r.json();
check('the group count reflects a team with any of its codes', data.groups.SQ46 === 1 && data.groups.SQ1 === 1, JSON.stringify({ sq46: data.groups.SQ46, sq1: data.groups.SQ1 }));

// ---------------- regions ----------------
r = await get('/api/console/quests', sess);
data = await r.json();
check('the console lists the regions in list order with quest counts',
  data.regions.map(x => x.name).join('|') === REGIONS.join('|') && data.regions[0].quests > 0 && data.regions.every(x => x.id > 0), JSON.stringify(data.regions[0]));
const region11 = data.regions.find(x => x.name === 'Region 11');
r = await post('/api/console/quests/regions/save', { id: region11.id, name: 'Physical Region' }, sess);
check('renaming a region onto another name is refused', r.status === 409, 'status=' + r.status);
r = await post('/api/console/quests/regions/save', { id: region11.id, name: 'Wildcard Region' }, sess);
data = await r.json();
const renamedCount = await db.prepare("SELECT COUNT(*) AS n FROM quest_groups WHERE region = 'Wildcard Region'").first();
check('renaming a region carries its quests along', r.status === 200 && renamedCount.n === region11.quests && data.regions.some(x => x.name === 'Wildcard Region'), JSON.stringify(renamedCount));
r = await post('/api/console/quests/regions/save', { name: 'Harbour Region' }, sess);
data = await r.json();
const harbour = data.regions.find(x => x.name === 'Harbour Region');
check('a new region lands at the end with no quests', r.status === 200 && harbour && harbour.quests === 0 && data.regions[data.regions.length - 1].name === 'Harbour Region', '');
r = await post('/api/console/quests/regions/save', { name: 'harbour region' }, sess);
check('region names are unique regardless of case', r.status === 409, 'status=' + r.status);
const ids = data.regions.map(x => x.id);
ids.unshift(ids.pop());
r = await post('/api/console/quests/regions/order', { ids }, sess);
data = await r.json();
check('regions reorder', data.regions[0].name === 'Harbour Region' && data.regions[1].name === REGIONS[0], data.regions.map(x => x.name).slice(0, 2).join('|'));
r = await get('/api/questlist');
data = await r.json();
check('the public list skips regions with no visible quest and follows the new order',
  data.regions[0] === REGIONS[0] && data.regions.indexOf('Harbour Region') === -1 && data.regions.indexOf('Wildcard Region') !== -1, JSON.stringify(data.regions));
// a region's colour on the quest sheet: one of the line colours, carried
// by the public list under the region's name
const wildcard = (await db.prepare("SELECT id FROM quest_regions WHERE name = 'Wildcard Region'").first()).id;
const badColour = await post('/api/console/quests/regions/colour', { id: wildcard, colour: 'magenta' }, sess);
r = await post('/api/console/quests/regions/colour', { id: wildcard, colour: 'orange' }, sess);
const coloured = await (await get('/api/questlist')).json();
check('a region takes one of the line colours and the public list carries it by name',
  badColour.status === 400 && r.status === 200 && coloured.region_colours['Wildcard Region'] === 'orange' &&
  Object.keys(coloured.region_colours).length === 1, JSON.stringify(coloured.region_colours));

// ---------------- a region's quests in order ----------------
// quests/order: the ids sent first, the region's others after them in
// the order they had (the dashboard leaves out quests under a hidden tag)
{
  const clubsOnSite = async () => (await (await get('/api/questlist')).json()).groups
    .filter(g => g.region === 'Clubs Region').map(g => g.key).join();
  const dash = await (await get('/api/console/quests', sess)).json();
  const clubs = dash.groups.filter(g => g.region === 'Clubs Region');
  const other = dash.groups.find(g => g.region !== 'Clubs Region');
  const sent = clubs.slice(1).reverse();
  const want = sent.concat(clubs.slice(0, 1)).map(g => g.key).join();
  r = await post('/api/console/quests/order', { region: 'clubs region', ids: sent.map(g => g.id) }, sess);
  data = await r.json();
  const answered = data.groups.filter(g => g.region === 'Clubs Region').map(g => g.key).join();
  const site = await clubsOnSite();
  check('a region\'s quests take the order sent, any left out after them, and the site lists them so',
    r.status === 200 && clubs.length > 2 && answered === want && site === want, JSON.stringify({ status: r.status, want, answered, site }));
  const refused = [
    (await post('/api/console/quests/order', { region: 'Clubs Region', ids: [clubs[0].id, other.id] }, sess)).status,
    (await post('/api/console/quests/order', { region: 'Clubs Region', ids: [clubs[0].id, clubs[0].id] }, sess)).status
  ];
  check('a quest from another region, or one sent twice, is refused and the order stays',
    refused.join() === '409,400' && (await clubsOnSite()) === want, JSON.stringify(refused));
  await post('/api/console/accounts/save', { create: true, name: 'Quester', password: 'quester-pass-1', perms: ['quests'], require_2fa: false }, sess);
  await post('/api/console/accounts/save', { create: true, name: 'Reviewer', password: 'reviewer-pass-1', perms: ['review'], require_2fa: false }, sess);
  const signIn = async (name, password) => (await (await post('/api/console/login', { name, password })).json()).session;
  const original = clubs.map(g => g.id);
  const byTab = [
    (await post('/api/console/quests/order', { region: 'Clubs Region', ids: original }, await signIn('Reviewer', 'reviewer-pass-1'))).status,
    (await post('/api/console/quests/order', { region: 'Clubs Region', ids: original }, await signIn('Quester', 'quester-pass-1'))).status
  ];
  check('the Quests tab may put a region in order and the Review tab may not',
    byTab.join() === '403,200' && (await clubsOnSite()) === clubs.map(g => g.key).join(), JSON.stringify(byTab));
}
r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: 'Harbour Region',
  codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
check('a quest moves into the new region', r.status === 200 && (await r.json()).group.region === 'Harbour Region', '');
r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: 'Brand New Region',
  codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
data = await r.json();
const brandNew = (await db.prepare("SELECT id FROM quest_regions WHERE name = 'Brand New Region'").first());
check('a region typed on a quest joins the region list', r.status === 200 && !!brandNew, JSON.stringify(data.group && data.group.region));
r = await post('/api/console/quests/regions/delete', { id: brandNew.id, to: 'Harbour Region' }, sess);
data = await r.json();
const movedQ = await db.prepare('SELECT region FROM quest_groups WHERE id = ?1').bind(group.id).first();
check('deleting a region moves its quests where asked', r.status === 200 && data.moved === 1 && movedQ.region === 'Harbour Region', JSON.stringify(data));
r = await post('/api/console/quests/regions/delete', { id: harbour.id, to: '' }, sess);
const noRegion = await db.prepare('SELECT region FROM quest_groups WHERE id = ?1').bind(group.id).first();
check('or leaves them with no region', r.status === 200 && noRegion.region === '', JSON.stringify(noRegion));
r = await get('/api/questlist');
data = await r.json();
const lastGroup = data.groups[data.groups.length - 1];
check('quests without a region come last on the site, region blank', lastGroup.key === 'SQ40' && lastGroup.region === '', lastGroup.key);
r = await post('/api/console/quests/regions/delete', { id: harbour.id, to: '' }, sess);
check('deleting a region twice is a 404', r.status === 404, 'status=' + r.status);

// ---------------- mystery points ----------------
// The tab keeps what a mystery quest is worth and scores it; nothing a
// team or the public reads says the figure.
r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', mystery: true,
  codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
const mysterySave = await r.json();
const pubMystery = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'SQ40');
const teamMystery = (await (await get('/api/questlist/team', teamSess)).json()).groups.find(g => g.key === 'SQ40');
const statsMystery = (await (await get('/api/quests')).json()).quests.find(q => q.code === 'SQ40');
const dashMystery = (await (await get('/api/console/quests', sess)).json()).groups.find(g => g.key === 'SQ40');
const pointsBefore = (await (await get('/api/leaderboard')).json()).teams.find(t => t.name === team.name).points;
await post('/api/console/ledger/adjust', { team_id: team.id, code: 'SQ40', points: 1000, reason: 'Done' }, sess);
const pointsAfter = (await (await get('/api/leaderboard')).json()).teams.find(t => t.name === team.name).points;
check('a mystery quest reads ??? to everyone but the dashboard, and the tab still scores it',
  r.status === 200 && mysterySave.group.mystery === 1 &&
  pubMystery.mystery === true && pubMystery.codes.every(c => c.points === null) &&
  teamMystery.mystery === true && teamMystery.codes.every(c => c.points === null) &&
  statsMystery.points === null && dashMystery.mystery === 1 && dashMystery.codes[0].points === 1000 &&
  pointsAfter === pointsBefore + 1000,
  JSON.stringify({ pub: pubMystery.codes, stats: statsMystery, before: pointsBefore, after: pointsAfter }));
await post('/api/console/ledger/adjust', { team_id: team.id, code: 'SQ40', points: -1000, reason: 'Undone' }, sess);
// its points show again for what follows
await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', mystery: false,
  codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);

// ---------------- what a quest takes and counts ----------------
// rules.js: the files the form takes and a challenge's count, and each
// code's scoring type (parts.js). The page and the worker agree on the
// shape, a save that leaves them out keeps them, and they ride the
// export and come back with an import.
{
  const wanted = { files: { kinds: ['photo', 'gpx'], max: 10, required: false }, tally: { kind: 'picks', awards: '1000, 700', public: true } };
  r = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', rules: wanted,
    codes: [{ was: 'SQ40', code: 'SQ40', points: 1000, scoring: 'judged' }] }, sess);
  const saved = await r.json();
  await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '',
    codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
  const dash = (await (await get('/api/console/quests', sess)).json()).groups.find(g => g.key === 'SQ40');
  const pub = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'SQ40');
  const out = (await (await get('/api/console/quests/export?format=json', sess)).json()).quests.find(q => q.code === 'SQ40');
  const csvOut = await (await get('/api/console/quests/export?format=csv', sess)).text();
  const expect = JSON.stringify({ files: { kinds: ['photo', 'gpx'], max: 10, required: false }, tally: { kind: 'picks', awards: [1000, 700], public: true }, partial: false });
  const judged = list => (list || []).find(c => c.code === 'SQ40').scoring === 'judged';
  const bad = await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '',
    rules: { files: { kinds: ['exe'] } }, codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
  const plain = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'SQ41');
  check('a quest keeps what it takes and counts through a save that leaves them out, the list and the export',
    r.status === 200 && JSON.stringify(saved.group.rules) === expect && JSON.stringify(dash.rules) === expect &&
    JSON.stringify(pub.rules) === expect && JSON.stringify(out.rules) === expect && bad.status === 400 &&
    judged(saved.group.codes) && judged(dash.codes) && judged(pub.codes) && judged(out.codes) && /\| judged/.test(csvOut) &&
    plain && JSON.stringify(plain.rules.files) === JSON.stringify({ kinds: ['photo', 'video'], max: 4, required: true }),
    JSON.stringify({ saved: saved.group && saved.group.rules, dash: dash.rules, out: out.rules }));
  // the export, read back in by a quest whose rules are the defaults
  const back = [];
  for (const text of [JSON.stringify({ quests: [out] }), csvOut]) {
    await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', rules: {},
      codes: [{ was: 'SQ40', code: 'SQ40', points: 1000, scoring: 'fixed' }] }, sess);
    await post('/api/console/quests/file/commit', { text }, sess);
    const now = (await (await get('/api/console/quests', sess)).json()).groups.find(g => g.key === 'SQ40');
    back.push(JSON.stringify(now.rules) + (judged(now.codes) ? ' judged' : ''));
  }
  // a file from before the types asks for part marks with a switch
  await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', rules: {},
    codes: [{ was: 'SQ40', code: 'SQ40', points: 1000, scoring: 'fixed' }] }, sess);
  await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', rules: { partial: true },
    codes: [{ was: 'SQ40', code: 'SQ40', points: 1000 }] }, sess);
  const older = (await (await get('/api/console/quests', sess)).json()).groups.find(g => g.key === 'SQ40');
  check('an import of either export puts them back, the code\'s type included, and an older file\'s part marks make the codes judged',
    back.every(b => b === expect + ' judged') && judged(older.codes) && !older.rules.partial, JSON.stringify(back));
  await post('/api/console/quests/group/save', { id: group.id, key: 'SQ40', name: 'Wondabyne', region: '', rules: {},
    codes: [{ was: 'SQ40', code: 'SQ40', points: 1000, scoring: 'fixed' }] }, sess);
}

// ---------------- export and file import ----------------
r = await get('/api/console/quests/export?format=csv', sess);
const csv = await r.text();
check('the CSV export is a download with one row per quest',
  r.status === 200 && r.headers.get('content-disposition').includes('scs2-quests.csv') && csv.startsWith('code,name,region,') &&
  csv.includes('"SQ46-1 | Macquarie Lighthouse | 100') && csv.includes('**Note:**'), csv.slice(0, 60));
r = await get('/api/console/quests/export?format=json', sess);
const exported = await r.json();
check('the JSON export carries regions and every quest with its codes',
  exported.regions.length > 0 && exported.quests.length === SCS2.length && exported.quests.find(q => q.code === 'SQ46').codes.length === 11, '');
r = await post('/api/console/quests/file/preview', { text: csv }, sess);
data = await r.json();
check('re-importing the export changes nothing', r.status === 200 && data.rows.length === SCS2.length && data.rows.every(x => x.status === 'same'),
  JSON.stringify(data.rows.filter(x => x.status !== 'same').slice(0, 3)));
r = await post('/api/console/quests/file/preview', { text: JSON.stringify(exported) }, sess);
data = await r.json();
check('the JSON export round-trips too', r.status === 200 && data.rows.every(x => x.status === 'same'),
  JSON.stringify(data.rows.filter(x => x.status !== 'same').slice(0, 3)));

// edit two rows in a spreadsheet-like way, add one, break one
const edited = csv
  .replace('"SQ46-1 | Macquarie Lighthouse | 100', '"SQ46-1 | Macquarie Lighthouse | 120')
  .replace(/^SQ12,([^,]*),/m, 'SQ12,$1,Harbour Region,')
  .replace(/^(SQ12,[^,]*,)Harbour Region,[^,]*,/m, '$1Harbour Region,')
  + 'SQ99,Brand new quest,Harbour Region,"Find the **new** thing.",,,,count,How many?,,99,0,"SQ99 | | 50\nSQ99-B | Bonus | 25"\r\n'
  + 'SQ98,Steals a code,,,,,,none,,,98,0,"SQ46-2 | | 5"\r\n';
r = await post('/api/console/quests/file/preview', { text: edited }, sess);
data = await r.json();
const byKeyRow = {};
data.rows.forEach(x => { byKeyRow[x.key] = x; });
check('the preview names each change',
  byKeyRow.SQ46.status === 'update' && byKeyRow.SQ46.detail === '1 code' && byKeyRow.SQ12.status === 'update' && byKeyRow.SQ12.detail === 'region' &&
  byKeyRow.SQ99.status === 'add' && byKeyRow.SQ98.status === 'error' && /SQ46/.test(byKeyRow.SQ98.detail),
  JSON.stringify([byKeyRow.SQ46, byKeyRow.SQ12, byKeyRow.SQ99, byKeyRow.SQ98]));
r = await post('/api/console/quests/file/commit', { text: edited }, sess);
check('a file with a broken row is not imported at all', r.status === 400 && (await r.json()).error.includes('1 row'), 'status=' + r.status);
const clean = edited.replace(/^SQ98,.*\r\n/m, '');
r = await post('/api/console/quests/file/commit', { text: clean }, sess);
data = await r.json();
const sq99 = await db.prepare("SELECT g.region, (SELECT COUNT(*) FROM quests q WHERE q.group_id = g.id) AS codes FROM quest_groups g WHERE key = 'SQ99'").first();
const sq461 = await db.prepare("SELECT points FROM quests WHERE code = 'SQ46-1'").first();
const harbourAgain = await db.prepare("SELECT id FROM quest_regions WHERE name = 'Harbour Region'").first();
check('the commit adds, updates and creates the region it names',
  r.status === 200 && data.added === 1 && data.updated === 2 && sq99.codes === 2 && sq99.region === 'Harbour Region' && sq461.points === 120 && !!harbourAgain,
  JSON.stringify(data));
r = await post('/api/console/quests/file/preview', { text: 'not,a,quest\nfile' }, sess);
check('a file without the right columns is refused plainly', r.status === 400 && (await r.json()).error.includes('code and name'), '');

// ---------------- several questions ----------------
r = await post('/api/console/quests/group/save', { key: 'XQ9', name: 'Ferry quiz', region: '',
  questions: [{ kind: 'text', prompt: 'Who led?' }, { kind: 'choice', prompt: 'Which ferry?', options: '' }], codes: [{ code: 'XQ9', points: 10 }] }, sess);
const noOptions = r.status;
r = await post('/api/console/quests/group/save', { key: 'XQ9', name: 'Ferry quiz', region: '',
  questions: [{ kind: 'text', prompt: 'Who led?' }, { kind: 'choice', prompt: 'Which ferry?', options: 'Manly\nTaronga\n@stations' },
    { kind: 'codes', prompt: 'Which parts?' }],
  codes: [{ code: 'XQ9', points: 10 }, { code: 'XQ9-B', label: 'Bonus', points: 5 }] }, sess);
const quiz = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'XQ9');
check('a quest asks several questions in order, ticking codes always first and in the old fields too, and pick-one needs its options',
  noOptions === 400 && r.status === 200 && quiz.questions.map(q => q.kind).join() === 'codes,text,choice' &&
  quiz.questions[2].options.join() === 'Manly,Taronga' && quiz.submit === 'codes' && quiz.prompt === 'Which parts?',
  JSON.stringify(quiz && quiz.questions));
r = await send('XQ9', JSON.stringify({ kind: 'codes', value: ['XQ9', 'XQ9-B'], more: [
  { kind: 'text', prompt: 'Who led?', value: 'Sam' }, { kind: 'choice', prompt: 'Which ferry?', value: 'Manly' }] }));
const quizId = (await r.json()).id;
const badMore = await send('XQ9', JSON.stringify({ kind: 'codes', value: ['XQ9'], more: [{ kind: 'count', value: -3 }] }));
const quizMine = (await (await get('/api/submit/mine', teamSess)).json()).submissions.find(s => s.id === quizId);
check('the answers to several questions are kept in order with each question as worded, and one bad answer refuses the lot',
  quizMine && quizMine.answer.value.join() === 'XQ9,XQ9-B' && quizMine.answer.more[0].prompt === 'Who led?' &&
  quizMine.answer.more[1].value === 'Manly' && badMore.status === 400,
  JSON.stringify(quizMine && quizMine.answer));
const quizExport = (await (await get('/api/console/quests/export?format=json', sess)).json()).quests.find(q => q.code === 'XQ9');
const quizCsv = await (await get('/api/console/quests/export?format=csv', sess)).text();
const quizBack = await Promise.all([JSON.stringify({ quests: [quizExport] }), quizCsv].map(async text =>
  (await (await post('/api/console/quests/file/preview', { text }, sess)).json()).rows.find(x => x.key === 'XQ9')));
check('a quest file carries the questions and reads back unchanged',
  quizExport.questions.length === 3 && quizBack.every(x => x && x.status === 'same'), JSON.stringify(quizBack));

// ---------------- review, one quest at a time ----------------
const oneQuest = await (await get('/api/console/submissions?status=all&quest=sq46', sess)).json();
const everyQuest = await (await get('/api/console/submissions?status=all', sess)).json();
const inDb = (await db.prepare('SELECT COUNT(*) AS n FROM submissions s JOIN teams t ON t.id = s.team_id').first()).n;
const sq46Count = oneQuest.counts.find(c => c.key === 'SQ46');
check('review lists one quest\'s submissions when asked for it by key, and counts every quest\'s',
  oneQuest.submissions.length > 0 && oneQuest.submissions.every(x => x.group_key === 'SQ46') &&
  !!sq46Count && sq46Count.n === oneQuest.submissions.length &&
  everyQuest.counts.reduce((sum, c) => sum + c.n, 0) === inDb && everyQuest.submissions.length === inDb,
  JSON.stringify({ one: oneQuest.submissions.length, sq46Count, counted: everyQuest.counts.length, inDb }));

// ---------------- review, one team at a time ----------------
const [rival, tester] = raw.prepare('SELECT id FROM teams WHERE id != ? ORDER BY id LIMIT 2').all(team.id).map(t => t.id);
raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(tester);
[[rival, 'SQ1', 'rejected'], [rival, 'SQ46-1', 'deleted'], [tester, 'SQ1', 'pending']].forEach(([id, code, status]) =>
  raw.prepare('INSERT INTO submissions (team_id, quest_code, status) VALUES (?, ?, ?)').run(id, code, status));
const oneTeam = await (await get('/api/console/submissions?status=all&team_id=' + team.id, sess)).json();
const rivalOnSq1 = await (await get('/api/console/submissions?status=all&quest=SQ1&team_id=' + rival, sess)).json();
const perTeam = raw.prepare('SELECT team_id AS id, COUNT(*) AS n FROM submissions GROUP BY team_id ORDER BY team_id').all();
const teamCounts = oneTeam.team_counts.slice().sort((a, b) => a.id - b.id);
check('review lists one team\'s submissions in every status when asked by its id, with the quest too, and counts every team\'s',
  oneTeam.submissions.length === perTeam.find(t => t.id === team.id).n && oneTeam.submissions.every(x => x.team_id === team.id) &&
  new Set(oneTeam.submissions.map(x => x.status)).size > 1 &&
  JSON.stringify(teamCounts.map(t => [t.id, t.n])) === JSON.stringify(perTeam.map(t => [t.id, t.n])) &&
  teamCounts.find(t => t.id === tester).hidden === 1 && rivalOnSq1.submissions.map(x => x.status).join() === 'rejected',
  JSON.stringify({ one: oneTeam.submissions.map(x => x.status), teamCounts, perTeam, rival: rivalOnSq1.submissions.length }));

// ---------------- delete ----------------
r = await post('/api/console/quests/group/delete', { id: group.id, confirm: 'nope' }, sess);
check('deleting a group needs its key typed', r.status === 428 && (await r.json()).error.includes('1 tab entry'), '');
r = await post('/api/console/quests/group/delete', { id: group.id, confirm: 'SQ40' }, sess);
const gone = await db.prepare("SELECT COUNT(*) AS n FROM quests WHERE code LIKE 'SQ40%'").first();
check('a typed delete removes the group, its codes and their entries', r.status === 200 && gone.n === 0, '');

r = await get('/api/console/log', sess);
data = await r.json();
const actions = data.entries.map(e => e.action);
check('every step is in the audit log',
  ['quests-retire', 'quests-import', 'quest-save', 'submit-accept', 'quest-group-delete', 'region-rename', 'region-delete', 'quests-file-import', 'quest-order'].every(a => actions.includes(a)), JSON.stringify(actions.slice(0, 8)));

// ---------------- search tags ----------------
const anyGroup = (await db.prepare('SELECT id, key, name, region FROM quest_groups WHERE hidden = 0 ORDER BY id LIMIT 1').first());
const anyCodes = (await db.prepare('SELECT code, label, points FROM quests WHERE group_id = ?1 ORDER BY sort, code').bind(anyGroup.id).all()).results;
const saveTagged = (extra) => post('/api/console/quests/group/save', Object.assign(
  { id: anyGroup.id, key: anyGroup.key, name: anyGroup.name, region: anyGroup.region, codes: anyCodes }, extra), sess);
r = await saveTagged({ keywords: ' Train, FOOD ,train,\nharbour view ' });
const stored = (await db.prepare('SELECT keywords FROM quest_groups WHERE id = ?1').bind(anyGroup.id).first()).keywords;
await saveTagged({});
const kept = (await db.prepare('SELECT keywords FROM quest_groups WHERE id = ?1').bind(anyGroup.id).first()).keywords;
const pubTags = ((await (await get('/api/questlist')).json()).groups.find(g => g.key === anyGroup.key) || {}).keywords;
const csvTags = await (await get('/api/console/quests/export?format=csv', sess)).text();
check('search tags are tidied and kept once each, a save that sends none keeps them, and the public list and the export carry them',
  r.status === 200 && stored === 'train, food, harbour view' && kept === stored &&
  JSON.stringify(pubTags) === '["train","food","harbour view"]' && csvTags.includes('"train, food, harbour view"'),
  JSON.stringify({ status: r.status, stored, kept, pubTags, csv: csvTags.slice(0, 120) }));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
