# Boat Race Tracker

Race management for sailing clubs: live boat tracking over Meshtastic LoRa radios and phones,
start sequences with recalls, finishes, and IRC, ORC and Portsmouth scoring, with a live view for
spectators.

This is a rebuild of [TMTRAC](https://github.com/feelgoodinc183/tmtrac) around one idea: **the
server runs the race**. Phones and laptops send commands ("start Class 1", "finish MAS 33") and
show what the server sends back. The plan, scope and phases are in [docs/PLAN.md](docs/PLAN.md).

## Packages

| Package | What it is | Status |
|---|---|---|
| [`packages/engine`](packages/engine) | Racing rules as pure functions: start sequence, AP, general and individual recall, finishes, penalty codes, corrected time, race and series scoring (RRS Appendix A) | Phase 1 done; GPS suggestions (4a), with tests |
| [`packages/server`](packages/server) | Node server: runs the engine, stores every event in SQLite, keeps devices in step over WebSocket | Phase 2: done, with tests |
| [`packages/app`](packages/app) | React app for the race office (start, finishes, map, results, setup) and for skippers (live, track, results) and spectators (live map, results). Works offline: commands and positions wait on the device and go when the connection is back | Phases 3–4b: website, tracking, Meshtastic radios over Bluetooth, and the Android app (Capacitor), with tests |

## Develop

Needs Node 22.13 or later.

```sh
npm install
npm test          # all packages
npm run typecheck
npm run build     # the app, into packages/app/dist
```

While working on the screens, run the server (below) and `npm run dev -w @brt/app`. Vite serves the
app on port 5173 and passes `/api` and `/ws` to the server on port 3000.

## Run the server

```sh
npm run build
ADMIN_TOKEN=<at least 16 characters> DATA_DIR=./data npm start
# create a regatta (returns its code and the race officer and skipper PINs)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Club Race"}' localhost:3000/api/regattas
```

The server serves the app at `/`. Open it, enter the regatta code, and enter the race officer PIN
to run the race. Spectators need only the code, or the link from the Setup tab
(`/?r=<code>`). The race office sees the skipper PIN on the Setup tab.

Devices connect to `ws://host/ws` and send `{"t":"hello","regattaId":"<code>","pin":"<PIN>"}`.
The PIN decides the role: race officer (commands), skipper or spectator (watch). See
[`protocol.ts`](packages/server/src/protocol.ts) for every message.

- Each command carries an `id` chosen by the device. A resent command gets the first answer again
  and changes nothing, so a device can safely resend after losing its connection.
- Events are numbered. A device that reconnects sends the last number it has and gets only what
  it missed; one that sees a gap sends `resync` for the whole state.
- Events are stored before they are sent, so a restart restores the race exactly.

### Tracking

- A device sends `{"t":"positions","id":"…","trackerId":"…","fixes":[{"lat","lng","fixTime","speedKt","headingDeg"}]}`
  (up to 500 fixes) and gets `positionsAck`. Tracker IDs are Meshtastic node IDs (`!a1b2c3d4`) or a
  phone's own (`phone-…`). Skippers and the race office may send positions; spectators may not.
- Positions are not events: they are kept in their own table and decide nothing. Only trackers
  connected to a boat are kept or shown. A phone relaying a radio hears every radio nearby, so
  the others are only listed to the race office as "heard", without where they are.
- When the socket is down, the Android app's background service can
  `POST /api/regattas/<code>/positions` with the skipper or race officer PIN in `x-regatta-pin`.
- With the start line and first mark set (Setup, Course), the server tells the race office which
  boats GPS places over the line at the gun, and when boats cross the finish line. These are
  suggestions: the race office records finishes and raises X.

## The Android app

The same pages, packaged with Capacitor in `packages/app/android`. It adds what a website can't do:
sharing the phone's position with the screen off (a foreground service with a notification) and
native Bluetooth to Meshtastic radios. The website does Bluetooth too, in Chrome.

- **Get it:** every build publishes a debug APK as the **Test build** pre-release (Releases, on
  the repository page). On the Android phone, open
  `https://github.com/dodol183/boat-race-tracker/releases/download/test-build/boat-race-tracker-test.apk`
  and allow installing from the browser when asked. Each build is signed with a new debug key, so
  uninstall the previous one first. (Each CI run also keeps it under Artifacts, zipped.)
- **Server:** set the repository variable `BRT_SERVER_URL` (e.g. `https://race.yourclub.org`) to
  build it into the app; otherwise the app asks for it on the join screen.
- **Build it yourself:** with Android Studio or the Android SDK and Java 21:
  `npm run build && cd packages/app && npx cap sync android && cd android && ./gradlew assembleDebug`.

## How the engine works

```ts
import { decide, apply, advance, emptyRegatta } from '@brt/engine';

let state = emptyRegatta();
const d = decide(state, { type: 'startSequence', classId: 'c1' }, Date.now());
if (d.ok) state = d.events.reduce(apply, state);   // else d.error.message says why not
```

- `decide(state, command, now)` checks a command against the rules and returns the events it
  causes, or a refusal with a message for the race officer.
- `apply(state, event)` folds one event into the state. It never decides anything.
- `advance(state, now)` returns events caused by time alone (the start gun).
- The server stores the events; `replay(events, emptyRegatta())` rebuilds the state exactly.
