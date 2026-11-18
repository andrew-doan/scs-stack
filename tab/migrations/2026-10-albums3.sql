-- Albums, third part (see schema.sql). Named to sort after
-- 2026-10-albums2.sql. An album that shows what hidden teams add, which
-- every other public read leaves out. The ALTER fails harmlessly once
-- the column is there.
ALTER TABLE albums ADD COLUMN show_hidden INTEGER NOT NULL DEFAULT 0;
