# The routes teams recorded

One of the quests asked teams to record their day on Strava or any other
GPS app and send OrgCom the GPX file. This folder turns a folder of those
files into cleaned GPX files for the organisers. The routes the replay
draws (`website/tab/replay/`, written up in
`website/tab/CLAUDE.md`) are cleaned and saved one at a time on the
dashboard's Routes tab (`tab/CLAUDE.md`), with the same cleaner. Not
published: Netlify publishes `website/` only.

```
clean.mjs    a folder of GPX in, cleaned GPX and a report out: the files
             and folders around the cleaner
teams.json   which team each GPX file belongs to, by file name (kept out of the repo: make your own)
```

**The cleaning itself is `website/tab/replay/track-clean.js`**, one
ES5 file that Node loads (`createRequire`, it exports with
`module.exports`) and a browser loads as a script (`window.SCSTrackClean`),
so the command here and the dashboard's Routes tab clean a track the same
way. It takes everything as data: `network(geojson)`, `trips(files)`,
`readGpx(text)`, `clean(net, points, {trips, log})`, `toGpx`, `toReplay`.
It is served with the site for the dashboard to load, and no page of the
site loads it, so it is not precached (`NOT_PRECACHED` in
`tab/scripts/check-rules.mjs`). A change to what `toReplay` writes has to
still pass `checkRoute` in `tab/src/tracks.ts`, which `verify-tracks.mjs`
holds.

## Running it

```
node tracks/clean.mjs tracks/gpx --times tracks/stringlines
```

- `tracks/gpx/` is the folder of GPX files as teams sent them. **They
  stay out of the repo** (`.gitignore`): a recording can start or end at
  someone's home, and only the cleaned copies inside the day are needed.
- Cleaned GPX files go to `<input>/cleaned/` (or `--out <folder>`), one
  `<name> (cleaned).gpx` each, with `report.txt` saying what was done to
  each file: spikes and filler dropped, each ride and the stations it ran
  between, how long the team waited on the platform, and which rides were
  filled in underground.
- `--times <folder>` is optional and makes the underground rides follow
  the train that actually ran (below). Without it they run at a typical
  speed.

## teams.json

`{"<file name>": {"team": "<the team's name on the tab>"}}`. The name
goes inside the cleaned file and the report; a file with no team keeps
the name it had. Files sent without a team in their name (Strava's
"Morning Walk") need someone to say whose they are, and on the Routes tab
that is the team picked for it.

## What the cleaner does

In order, per file:

1. **Drops what is outside the day** (09:00 to 18:30 Sydney time).
2. **Drops spikes**: a point, or a run of points, that jumps away faster
   than 40 m/s and comes straight back within two minutes.
3. **Drops filler**: some apps fill a tunnel with points on a straight
   line at one exact speed. Three or more steps at the same speed (within
   1.5%) and bearing (within 4 degrees), sparse, over at least two minutes
   and 800 m, are not fixes and would be read as a route.
4. **Finds the rides**: a stretch faster than anyone runs (5.5 m/s over
   half a minute, never measured across a gap) or a jump of 400 m with no
   fixes between, merged with the next one when they are under 200
   seconds apart, so a train standing at a station is one ride.
5. **Matches each ride to the rail network** built from the lines in
   `website/assets/transit.geojson` (train, metro and light rail; pieces
   joined where they stop short of each other, each station a place to
   change). The route between the ride's ends is the cheapest path where
   track far from the ride's fixes costs three times its length, so the
   path follows the fixes; with no fixes (a tunnel) it is the shortest,
   leaning towards the metro. A ride is redrawn only when 75% of its fixes
   sit on that route (150 m for train and metro, 70 m for light rail) and
   it went at train speed somewhere on it; a bus, a bike or a car fails
   that and is left as recorded. When a ride with jumps in it fails, it
   is tried again with its ends alone: those fixes were the phone network
   guessing, not GPS.
6. **Times the ride**: from the fixes on it where there are any, keeping
   only those a vehicle could join up (no faster than the mode's top
   speed). Through a tunnel the team walks in, waits on the platform and
   rides, arriving when the GPS picked it up again. The ride is the
   recorded trip when there is one, otherwise a typical speed between
   stations and a stop at each (train 15 m/s and 40 s, metro 17 m/s and
   35 s, light rail 6.5 m/s and 25 s: Chatswood to Central comes out at
   15 minutes, as the timetable has it). When the last fix before the
   tunnel leaves too little time, the fixes before it that stayed within
   180 m (a phone underground keeps reporting the platform) are taken as
   the team waiting there.
7. **Squashes stops**: 3 minutes or more within 60 m becomes one point
   at its middle, held for as long as the team stayed.

The replay's copy (`toReplay`, what the Routes tab saves) is simplified
to within 4 m at the right time (about 10 KB a team) and records the rides (`legs`, one per run on one mode
with the stations it ran between, so a light rail ride and the train
after it are named for what each was; `filled: 1` on one drawn
underground with no fixes, which the map dashes) and the stops of five
minutes or more (`stays`).

**The network's gaps are filled by hand** at the top of `track-clean.js`: the
transit file has no point for Central's train station (only the light
rail stop), and draws the stations the metro shares with Sydney Trains as
train stations alone (`EXTRA_STATIONS`, `METRO_AT_TRAIN`).

## Recorded trips (`--times`)

TransportSeek's string-line history for the day, one JSON file a line
(`stops` with each station's km along the line, `trips` with recorded
`points` as `[epoch, km]`):

```
for l in M1 T1 T2 T3 T4 T8 T9 L2 L3; do curl -s "https://transportseek.andyrew.space/api/history/stringline?line=$l&date=2026-10-20" -o "tracks/stringlines/$l.json"; done
```

Not in the repo (it is 7 MB of someone else's data, and `.gitignore`
keeps `tracks/stringlines/` out). The Routes tab's **Recorded trips**
takes the same files. For a tunnel ride the cleaner tries
the stations near where the team was last seen against those near where
it was seen again, nearest first, and takes the recorded trip of the
same mode that left after the team could have reached the platform and
arrived latest before the GPS came back. The trip's positions are put on
the route station by station, so the two drawings of the line need not
agree on its length. A trip whose two crossings come from one long gap in
the feed (faster than 30 m/s between the stations) is not used.
