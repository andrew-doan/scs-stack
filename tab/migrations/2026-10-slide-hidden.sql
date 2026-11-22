-- A home page picture kept on the dashboard and left out of the slideshow.
ALTER TABLE home_slides ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
