// The countdown on the home page, and the run of stops behind it.
//
// The page ships with one date built into its markup, so it counts
// from the first paint with nothing to wait for and nothing to load.
// What this holds is a list of stops in time order — the day starting,
// submissions closing, the ceremony — and the page counts to the first
// one still ahead, moving to the next as each passes. An empty list, a
// read that fails, or a worker that cannot be reached all leave the
// page counting to its built-in date, which is why neither read is
// allowed to fail loudly.
import { json, cleanText, readStamp, prop } from './shared.ts';
import type { ConsoleSession, CountdownPayload, CountdownStopRow, Env, JsonBody, LogAction, SiteTextRow } from './types.ts';

var MAX_STOPS = 8;     // more than a day has moments worth a clock
var MAX_LABEL = 60;
var MAX_OVER = 160;

// In time order, whatever order the rows were written in. `sort` only
// breaks a tie between two stops at the same moment.
export async function countdownStops(db: D1Database): Promise<CountdownPayload['stops']> {
  try {
    var rows = await db.prepare(
      "SELECT label, at FROM countdown_stops WHERE at != '' ORDER BY at, sort"
    ).all<Pick<CountdownStopRow, 'label' | 'at'>>();
    return rows.results.map(function (r) { return { label: r.label, at: r.at }; });
  } catch (err) {
    return []; // the page keeps its own date
  }
}

// What the page says once every stop has passed, or '' for the page's
// own line. A read that fails gives '' too.
export async function countdownOver(db: D1Database): Promise<string> {
  try {
    var row = await db.prepare("SELECT value FROM site_text WHERE name = 'countdown_over'").first<Pick<SiteTextRow, 'value'>>();
    return (row && row.value) || '';
  } catch (err) {
    return '';
  }
}

export async function countdownPayload(db: D1Database): Promise<CountdownPayload> {
  var got = await Promise.all([countdownStops(db), countdownOver(db)]);
  return { stops: got[0], over: got[1] };
}

export async function countdownRead(env: Env): Promise<Response> {
  var got = await Promise.all([countdownStops(env.DB), countdownOver(env.DB)]);
  return json({ ok: true, stops: got[0], over: got[1] });
}

// The whole list, replaced. Editing one row of a handful through its
// own endpoint would need ids and a merge; sending the list as it
// should be leaves nothing to go out of step, and the dashboard is
// editing all of them on one card anyway.
export async function countdownSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var sent = Array.isArray(body.stops) ? body.stops : null;
  if (!sent) return json({ error: 'Send the stops as a list.' }, 400);
  if (sent.length > MAX_STOPS) return json({ error: 'At most ' + MAX_STOPS + ' stops.' }, 400);
  var stops: { label: string; at: string }[] = [];
  for (var i = 0; i < sent.length; i++) {
    var label = cleanText(prop(sent[i], 'label'), MAX_LABEL);
    var at = readStamp(prop(sent[i], 'at'));
    if (!label) return json({ error: 'Every stop needs something to call it.' }, 400);
    // readStamp answers '' for nothing typed and null for a time it
    // cannot read; neither is a stop
    if (!at) return json({ error: 'Every stop needs a time. Check "' + label + '".' }, 400);
    stops.push({ label: label, at: at });
  }
  var writes = [env.DB.prepare('DELETE FROM countdown_stops')];
  stops.forEach(function (s, n) {
    writes.push(env.DB.prepare(
      'INSERT INTO countdown_stops (sort, label, at) VALUES (?1, ?2, ?3)'
    ).bind(n, s.label, s.at));
  });
  // the line after the last stop, when it is sent: blank goes back to
  // the page's own
  if (body.over != null) {
    var over = cleanText(body.over, MAX_OVER);
    writes.push(over
      ? env.DB.prepare(
        "INSERT INTO site_text (name, value) VALUES ('countdown_over', ?1) " +
        'ON CONFLICT(name) DO UPDATE SET value = excluded.value'
      ).bind(over)
      : env.DB.prepare("DELETE FROM site_text WHERE name = 'countdown_over'"));
  }
  await env.DB.batch(writes);
  await logAction(env.DB, session.name, 'countdown-set',
    stops.length ? stops.length + (stops.length === 1 ? ' stop' : ' stops') : 'cleared',
    stops.length ? stops[0].label : '-', 0, 0, 0);
  var got = await Promise.all([countdownStops(env.DB), countdownOver(env.DB)]);
  return json({ ok: true, stops: got[0], over: got[1] });
}
