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
| [`packages/engine`](packages/engine) | Racing rules as pure functions: start sequence, AP, general and individual recall, finishes, penalty codes, corrected time, race and series scoring (RRS Appendix A) | Phase 1: done, with tests |
| [`packages/server`](packages/server) | Node server: runs the engine, stores every event in SQLite, keeps devices in step over WebSocket | Phase 2: done, with tests |
| `packages/app` | React app (website + Android app via Capacitor) for race officers, skippers and spectators | Phases 3–4 |

## Develop

Needs Node 22.13 or later.

```sh
npm install
npm test          # all packages
npm run typecheck
```

## Run the server

```sh
ADMIN_TOKEN=<at least 16 characters> DATA_DIR=./data npm start -w @brt/server
# create a regatta (returns its code and the race officer and skipper PINs)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"Club Race"}' localhost:3000/api/regattas
```

Devices connect to `ws://host/ws` and send `{"t":"hello","regattaId":"<code>","pin":"<PIN>"}`.
The PIN decides the role: race officer (commands), skipper or spectator (watch). See
[`protocol.ts`](packages/server/src/protocol.ts) for every message.

- Each command carries an `id` chosen by the device. A resent command gets the first answer again
  and changes nothing, so a device can safely resend after losing its connection.
- Events are numbered. A device that reconnects sends the last number it has and gets only what
  it missed; one that sees a gap sends `resync` for the whole state.
- Events are stored before they are sent, so a restart restores the race exactly.

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
