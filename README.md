# RL Overlay

A Rocket League overlay that runs next to the game instead of inside it. It reads
Psyonix's official [Stats API](https://www.rocketleague.com/developer/stats-api),
a local WebSocket the game opens itself, and draws a transparent, click-through,
always-on-top window over the screen. Nothing is injected and no game memory is read.

## Setup

On first launch a setup card finds Rocket League (Steam libraries via
`libraryfolders.vdf`, Epic via its launcher manifests, where the game is "Sugar"),
shows whether the Stats API is on, and turns it on with one click (backing up the file
and setting `PacketSendRate=30`). Epic installs under Program Files need admin rights,
so Windows asks first. The same status is in settings > General. Manually:

1. Enable the Stats API. In `<Rocket League>\TAGame\Config\DefaultStatsAPI.ini`
   (or `TAStatsAPI.ini` if that exists), set `PacketSendRate` above 0. 30 is plenty.
   Restart the game after editing.
2. Run Rocket League in **borderless windowed**. Nothing can draw over exclusive fullscreen.
3. Install the latest release from the repo's GitHub Releases page (it keeps itself up
   to date; see [Updates](#updates)), or `npm install`, then `npm run tauri dev`.

## Using it

The overlay stays empty while you play. When a match ends, a full match report
pops up and stays until the next match starts (or until the auto-hide time in
settings runs out).

- **Alt+Shift+D** shows or hides the compact HUD: a small panel with the stats you
  tick in settings (total boost used this session, boost per match and per minute,
  touch share, hit speeds, possession, kickoffs won, session record, and more). Stats
  are colour-coded by group (orange boost, yellow you, your team colour for the match,
  magenta session), with good and bad values in cyan and red. Arrange them how you like
  while settings are open: drag a stat onto an empty spot, onto another stat to put it
  beside that one (on whichever side you drop, pushing the rest of the row or column
  along), or just past an edge to start a new row or column. A yellow bar or outline
  shows where it will go. The yellow tab above the HUD moves the whole thing. Settings >
  HUD has two columns, one row, and one column ready-made, and the HUD's size.
- **Alt+Shift+S** shows or hides the report at any time. Mid-match it shows live
  numbers. Change the hotkey in settings; it is global, so pick something no other
  app needs.
- Both hotkeys can be changed in settings: click one and press the key or combination
  you want. A key like F2, Insert, or a numpad key works on its own; letters, numbers,
  Space and the like need Ctrl or Alt with them, since a hotkey takes its key from
  every other app (Rocket League's chat included) while the overlay runs.
- Speeds show in km/h or mph (settings > General).
- **Open and close with Rocket League** (settings > General) registers the app to
  start with Windows. It waits in the tray, opens the overlay when the game's window
  appears, and closes it (freeing the webview) once the game has gone; the tray icon
  stays for next time. An overlay you open yourself without the game stays open. Use
  this with the installed build (`npm run tauri build`): the dev build loads its page
  from the Vite dev server, which won't be running at sign-in.
- **Ctrl+Shift+O** opens settings (also in the tray menu), opening the overlay first
  if it's closed between games. While settings are open the overlay takes the mouse;
  otherwise clicks go straight through to the game.
- Set your in-game name so the overlay knows which player is you. Left empty, it
  follows whoever the camera is on.
- Quit from the tray icon or the settings panel.

### Organising the report

The match report is split into tabs, each a fixed-size page:

- **Overview:** your game (each stat with your place in the lobby), head to head, goals.
- **Players:** the full table, columns grouped into Ball, Shooting, Physical, Position.
- **Boost:** exact boost for everyone from the saved replay, or your screen estimate.
- **Goals:** large momentum chart, every goal, and where they went in.
- **Field:** touch map and each player's defence / midfield / attack split.
- **Consistency:** how your own play is changing across the session (see below).
- **Skills:** a skill radar built from your last 10, 25, or 50 matches (see below).

Settings (Ctrl+Shift+O) > Match report: tick the tabs you want, reorder them (the
first opens after each match), and pick the player-table columns.

Hold **Ctrl** to click the report; without Ctrl every click goes to the game behind
it (so Rocket League's post-match buttons always work). It never takes clicks during
a live round of a match (free play and training don't count). Clicks act on press,
so live updates can't swallow them. When settings or the tracker correction box
borrow keyboard focus, it goes back to the window that had it (usually Rocket League)
when you're done.

The overlay shows only while Rocket League is running, and hides while another app is
in front on its screen, coming back when Rocket League is. Apps on other monitors don't affect it. The game is recognised by
its window (Unreal's window class and the "Rocket League" title); the overlay never
opens the game's process.

### What the report shows

Only things the in-game scoreboard doesn't: no score, goals, assists, saves, or shots.

- **All matches:** the button at the top opens a list of your matches grouped by day
  (result, playlist, map, length, your touch share, top hit, boost used, whether a
  replay is saved). Click one to open its report; Back returns. The last 25 are kept.
- **Players:** click any player's name for their screen: your record with them as a
  teammate and as an opponent, their averages across your saved matches, and the
  matches you shared. Their RL Tracker profile (rank, MMR per playlist) is embedded
  on the right, as a webview inside the overlay window, and can also be popped out
  into its own window. Rocket League has no public rank API (RL Tracker's developer
  API doesn't cover it, and replays no longer carry rank), so the overlay shows their
  page rather than copying their numbers.

  Finding the right profile: Steam players go by Steam ID, everyone else by display
  name on their platform. The platform comes from the saved replay when there is one
  (most reliable), else the Stats API id; the game's codenames are understood (Dingo
  is Xbox, Orbis PlayStation, NNX Switch). If RL Tracker says "player not found", the
  embedded page tries the next platform on its own. Names like `User-1a2b3c4d5e` are
  anonymised by the game and can't be looked up. "Wrong profile?" under the page saves
  the right platform and name for that player.
- **Your highlights:** share of your team's touches, hardest hit, aerials, touches in attack.
- **Player breakdown:** touches, aerial touches, first to the ball at kickoff, bumps,
  demos inflicted and taken, shot %, average / top hit speed, hits over 100 km/h,
  and a defence / midfield / attack split of where each player touched the ball.
  Special stats from the stat feed (Epic Save, Aerial Goal...) and who left early.
  A gold ▲ marks first place in each column (the fewest for times demoed and time on
  empty boost), and every other column is shaded so a number is easy to follow up to
  its heading. Your game names who came first when it wasn't you.
- **Touch map:** every ball touch on a top-down field, yours outlined.
- **Momentum:** possession swing in 20-second slices with goals marked, plus where
  each goal crossed the line.
- **Goals:** clock, scorer, assist, ball speed, how long the play took from kickoff.
- **Head to head:** possession, touches in attack, touches, aerials, kickoffs won,
  hit speed, hard hits, bumps, demos, crossbars, ball speed.

Session W/L sits at the top right; the session and archive are kept between launches.

### Consistency

The Consistency tab looks for patterns in your own numbers across games. It doesn't
guess at how you feel. It only names a change when the gap is bigger than normal
game-to-game variation would explain (a 95% test, with a minimum number of plays behind
both sides), and it always shows the numbers and how many plays they rest on.

- **Last 4 games** of this session against earlier this session (once there are 4 earlier
  games), or else against your other games in the same playlists: 50/50s won, 50/50s lost
  in your own third, how long your team takes to win the ball back, shot accuracy, and
  where your touches were.
- **A short break could help:** when at least two of those dropped over your last 4 games,
  e.g. "Over the last 4 games, your 50/50 success fell from 58% to 33% and your team's time
  to win the ball back rose from 2.6 s to 4.4 s." The same note sits over the newest match
  report. Results alone never trigger it.
- **This session**, game by game, highlighting games with unusually many 50/50s lost in
  your own third, or unusually slow recoveries, against your usual.
- **After 2+ losses in a row:** the games that came straight after a losing run (in the
  same session) against all your others, on the same measures.
- **By session length:** games 1–3, 4–6, 7–9, and 10+ of a session, each against the rest.

What can be measured is limited by the Stats API, which reports who touched the ball and
where the ball was, but not where cars are:

- A **50/50** is both teams touching the ball within half a second; it's won when your team
  touches it next (or scores), and lost deep when lost with the ball in your third.
- **Positioning** is where your touches happened, by third of the field.
- **Winning the ball back** is the time from the other team taking the ball to your team
  touching it again (capped at 15 s; quick exchanges inside a 50/50 don't count).

50/50s and recoveries are tracked from this version on, so older matches only count
toward accuracy and positioning.

### Skills

The Skills tab draws a radar of six categories from your last 10, 25, or 50 online
matches (pick with the buttons; matches you left are skipped), with the window before it
drawn in grey for comparison. Each score is the share of the other players in those
lobbies you out-did on that measure, averaged over matches, so 50 is the middle of the
lobbies you play in and 100 means you led every one. Your team's measures are scored
against the other team.

| Category | Made up of | Source |
|---|---|---|
| Mechanics & recoveries | aerial touches / min, average hit speed, hard hits / min; your team's time to win the ball back | measured; the last is an estimate |
| Positioning & rotations | how close your share of team touches is to an even split; team possession | estimates |
| Challenge selection | 50/50s won, 50/50s lost in your own third | estimates |
| Boost efficiency | time on empty, boost used while already supersonic (from saved replays) | measured |
| Shooting accuracy | goals per shot | measured |
| Defensive consistency | saves / min, your team's saves over the other team's shots | measured |

**Measured** means counted by the game (scoreboard, touches, hit speeds) or read exactly
from a saved replay. **Estimates** (≈) are worked out from touch timing and ball
positions, since the Stats API doesn't report where cars are or when they recover; each
item's tooltip says what it stands in for. On the radar, measured categories have filled
points, estimated ones hollow points, and mixed ones half-filled. Each category also
shows how it moved against the window before (only when the change is bigger than
match-to-match variation, with at least 5 matches on each side) and a line of its score
over the window. Boost efficiency needs saved replays (auto-save in settings).

## Replays: exact boost and watching goals

Save a match's replay in Rocket League (end-of-match screen, or Replays > Match
History). The overlay watches `Documents\My Games\Rocket League\TAGame\Demos` and
links the replay to its match by the match GUID in the replay header. Then:

- **Exact boost for every player** (used, per minute, in the air, while supersonic,
  collected, big and small pads, stolen, average, time at 0 and 100), worked out from
  the replay with [subtr-actor](https://crates.io/crates/subtr-actor). It takes a few
  seconds and is cached. It replaces the screen reader's estimate in the report and in
  the session total, and the report shows how far off the estimate was.
- **Click a goal** on the momentum chart or in the goal list and the overlay tells the
  game to open the replay (`LoadReplay`) and jump to a few seconds before it
  (`SeekReplay`, using the goal frames from the header). The lead-in is in settings.

The replay camera switches to the scorer's own view (`ChangePOV` with their spectator
number from the replay). **Save each match's replay automatically** (settings > Boost and
replays, off by default) holds your Save Replay key (the game's `AutoSaveReplay` binding,
Backspace by default, read from `TAInput.ini`) during the first kickoff countdown, only
while Rocket League is the window in front. Held mid-match, the key marks the replay to save
itself when the match ends, so leaving the end screen straight away still keeps it. If the
game wasn't in front, the next kickoff tries again, then full time. Rocket League keeps
Match History replays in memory only, so there's no file for the overlay to pick up later.

While a replay plays, its events are kept out of match tracking and the session.
Matches without a match GUID (offline, some private matches) can't be linked.

`src-tauri/target/debug/rl-overlay.exe --replay-test <file.replay>` prints what the
overlay reads from a replay.

## Your MMR, and sharing it

Each time you queue, Rocket League writes the party leader's rating for that playlist
to its log (`Documents\My Games\Rocket League\TAGame\Logs\Launch.log`). The overlay
reads it (MMR = value × 20 + 100; matches RL Tracker within a game or two) when you
queue solo or lead the party (member 0, whoever made it; your id comes from the sign-in
line); in someone else's party the value is theirs, so it's skipped. The game's backup
logs are read at startup too, so earlier games today are filled in. The log's queue
times can be UTC or your PC's local time; the overlay tells which from the first queue
it sees as the game writes it (until then it assumes UTC), and lines readings up with
your matches on that clock.

Because it's logged as you queue, each reading is your MMR going into a match, and a
match's change is known once you queue again. If you play two matches without queuing in
between (staying in the lobby), neither gets a change rather than one getting both. The
overlay shows MMR next to your name in the report, the change per match there and in All
matches, the session's change per playlist in the report's top bar (first queue of the
session to the latest), and HUD stats for MMR, Last game MMR, and Session MMR. The last
match of a session has no change until your next queue; the report shows "MMR going in"
until then. Last game MMR skips matches with no MMR (private matches, training).

Saved matches need some play seen (a clock, a touch, or a goal). The end screen keeps
sending state with a winner after a match, which used to be saved as an extra "match"
holding the next match's id; those are dropped when the archive loads.

**Share my MMR with other overlay users** (settings > General, off by default)
reports your platform id, name, and MMR per playlist to the shared server in
`server/`, live at https://rl-overlay.gideon-buehler.workers.dev (used unless you set
your own). Other overlay users then see your MMR next to your name and on your player
screen, and you see theirs. "Delete my shared MMR" removes it from the server.

## Sessions

The session is worked out from your saved matches since it started, so it always agrees
with your match history. Leaving a match early counts as a loss (as Rocket League counts
it); private matches, offline exhibitions, training, and workshop maps don't count. A new
session starts when you reopen Rocket League (unless it's back within 5 minutes, as after a
crash or update), when you begin a match more than 2 hours after your last, or by hand with
Reset session. Game launches are watched for as long as the app runs and saved to
`game-run.json`, so restarting the overlay doesn't count as reopening the game. The last
100 matches are kept.

## Updates

Installed releases update themselves. Every push to `main` runs the Release workflow
(`.github/workflows/release.yml`), which tests, builds, and signs the installer and
publishes it as a GitHub release, versioned from `tauri.conf.json` with the run number
as the patch (0.1.1, 0.1.2, ...). The app looks for a newer release at startup and every
three hours, downloads it in the background, and installs it once Rocket League isn't
running, so a match is never cut short. It then restarts the way it was started (a
sign-in start goes back to waiting in the tray). Settings > General shows the version
and update status, with **Check for updates** to look now.

Only the workflow's builds update themselves; a build from `npm run tauri build` or
`tauri dev` doesn't, so it isn't replaced by the latest release. A build from before
updates existed needs the first release installed by hand.

Updates are signed, and the app only installs one signed with the key whose public half
is in `tauri.conf.json`. The workflow needs the private key and its password as
repository secrets, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
The app downloads releases without signing in to GitHub, so the repo has to be public.
Other branches run the Check workflow (tests and a Windows build) instead.

## Saved data

Settings, session, match history, and MMR history are files in
`%APPDATA%\com.gideo.rloverlay\store`, shared by the dev build, the installed build,
and updates. The first run with file storage copies over what the browser storage had.

## Boost tracking

The Stats API only sends boost to spectators, so while you play the overlay reads
your boost number off the screen instead, like a screen recorder would: it copies
the small area around the number about ten times a second and reads the digits.
Nothing touches the game process.

Set it up once: settings, **Mark boost meter**, drag the box over the number in the
middle of your boost meter (have free play or a match running), resize it from the
corner so it just fits the digits, and save. The readout shows what it sees live.

Windows' built-in OCR reads two- and three-digit numbers but often misses single
digits, so the reader also learns your HUD's digit shapes from the numbers OCR does
read, and matches those directly after that. Kickoff (33) teaches it 3 straight away;
every digit is usually learned within a match. If you change resolution or HUD scale,
use **Relearn digits**. Learned shapes are saved in the app's data folder.

The reader skips frames where OCR and the learned shapes disagree, leaves look-alike
digits unread rather than guessing, and the overlay takes the median of the last
three readings, so one-frame misreads don't count as boost used or collected.
Settings > Boost and replays can log every reading to `boost-log.csv` in the app's
data folder for checking.

From the readings it tracks boost used, collected, boost per minute, average boost,
and time spent at 0 and at 100. Kickoffs and respawns after a demo reset the meter
without counting as boost collected, and readings the game couldn't produce (a
jump of 36 in a tenth of a second) need a second matching reading first. When you
spectate or watch a replay, the API's exact boost values are used instead.

Tuning without the game:
`src-tauri/target/debug/rl-overlay.exe --ocr-test <image> <x> <y> <w> <h> [...]`
runs the reader over crops of an image, sharing what it learns between them.

## Working without the game

```
npm run mock              # fake 2v2 matches over a WebSocket
npm run dev               # overlay in a browser at http://localhost:1430
```

Mock options: `--port`, `--length` (match seconds), `--post` (seconds between the end
of a match and the next one), `--rate`, `--spectate`. The first match waits for a client to connect. Run it on its own port while
Rocket League is open, e.g. `node mock/server.mjs --port 49200`, and open
`http://localhost:1430/?port=49200`. Other URL options: `?report` shows the report,
`?edit` opens settings.

## OBS

The overlay is a plain web page, so it also works as an OBS browser source:
`npm run build`, then point the source at `dist/index.html`, or at the dev server.

## To verify against the real game

- **Saving the replay mid-match.** Holding Save Replay at the first kickoff should mark the
  replay to save at full time, even if you leave the end screen at once.
- **Scorer's view on goal clicks** (`ChangePOV`), and the **admin prompt** first-run setup
  uses for Epic installs under Program Files.
- **Who "you" are without a name set.** Assumes the camera target is you while playing.
- **Bumps.** Uses the API's `CarTouches` ("touches by the car body"), assumed to mean car-to-car contact.
- **Aerial threshold.** A touch counts as aerial with the ball centre above 300 uu (about 3 m).
- **Boost reader capture.** Uses GDI screen capture, which sees borderless windowed games
  composited by Windows. If the readout stays at "no digits in view" with the meter on
  screen, capture isn't seeing the game.
- **Anti-cheat.** The Stats API is official, but test one online match before relying on it.

## Building

`npm run tauri build` makes an installer in `src-tauri/target/release/bundle/nsis`
(one that doesn't update itself; releases come from the Release workflow).
`.cargo/config.toml` caps cargo at 6 jobs: on this machine, rustc crashes with
random access violations under all-core load, most likely CPU instability (an i9-13900K
on an old BIOS) rather than a bug in the code.

## Tests

```
npm test                          # session and match tracking (Vitest)
cd src-tauri && cargo test        # setup, game launches, boost reader, replays
```

The TypeScript tests cover the rules that have broken before: which matches count toward
the session, leaving counting as a loss, streaks, exact versus estimated boost, when a new
session starts, and one goal per kickoff despite the game's duplicate GoalScored.

## Layout

```
src/feed.ts       WebSocket connection, message splitting, unit conversion
src/match.ts      builds a full match record from the event stream
src/report.ts     renders the match report; section and column catalogues
src/names.ts      playlist, arena, and platform names
src/session.ts    session (worked out from the archive), settings, saved data
src/consistency.ts  trends in your own play across games and sessions
src/skills.ts     skill radar scores, each against the rest of the lobby
src/*.test.ts     Vitest tests (session, match tracking, consistency, skills, HUD, hotkeys, MMR)
src/hud.ts        compact HUD and its stat catalogue
src/boost.ts      boost used/collected from readings
src/mmr.ts        your MMR history and the shared MMR client
src/main.ts       match flow, show/hide logic, calibration, settings panel
src/style.css     overlay styles: a Cyberpunk-style neon look, colours and shapes as tokens at the top
src-tauri/        transparent click-through window, global hotkeys, tray
src-tauri/src/boost.rs    screen capture, OCR, and learned digit shapes for the boost meter
src-tauri/src/store.rs    saved data as files, shared by every build
src-tauri/src/mmr.rs      reads your MMR from the game log
src-tauri/src/autorun.rs  start with Windows, open and close with the game
src-tauri/src/gamerun.rs  game launches (5-minute grace), for sessions
src-tauri/src/focus.rs    click zones (Ctrl), foreground tracking, focus hand-back
src-tauri/src/replays.rs  finds saved replays, reads goal frames, exact boost via subtr-actor
src-tauri/src/setup.rs    first-run setup: finds the game, turns the Stats API on
src-tauri/src/update.rs   installs new releases from GitHub, once the game is closed
.github/workflows/  Release (every push to main) and Check (other branches)
mock/server.mjs   fake Stats API feed, no dependencies
server/           shared MMR service (Cloudflare Worker + D1)
```
