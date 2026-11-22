-- A team's id is never given to another team. teams.id is a plain
-- INTEGER PRIMARY KEY, so deleting the newest team freed its id and the
-- next team made took it, along with every row still keyed by it: the
-- deleted team's people, Discord role and channel, team groups, answers
-- and linked phones. The worker now keeps the highest id a team has had
-- in site_flags (team_id_high), raised by every delete, and gives each
-- new team one past it. This seeds it from every table that can still
-- hold a deleted team's id, so an id already left behind is not reused.
INSERT OR IGNORE INTO site_flags (name, value) VALUES ('team_id_high', 0);
UPDATE site_flags SET value = MAX(value,
  COALESCE((SELECT MAX(id) FROM teams), 0),
  COALESCE((SELECT MAX(team_id) FROM participants), 0),
  COALESCE((SELECT MAX(team_id) FROM registrations), 0),
  COALESCE((SELECT MAX(team_id) FROM discord_teams), 0),
  COALESCE((SELECT MAX(team_id) FROM discord_members), 0),
  COALESCE((SELECT MAX(team_id) FROM audience_teams), 0),
  COALESCE((SELECT MAX(team_id) FROM quest_responses), 0),
  COALESCE((SELECT MAX(team_id) FROM push_subs), 0),
  COALESCE((SELECT MAX(team_id) FROM album_photos), 0),
  COALESCE((SELECT MAX(team_id) FROM email_sends), 0)
) WHERE name = 'team_id_high';
