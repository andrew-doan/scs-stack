// Who can see a quest. One answer, asked by every reader that hands a
// quest to someone: the quest list (public and per team), the question
// a quest asks, the submit form and the tab's public stats.
//
// A quest (a quest_groups row) is seen by:
//   hidden = 1                 organisers only, whatever else it says
//   visibility 'everyone'      anyone, signed in or not
//   visibility 'teams'         any team signed in with its submit code
//   visibility 'groups'        teams in one of the team groups linked to
//                              it in quest_audiences
// A code with no quest above it (an old loose code) is everyone's.
//
// Every reader here treats a row with no visibility as 'everyone'.
//
// A message has the same four audiences (a draft is its organisers
// only). Messages are read as a list with a limit, so that rule is
// written once more below as SQL rather than asked of each row after.

import type { AudienceTeamRow, Viewer } from './types.ts';

// What a reader asks of a quest: hidden and visibility from its row,
// and the team groups it is shown to where they decide it.
export interface Seeable {
  hidden?: number | boolean | null;
  visibility?: string | null;
  audiences?: number[];
}

export var VISIBILITIES = ['everyone', 'teams', 'groups'];

// The team groups a team is in, as a set of ids. null for nobody
// signed in.
export async function viewerFor(db: D1Database, teamId: number | null | undefined): Promise<Viewer> {
  if (!teamId) return null;
  var ids: Record<number, boolean> = {};
  var rows = (await db.prepare('SELECT audience_id FROM audience_teams WHERE team_id = ?1').bind(teamId).all<Pick<AudienceTeamRow, 'audience_id'>>()).results;
  rows.forEach(function (r) { ids[r.audience_id] = true; });
  return { team_id: teamId, audiences: ids };
}

// g carries hidden, visibility and, for 'groups', audiences (ids).
export function canSee(g: Seeable | null | undefined, viewer: Viewer): boolean {
  if (!g) return true;
  if (g.hidden) return false;
  var v = g.visibility || 'everyone';
  if (v === 'everyone') return true;
  if (!viewer) return false;
  if (v === 'teams') return true;
  if (v === 'groups') {
    return (g.audiences || []).some(function (id) { return !!viewer.audiences[id]; });
  }
  return false;
}

// The same question for one row read on its own (the ask endpoints, the
// submit form): the team groups are looked up only when they decide it.
export async function rowVisibleTo(db: D1Database, row: (Seeable & { id: number }) | null | undefined, teamId: number | null | undefined): Promise<boolean> {
  if (!row) return false;
  if (row.hidden) return false;
  var v = row.visibility || 'everyone';
  if (v === 'everyone') return true;
  if (!teamId) return false;
  if (v === 'teams') return true;
  if (v !== 'groups') return false;
  var hit = await db.prepare(
    'SELECT 1 AS ok FROM quest_audiences qa JOIN audience_teams at ON at.audience_id = qa.audience_id ' +
    'WHERE qa.group_id = ?1 AND at.team_id = ?2 LIMIT 1'
  ).bind(row.id, teamId).first();
  return !!hit;
}

// canSee for messages m, as a condition to AND onto a query that
// already leaves drafts out. The team's id is ?1 when the viewer is a
// team, and nothing is bound when it is nobody signed in.
export function messageSeenSql(viewer: Viewer): string {
  if (!viewer) return "m.visibility = 'everyone'";
  return "(m.visibility IN ('everyone', 'teams') OR (m.visibility = 'groups' AND EXISTS (" +
    'SELECT 1 FROM message_audiences ma JOIN audience_teams at ON at.audience_id = ma.audience_id ' +
    'WHERE ma.message_id = m.id AND at.team_id = ?1)))';
}
