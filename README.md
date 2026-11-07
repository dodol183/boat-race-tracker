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
| `packages/server` | Node server: commands, event log in SQLite, WebSocket to devices | Phase 2 |
| `packages/app` | React app (website + Android app via Capacitor) for race officers, skippers and spectators | Phases 3–4 |

## Develop

Needs Node 22.13 or later.

```sh
npm install
npm test          # all packages
npm run typecheck
```

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
