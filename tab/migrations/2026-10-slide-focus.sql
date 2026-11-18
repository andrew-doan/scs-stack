-- The point each home page picture is cropped around, in percent across
-- and down. 50, 50 is the middle, which is what every picture was before.
ALTER TABLE home_slides ADD COLUMN focus_x INTEGER NOT NULL DEFAULT 50;
ALTER TABLE home_slides ADD COLUMN focus_y INTEGER NOT NULL DEFAULT 50;
