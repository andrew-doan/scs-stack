# The video encoder

Teams upload proof videos straight off their phones, which means
minute-long 4K clips of tens of megabytes. Playing those back in the
Review tab, the gallery and the closing-night slideshow is slow, and
on a venue connection it can be worse than slow.

Cloudflare Workers cannot run ffmpeg, so the encoding happens on
ordinary computers. The encoder asks the worker for a video, downloads
it, makes 480p, 720p and 1080p copies with ffmpeg and sends the copies
back. The site then asks for the size it wants and gets it.

Nothing on the site depends on this running. Without it every video
serves at its original size, exactly as before.

Videos added to an album on the site's Albums page come through the
same queue, after the proof videos. An album video is only shown on the
site once the encoder has made its copies, so with nobody running it
those stay off the album.

Run it on as many computers as you like. Each one takes a single video
at a time and comes back for another when it is done, so the faster
machines end up doing more without anyone having to divide the work
up.

## Nothing to install

Take two files from `tab/scripts`:

- `encoder.mjs` — the encoder itself
- `scs-encoder.command` (Mac) or `scs-encoder.cmd` (Windows) — the
  thing you double-click

Keep them in the same folder. The launcher downloads Node and ffmpeg
into a folder of its own the first time (`~/.scs2-encoder` on a Mac,
`%USERPROFILE%\.scs2-encoder` on Windows) if the computer does not
already have them. Nothing is installed system-wide, nothing needs an
administrator, and deleting that folder undoes it.

### On a Mac

Double-click **scs-encoder.command**.

macOS will refuse to open a file downloaded from the internet the
first time: right-click it, choose Open, then Open again in the box
that appears. After that a double-click works.

### On Windows

Double-click **scs-encoder.cmd**.

If SmartScreen puts up a blue box, choose More info, then Run anyway.

This launcher is for 64-bit Intel and AMD machines. On Windows on ARM,
install [Node](https://nodejs.org) and
[ffmpeg](https://ffmpeg.org/download.html) yourself and run
`node encoder.mjs` (see "Running it by hand" below).

### The two questions

The first time it runs it asks for two things:

- **The worker address.** Press return to accept
  `https://files.scs.andyrew.space`.
- **The encoder key.** This is the worker's `ENCODER_KEY` secret — the
  same value that is in `secrets.json` and was uploaded by
  `npm run secrets`. Ask the tab team for it; they should send it
  privately, not in a channel.

Both are kept in `.scs2-encoder` on that computer and reused after
that: the address in `address`, the key in `key`, each file holding
that one value and nothing else. To change either, run the launcher
with `--reconfigure` (on Windows you can also set `RECONFIGURE=1`
first). Double-clicking cannot pass a flag, so open Terminal and run
the launcher's path with `--reconfigure` after it — or delete
`.scs2-encoder/key` and double-click as normal, which asks the two
questions again.

The key can contain any punctuation. Launchers before this version
wrote both answers into a single `config` file that the launcher
parsed on the next run, and that parse lost characters: on Windows an
`&`, `|`, `<`, `>` or `^` in the key, on a Mac a `'`. The key worked in
the run that typed it and every run after that was turned away with
`not allowed`. The launcher deletes an old `config` and asks the two
questions once more, and from now on it reads both values back off
disk in the same run that wrote them, so a key that did not save says
so straight away.

**Changing the key is two jobs, not one.** The worker has to be told
(`ENCODER_KEY` in the tab bot's `secrets.json`, then `npm run
secrets` — which uploads every secret in that file, so make sure the
rest of it is current first) and **every computer that has already run
the launcher** has to be reconfigured, since each kept its own copy.
A machine still holding the old key is turned away with a message
naming `ENCODER_KEY`, so it is loud rather than silent.

Do not paste the key into a file in this repo, and do not put it in a
script that ends up committed.

If `ENCODER_KEY` has never been set on the worker, put a long random
string in `secrets.json` and run `npm run secrets`. Until it is set,
the encoder endpoints answer 503 and say so.

## What happens when it starts

It says what it found, and asks whether to get going:

```
09:14:02  Encoder "studio-mac" starting. Worker: https://files.scs.andyrew.space
09:14:03  6 videos are waiting for encoding (about 380 MB).
Encode them? [Y/n]
```

Press return for yes. Then one line per event and nothing else:

```
09:14:05  Claimed roof shot.mov (58.4 MB)
09:14:20    cleaned in 4s, 41.8 MB
09:14:37    encoded 480p in 12s, 6.1 MB
09:14:38    uploaded 480p
09:15:24    encoded 720p in 24s, 14.2 MB
09:15:26    uploaded 720p
09:16:51    encoded 1080p in 51s, 31.7 MB
09:16:54    uploaded 1080p
09:16:54  Done in 169s: 480p, 720p, 1080p
```

With nothing waiting it says so and keeps watching, which is the
normal way to leave it running through the day.

Leave the window open. It asks for more work every ten seconds. Ctrl+C
stops it after the video it is on; a second Ctrl+C stops it
immediately.

Plug the laptop in. Encoding is the whole processor for as long as it
runs, and a computer that goes to sleep stops encoding.

## What it makes

**A clean copy first.** Phones write the location into every video,
and the site never hands out the file a phone made — so before any
encoding, the runner repackages the video with the metadata dropped
(`-c copy`, which does not touch a single frame: no quality lost, and
seconds rather than minutes whatever the size). That copy is what the
site shows at Original. Until it exists the video is not viewable
outside the dashboard, so it is worth running the encoder over the
day's videos even if nobody needs the smaller sizes.

Then one copy at each of 480p, 720p and 1080p, but never larger than
the source: a 720p original gets 480p and 720p copies and nothing else. A
video smaller than 480p gets a single copy at its own height —
re-encoding still normalises the bitrate and moves the index to the
front of the file, so it starts playing sooner.

Each copy is H.264 at CRF 23, `-preset veryfast`, AAC audio at 128k,
with faststart, and `-map_metadata -1` so it carries none of the
source's location either — ffmpeg copies that across by default.

**HDR becomes SDR in the copies.** iPhones film HDR (HLG) by default.
A copy of one made the plain way keeps the HDR colour tags on 8-bit
video, which looks washed out and makes Firefox on a Mac flicker. The
runner reads the source's colour transfer, and for HLG or PQ it
tone-maps the copies to ordinary SDR (BT.709) through ffmpeg's
`zscale` and `tonemap` filters. The log says
`HDR video (arib-std-b67): the copies are converted to SDR`. An ffmpeg
built without zimg has no `zscale`; then the copies are made as
before and the log says so. The clean copy is a repackage and stays
HDR.

**Every copy is measured before it is sent.** A phone films in
landscape whichever way you hold it and writes the turn into the file
rather than rotating the frames, so a step that drops the wrong thing
produces video that plays on its side. The runner probes the source and
each copy it makes: a clean copy has to keep the turn, and a re-encode
has to have baked it into the frames. One that comes out the wrong
shape is left out with a line saying so, rather than uploaded. You
should never see those lines; if you do, say which ffmpeg version the
machine has. A smaller copy that comes out over 90MB is encoded again
at CRF 28, since the point of it is that it is smaller; whatever comes
out of that is sent.

**A still for a video that has none.** The page that sends a video
takes a frame from it for the grid, and a browser that cannot decode
the video (an iPhone's HEVC in Firefox, a long video that takes too
long to open) sends it without one, which left a blank tile. Last of
all the runner takes a frame from the smallest copy it made, a second
in, 480px on the long edge, and sends it; the worker keeps it only
where there is no still already. A video it could not make one for has
"no still" in its note on the dashboard.

**Size is not a limit.** One request to a Cloudflare Worker carries
about 90MB, and a long video's clean copy is the source repackaged, so
it is the source's size. Anything over that goes up in 20MB slices,
which R2 stitches together itself — the same way the video reached the
bucket from the phone. The log says so:

```
09:22:10    412.6 MB — sending it in 21 slices
09:22:31    slice 1 of 21 sent
```

A slice that does not land is tried twice more before the runner gives
up on that copy, so one bad moment on a venue connection costs a slice
rather than a whole video. Giving up part-way tells the worker, which
clears the slices already sent.

**With the R2 token set on the worker** (the `R2_…` secrets in
README.md, Uploads straight to R2), no video passes through the worker
at all. The runner reads the original from R2 at an address the worker
signs for it, and sends every copy back to R2 in 20MB slices, whatever
its size, each to an address the worker signs for that slice; at the
end the worker has R2 join them. The computer running the encoder then
has to be able to reach `<account id>.r2.cloudflarestorage.com` as well
as the worker. Without the token, everything goes through the worker as
above.

Temporary files go in the system temp folder and are deleted after
each video, whether it worked or not.

## What the dashboard shows

The Review tab has an encoder box at the top. Above it, how many
videos are waiting, being encoded and done. Under that, one line per
machine that has ever called in:

```
3 waiting · 1 encoding · 12 done

studio-mac       Online — encoding roof shot.mov   9 videos done · about 41s per video
kitchen-laptop   Online — idle                     0 videos done
bens-mbp         Offline — last seen 2:41 AM       3 videos done · about 2m 34s per video
```

A machine counts as online if it has called in within the last 45
seconds. The pace is that machine's own average over the videos it has
finished, which is the honest way to see which computers are worth
using.

In the submission cards, a video being encoded carries an **Encoding**
tag, and a video with copies lists the sizes it has (`480p · 720p`).

The box refreshes when the Review tab opens and on either Refresh
button. Nothing polls.

## If a computer goes offline

Nothing breaks. Videos that have copies keep serving them; videos that
do not serve their originals, which is what happened before any of
this existed. The dashboard says that machine is offline, and any
video it had in hand is offered to another machine 15 minutes later.

## Running it again is safe

Start it as often as you like, on as many computers as you like.

- A video that has been finished is never offered again.
- Two machines that ask for the same video at the same moment cannot
  both get it: the one whose claim lands first has it and the other is
  told to ask again. That is the whole of how the work is shared out.
- A video claimed by a machine that then disappeared is offered again
  15 minutes after the claim, so nothing stays stuck.
- Sending a size that has already been sent replaces it — the old row
  and the old file both go, even when two machines send the same size
  at once.
- A machine whose claim ran out and that finishes with nothing made
  leaves the video as it is: done if another machine finished it, still
  claimed if another machine has it now.

## If the automatic downloads are blocked

Some networks block the download sites. Install the two tools by hand
and the launcher will use them instead:

- Mac: `brew install ffmpeg` (Node from nodejs.org, or
  `brew install node`)
- Windows: `winget install ffmpeg` (Node from nodejs.org, or
  `winget install OpenJS.NodeJS.LTS`)

## Running it by hand

The launcher is only a convenience. With Node 18+ and ffmpeg already
on the PATH:

```
node scripts/encoder.mjs --api https://files.scs.andyrew.space --key <the key>
```

`TAB_API` and `ENCODER_KEY` work as environment variables instead.
`--name` sets what this machine calls itself on the dashboard (it uses
the computer's own name otherwise), `--yes` skips the question at
startup, and `FFMPEG` and `FFPROBE` point at ffmpeg binaries that are
not on the PATH.

## The endpoints it uses

All under `/api/encoder/`, all needing
`Authorization: Bearer <ENCODER_KEY>` and the name of the machine
making the call. They are not called from a browser and carry no CORS
headers, and the tab freeze does not reach them.

| Call | What it does |
| --- | --- |
| `POST poll` | Says what this machine is doing and gets up to 5 videos it could take, plus how many are waiting altogether. |
| `GET source?key=` | The video as the phone sent it. Nothing public can reach an original, and this is the machine that makes the copy everyone else is served. With `&signed=1` and the R2 token set, an address to read it from R2 instead. |
| `POST claim` | Takes one video, and answers `claimed_at`, the time of the claim. Answers 409 if another machine got there first. |
| `PUT rendition?key=&height=&name=` | One finished copy, as the request body. Answers 413 if it will not fit in one request. |
| `POST upload/start` | A copy sent in slices: says where it goes, how big a slice is and how many to send, and `direct: true` when the slices go straight to R2. |
| `GET upload/sign?upload=&stored=&n=&name=` | For a copy going straight to R2, the address one slice is sent to, good for 15 minutes. |
| `PUT upload/part?upload=&stored=&n=&bytes=&name=` | One slice, as the request body, for a copy going through the worker. Answers with the tag to send back. |
| `POST upload/finish` | Every slice and its tag, for R2 to stitch into one object. For a copy sent straight to R2, the size of the whole copy instead, and the worker asks R2 which slices arrived. |
| `POST upload/abort` | This machine gave up part-way; throw the slices away. |
| `PUT still?key=&name=` | A JPEG of one frame (480px on the long edge, at most 300KB) for the video's tile. Kept only where the video has none: a still the page made at upload stays. |
| `POST finish` | This machine is done with that video, with or without copies, how long it took, and the `claimed_at` its claim answered. A finish with no copies only counts while that claim still holds the video, so a machine whose claim ran out cannot undo another machine's work; it answers `kept: true` when it changed nothing. |

The site asks for a size with `&res=480`, `&res=720`, `&res=1080` or
`&res=original` on `/api/submit/file?key=`. If that exact size is not
there the worker serves the largest one below it, then the smallest
one above it, then the original — so the parameter is always safe to
send.

Tests: `node tests/verify-encoder.mjs`.
