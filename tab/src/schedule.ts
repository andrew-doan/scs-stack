// What the worker does on its own clock.
//
// Until now the only clock this worker had was somebody loading the
// site: a message written for 3am went out when the first person
// opened a page, and a ticket email that failed waited for an organiser
// to notice. A Cron Trigger is the missing piece — `[triggers]` in
// wrangler.toml calls `scheduled` once a minute whether or not anyone
// is looking.
//
// The jobs, in the order they matter, and none of them may throw: a
// scheduled run has nobody watching it, so one job failing must not
// take the others down with it. Each answers what it did and the rest
// goes in the log.
import { publishDue } from './messages.ts';
import { pushOutboxTick } from './push.ts';
import { regoRetryTick } from './rego.ts';
import { releaseDue } from './quests.ts';
import { announceTick } from './announce.ts';
import { hourlyLedgerCheck } from './ledger.ts';
import { hourlyCopy } from './freeze.ts';
import { promoteQueued } from './submit.ts';
import { stagedSweep } from './staged.ts';
import { errorMessage } from './shared.ts';
import type { Env, RenderPayload } from './types.ts';

// A job that threw: what it would have answered, with nothing in it but
// that it did not run and why.
type Failed<T> = Partial<T> & { ran: false; error: string };
type Outcome<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>> | Failed<Awaited<ReturnType<F>>>;

// What one tick did, job by job.
export interface ScheduleOut {
  published?: Outcome<typeof publishDue>;
  opened?: Outcome<typeof releaseDue>;
  queue?: Outcome<typeof promoteQueued>;
  push?: Outcome<typeof pushOutboxTick>;
  announce?: Outcome<typeof announceTick>;
  rego?: Outcome<typeof regoRetryTick>;
  copy?: Awaited<ReturnType<typeof hourlyCopy>>;
  ledger?: Outcome<typeof hourlyLedgerCheck>;
  staged?: Outcome<typeof stagedSweep>;
}

async function attempt<T>(name: string, work: () => Promise<T>): Promise<T | Failed<T>> {
  try {
    return await work();
  } catch (err) {
    return { ran: false, error: name + ': ' + (errorMessage(err) || String(err)) } as Failed<T>;
  }
}

export async function runSchedule(env: Env, onPublish: (() => Promise<void>) | null | undefined, renderLive?: RenderPayload | null): Promise<ScheduleOut> {
  var out: ScheduleOut = {};

  // messages written ahead of time. The site polling still publishes
  // them the moment anyone loads a page — this is the floor under that,
  // for the hours when nobody is looking.
  out.published = (await attempt('publish', async function () {
    var n = await publishDue(env.DB);
    if (n && onPublish) await onPublish();
    return n;
  })) || 0;

  // quests with an opening time that has come
  out.opened = (await attempt('open', async function () {
    var n = await releaseDue(env.DB);
    if (n && onPublish) await onPublish();
    return n;
  })) || 0;

  // submissions queued past a team's cap, into the places review freed
  out.queue = (await attempt('queue', function () { return promoteQueued(env.DB); })) || 0;

  // the rest of an announcement that did not fit in one request
  out.push = await attempt('push', function () { return pushOutboxTick(env); });

  // the rest of an email announcement the Email tab was closed on
  out.announce = await attempt('announce', function () { return announceTick(env); });

  // tickets that never went out
  out.rego = await attempt('rego', function () { return regoRetryTick(env); });

  // a copy of the standings once an hour, when they have moved; it has
  // nothing public to purge
  if (renderLive) out.copy = await hourlyCopy(env.DB, renderLive);

  // each line's points against its quest's, once an hour
  out.ledger = await attempt('ledger', function () { return hourlyLedgerCheck(env.DB); });

  // dashboard files sent straight to R2 a day ago and never saved
  out.staged = (await attempt('staged', function () { return stagedSweep(env); })) || 0;

  return out;
}

// One line in the log, and only when something happened: a tick that
// found nothing to do writing a row every minute would bury the day's
// real entries within an hour. The actor is `schedule`, the same name
// a message that published itself already carries.
export async function logSchedule(db: D1Database, note: string): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      "VALUES ('scheduled-run', ?1, '-', 0, 0, 0, 'schedule')"
    ).bind(String(note).slice(0, 60)).run();
  } catch (err) { /* the work is done either way */ }
}

export function scheduleNote(out: ScheduleOut): string {
  var parts: string[] = [];
  if (out.published) parts.push(out.published + ' message' + (out.published === 1 ? '' : 's') + ' published');
  if (out.ledger && out.ledger.problems) parts.push('ledger check: ' + out.ledger.problems + ' to look at');
  if (out.opened && typeof out.opened === 'number') parts.push(out.opened + ' quest' + (out.opened === 1 ? '' : 's') + ' opened');
  if (out.queue && typeof out.queue === 'number') parts.push(out.queue + ' queued submission' + (out.queue === 1 ? '' : 's') + ' moved to review');
  if (out.push && out.push.ran) {
    parts.push('pushed ' + out.push.sent + (out.push.failed ? ' (' + out.push.failed + ' failed)' : '') +
      (out.push.done ? ', finished' : ', ' + out.push.remaining + ' to go'));
  }
  if (out.announce && out.announce.ran) {
    parts.push('emailed ' + out.announce.sent + (out.announce.failed ? ' (' + out.announce.failed + ' failed)' : '') +
      (out.announce.remaining ? ', ' + out.announce.remaining + ' to go' : ', finished'));
  }
  if (out.copy && out.copy.saved) parts.push('standings saved');
  if (out.staged && typeof out.staged === 'number') parts.push(out.staged + ' unsaved upload' + (out.staged === 1 ? '' : 's') + ' cleared');
  if (out.rego && out.rego.ran) {
    parts.push('retried ' + out.rego.tried + ' ticket' + (out.rego.tried === 1 ? '' : 's') +
      (out.rego.fixed ? ', ' + out.rego.fixed + ' sent' : ''));
  }
  [out.push, out.announce, out.rego, out.copy].forEach(function (r) { if (r && 'error' in r && r.error) parts.push(r.error); });
  return parts.join('; ');
}
