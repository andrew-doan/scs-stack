// One-off: proposes a scoring type for every part of every quest, for a
// person to check before it is applied (src/parts.ts says what the types
// mean).
//
//   node scripts/classify-quests.mjs [export.json] [--out parts.json]
//
// Reads the dashboard's JSON export (Quests tab, Import and export,
// JSON), or with no file the SCS.2 list in src/data/scs2-quests.ts, and
// prints a Markdown table: each quest, its parts as proposed, and the
// codes a proposal folds into another part. With --out it also writes
// the proposal as a file the Quests tab's import takes. The import never
// deletes a code, so a folded code has to be deleted by hand on the
// Quests tab; one that teams already hold points on should stay.
//
// The rules, in order:
//   - codes labelled with a number of something ("10–14 stations", "25+
//     stations", "3 Sushi Hubs") are tiers. Beside a code labelled
//     "Most ..." on a quest that asks a team to pick places, they become
//     one counted part, the tiers its bands and Most and Runner up its
//     places; otherwise one tiered part.
//   - a code labelled "Per ..." is per unit, with its most read from
//     "max N" or "capped at N" points in the label.
//   - a quest that took part marks has judged codes.
//   - everything else is fixed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt === -1 ? '' : args[outAt + 1];
const inFile = args.filter((a, i) => a !== '--out' && i !== outAt + 1)[0];

let quests;
if (inFile) {
  const data = JSON.parse(readFileSync(inFile, 'utf8'));
  quests = (Array.isArray(data) ? data : data.quests).map(q => ({
    key: q.code || q.key, name: q.name, submit: q.answer || q.submit || 'none', options: q.options || [],
    rules: typeof q.rules === 'string' ? (q.rules ? JSON.parse(q.rules) : {}) : (q.rules || {}), codes: q.codes || [], record: q
  }));
} else {
  const { QUESTS } = await import(join(ROOT, 'src/data/scs2-quests.ts'));
  quests = QUESTS.map(q => ({ key: q.key, name: q.name, submit: q.submit, options: q.options || [], rules: q.rules || {}, codes: q.codes, record: null }));
}

const TIER = /^(\d+)\s*(?:[–-]\s*\d+|\+)?\s+\S/;
const MOST = /^most\b/i;
const RUNNER = /^runner[ -]?up\b/i;
const PER = /^per\b/i;

function classify(q) {
  const parts = [];
  const folded = [];
  const notes = [];
  // a code already given a type keeps it
  const tiers = q.codes.filter(c => !(c.scoring && c.scoring !== 'fixed') && TIER.test(c.label || ''));
  const most = q.codes.find(c => MOST.test(c.label || ''));
  const runner = q.codes.find(c => RUNNER.test(c.label || ''));
  const picks = q.submit === 'pick' || (q.rules.tally && q.rules.tally.kind);
  const bands = tiers.map(c => ({ from: Number(TIER.exec(c.label)[1]), points: Number(c.points) }))
    .sort((a, b) => a.from - b.from);
  let rules = null;
  if (tiers.length >= 2 && most && picks) {
    const lead = most;
    parts.push({ code: lead.code, label: lead.label.replace(MOST, '').trim().replace(/^./, ch => ch.toUpperCase()) || 'Counted',
      scoring: 'counted', points: '', bands });
    tiers.forEach(c => folded.push(c.code));
    if (runner) folded.push(runner.code);
    const places = [Number(most.points)].concat(runner ? [Number(runner.points)] : []);
    rules = Object.assign({}, q.rules, { tally: Object.assign({ kind: 'picks', public: false }, q.rules.tally || {}, { awards: places }) });
    notes.push('counts ' + rules.tally.kind + '; places ' + places.join(', '));
  } else if (tiers.length >= 2) {
    const lead = tiers[0];
    parts.push({ code: lead.code, label: lead.label.replace(/^\d+\s*(?:[–-]\s*\d+|\+)?\s+/, '').replace(/^./, ch => ch.toUpperCase()),
      scoring: 'tiered', points: '', bands });
    tiers.slice(1).forEach(c => folded.push(c.code));
  }
  q.codes.forEach(c => {
    if (folded.indexOf(c.code) !== -1 || parts.some(p => p.code === c.code)) return;
    if (c.scoring && c.scoring !== 'fixed') {
      parts.push({ code: c.code, label: c.label || '', scoring: c.scoring, points: Number(c.points), most: c.most, bands: c.bands || [] });
    } else if (PER.test(c.label || '')) {
      const cap = /(?:max|capped at)\s+(\d+)/i.exec(c.label);
      const most = cap && Number(c.points) ? Math.floor(Number(cap[1]) / Number(c.points)) : null;
      parts.push({ code: c.code, label: c.label, scoring: 'unit', points: Number(c.points), most });
    } else if (q.rules.partial) {
      parts.push({ code: c.code, label: c.label || '', scoring: 'judged', points: Number(c.points) });
    } else {
      parts.push({ code: c.code, label: c.label || '', scoring: '', points: Number(c.points) });
    }
  });
  return { parts, folded, notes, rules };
}

function words(p) {
  if (p.scoring === 'unit') return 'per unit, ' + p.points + ' each' + (p.most ? ', up to ' + p.most : '');
  if (p.scoring === 'judged') return 'judged, up to ' + p.points;
  if (p.scoring === 'tiered') return 'tiered: ' + p.bands.map(b => b.from + '+ ' + b.points).join(', ');
  if (p.scoring === 'counted') return 'counted: bands ' + (p.bands.map(b => b.from + '+ ' + b.points).join(', ') || 'none');
  return 'fixed, ' + p.points;
}

const lines = ['| Quest | Parts as proposed | Folded into a part | Note |', '|---|---|---|---|'];
let changed = 0;
const records = [];
quests.forEach(q => {
  const c = classify(q);
  const plain = !c.folded.length && c.parts.every(p => p.scoring === '');
  if (!plain) changed++;
  lines.push('| ' + q.key + ' ' + q.name.replace(/\|/g, '/') + ' | ' +
    c.parts.map(p => p.code + (p.label ? ' (' + p.label.replace(/\|/g, '/') + ')' : '') + ': ' + words(p)).join('<br>') + ' | ' +
    (c.folded.join(', ') || '') + ' | ' + c.notes.join('; ') + ' |');
  if (q.record) {
    const r = Object.assign({}, q.record, {
      codes: c.parts.map(p => ({ code: p.code, label: p.label, points: p.points === '' ? 0 : p.points, scoring: p.scoring || 'fixed',
        most: p.most || undefined, bands: p.bands && p.bands.length ? p.bands : undefined }))
    });
    if (c.rules) r.rules = c.rules;
    records.push(r);
  }
});
console.log(lines.join('\n'));
console.log('\n' + quests.length + ' quests, ' + changed + ' not plain fixed.');
if (outFile) {
  if (!records.length) {
    console.error('--out needs an export to start from: the import updates quests in every field it carries.');
    process.exit(1);
  }
  writeFileSync(outFile, JSON.stringify({ quests: records }, null, 2));
  console.log('wrote ' + outFile);
}
