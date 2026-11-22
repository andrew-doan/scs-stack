-- Where a deleted quest's things go (src/deleted.ts). Its submissions,
-- its voided lines and its voided awards move to the loose code DELETED,
-- each keeping the code it came from in deleted_from, so a new quest given
-- one of its codes starts with nothing. Its files stay, with its key in
-- quest_files.deleted_key. '' is a row that has not moved. Each ALTER
-- fails harmlessly once its column is there.
ALTER TABLE submissions ADD COLUMN deleted_from TEXT NOT NULL DEFAULT '';
ALTER TABLE entries ADD COLUMN deleted_from TEXT NOT NULL DEFAULT '';
ALTER TABLE awards ADD COLUMN deleted_from TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_files ADD COLUMN deleted_key TEXT NOT NULL DEFAULT '';
