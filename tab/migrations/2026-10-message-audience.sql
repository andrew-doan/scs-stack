-- Who can read a message: the same audiences a quest has.
--
-- visibility: everyone, teams (any team signed in with its submit code)
-- or groups (the team groups in message_audiences). hidden = 1 is still
-- a draft, which is organisers only.
--
-- seq is the messages counter's value when a message went up. The pulse
-- answers each reader with the newest seq among the messages they can
-- see, so a message for some teams does not light everybody's bell.
--
-- push_outbox.team_ids holds the teams the rest of a push is for, when
-- it is not for every device.
--
-- schema.sql has all of this on a fresh database. The ALTERs fail once
-- they are there, which is the signal they have already run.
ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_outbox ADD COLUMN team_ids TEXT;

CREATE TABLE IF NOT EXISTS message_audiences (
  message_id  INTEGER NOT NULL,
  audience_id INTEGER NOT NULL,
  PRIMARY KEY (message_id, audience_id)
);

-- (site_flags comes from 2026-10-recap.sql; repeated here so this file
-- does not depend on the order the two are read in.)
CREATE TABLE IF NOT EXISTS site_flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- The messages already up get the counter's recent values, newest
-- first, so a device that had not read the last few still sees its dot.
-- Once only: on a rerun a message since edited from silent to normal
-- would be given a number it never moved. The site_flags row written
-- last is what says it has been done.
UPDATE messages SET seq = MAX(1,
    COALESCE((SELECT value FROM counters WHERE name = 'messages'), 0) -
    (SELECT COUNT(*) FROM messages m2
      WHERE m2.id > messages.id AND m2.hidden = 0 AND m2.archived = 0 AND m2.urgency != 'silent'))
  WHERE hidden = 0 AND archived = 0 AND urgency != 'silent'
    AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'message_seq_seeded');
INSERT OR IGNORE INTO site_flags (name, value) VALUES ('message_seq_seeded', 1);
