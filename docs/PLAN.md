# TMTRAC rebuild plan

A smaller app built around the server, reusing the parts of today's code that are tested.
Status: phases 1–3 built (engine, server, screens); phase 4a (tracking on the website) built; 4b (Bluetooth trackers, Android app) next. Code lives in
`dodol183/boat-race-tracker`, hosted on
cPanel with Node 22, with a phone app for race officers and skippers.

## Why

The current app works, but most bugs fixed in PRs #24–#41 came from its shape, not from typos:

- **Every device runs the race.** Each browser runs its own race clock, status rules and finish
  detection, then sends the whole fleet to the server. Devices overwrite each other, a skipper's
  device used to send fleet edits it had no right to make, and offline edits needed a three-way
  merge to survive.
- **One file holds the client.** `src/App.tsx` is 3,700 lines with about 80 pieces of state;
  `server.ts` is 3,500 lines. A change in one place breaks another.
- **Too much surface, too little proof.** Billing, multi-tenancy, an AI tactician, jury tools and
  three export formats exist; none of it has run a real race.
- **Production has no real database.** The cPanel host runs Node 20, which has no built-in SQLite,
  so production runs on the JSON fallback store, a hand-written SQL imitation.

## Goal

Run one club race end to end, on the water, with results the race officer trusts more than paper.

### In scope (version 1)

1. **Tracking:** Meshtastic LoRa trackers relayed by a phone or laptop over Bluetooth, and phones
   sharing their own GPS.
2. **Start sequence:** per class, with AP (postpone), general recall and X flag (individual recall).
3. **Finishes:** one tap per boat, or by sail number, timed by the server; GPS crossings suggested.
4. **Scoring:** IRC, ORC and Portsmouth corrected time, RRS Appendix A low point, series with
   discards; Sailwave CSV export.
5. **Spectator view:** live map and leaderboard by event code.

One club, a race officer PIN and a skipper PIN, as today.

### Out of scope for version 1

Billing and Stripe, multi-tenant clubs and the Super Admin panel, the AI tactician, jury and
protest tools, World Sailing XML, weather overlays, head-to-head, the cPanel deploy screen, MQTT
bridge (can return later; the current bridge code is reusable). Each can come back once the core
has run real races.

## Principles

1. **The server owns the race.** Devices send *commands* ("start Class 1 in 5 minutes", "finish
   MAS 33"). The server checks them, applies the racing rules, and sends everyone the result.
   No race logic runs on a device.
2. **The server's clock is the clock.** Start times, finish times and elapsed times are server
   timestamps. Devices only display them (they already sync to it, `services/serverClock.ts`).
3. **Every change is a recorded event.** The server keeps an append-only log per regatta
   ("Class 1 started 10:05:00", "MAS 33 finished 11:02:14 by tap"). State is rebuilt from the log,
   which gives undo, an audit trail and race replay for free.
4. **Rules are pure functions with tests.** The race engine is plain TypeScript with no I/O:
   `(state, command, now) → (new state, events) | rejection`. Every racing rule gets a test.
5. **Small screens, phone first.** Each screen does one job; 44 px targets; readable in sunlight.

## Architecture

```
 phone / laptop (React)                         server (Node, TypeScript)
 ┌─────────────────────────┐   commands    ┌──────────────────────────────────┐
 │ Race officer screens    │ ────────────▶ │ command handler (auth, validate)  │
 │ Tracker (GPS, Bluetooth)│   positions   │        │                          │
 │ Spectator map           │ ────────────▶ │  race engine (pure) ◀─ positions  │
 │                         │ ◀──────────── │        │                          │
 └─────────────────────────┘ state+events  │  event log + snapshots (SQLite)  │
                                           └──────────────────────────────────┘
```

### Server modules

| Module | Job | Starts from |
|---|---|---|
| `engine/` | Race state and rules: sequences, AP, recalls, finishes, statuses, scoring. Pure. | `recallAndFinish.ts`, `handicap.ts`, `scoringService.ts` (rules only), `classRaceState.ts` |
| `tracking/` | Accept positions; relay ownership; fresh-fix rule; boat binding; GPS finish/OCS suggestions | `trackerRelay.ts`, `gpsBatch.ts`, `skipperBinding.ts`, `startLineSide` |
| `store/` | Event log and snapshots in SQLite | new; `packages.ts` pattern for defaults |
| `api/` | WebSocket and HTTP: join, commands, positions, state | the auth/PIN checks in `server.ts`, `sessions.ts`, `gate.ts` |
| `export/` | Sailwave CSV, standard CSV | `csv.ts`, Sailwave export |

### Protocol

- **Device → server:** `{ type: 'command', id, name, payload }` with a unique `id` per command, and
  `{ type: 'positions', trackerId, fixes: [{ lat, lng, speedKt, headingDeg, fixTime }] }` for
  tracking (one fix or a stored batch). There is no existing app to stay compatible with, so the
  protocol is designed fresh; the HTTP batch route stays as the fallback when the socket is down.
- **Server → device:** a full snapshot on join, then numbered events. A device that misses a number
  asks for the events since its last one.
- **Offline:** the device queues commands and resends them on reconnect. The server ignores an `id`
  it has already applied, and rejects a command that no longer makes sense ("MAS 33 already
  finished") with a reason the screen shows. This replaces today's whole-fleet three-way merge
  (`editSync.ts`), which exists only because devices send the whole fleet.

### Commands in version 1

`setupCourse`, `setFleet` (add, edit, remove boat), `setClasses`, `bindTracker`, `scheduleStart`,
`postpone` / `resumeSequence` (AP), `generalRecall`, `individualRecall` (boats), `markReturned`,
`lowerX`, `recordFinish` (boat, optional time), `undoFinish`, `setPenalty` (DNF, RET, DNS, DNC,
DSQ, OCS), `endRace`, `scoreSeries`.

### Client screens (one app, three roles)

1. **Setup:** classes, fleet, trackers, course (today's Setup area, simplified).
2. **Start:** class clock, start/AP/recall/X controls, OCS list.
3. **Finishes:** tap or type a sail number; finish order; undo (today's Finishes tab).
4. **Results:** race and series, export.
5. **Tracker:** share this phone's GPS, or relay a Bluetooth T-Echo.
6. **Spectator:** map, leaderboard, class status.

## The phone app

One React + TypeScript codebase, used two ways:

- **As a website** for spectators, and for race officers on a laptop.
- **As an installed Android app**, packaged with **Capacitor**, for race officers and skippers on
  the water. iOS comes after the first real races.

Why an installed app rather than only a website:

| Need | Website | Installed app |
|---|---|---|
| Bluetooth to a T-Echo | Chrome on Android/desktop only; none on iPhone; stops when the page closes | Native Bluetooth LE on Android and iOS (`@capacitor-community/bluetooth-le`) |
| A skipper's phone tracking with the screen off | Stops when the browser is in the background | Background location with an Android foreground service |
| Racing without signal | Only while the page stays open | Kept on the phone and sent when signal returns |
| Getting it onto phones | A link | Play Store (internal testing first) |

The race officer, skipper and spectator screens are the same components in both. Only the
Bluetooth and background-location parts use Capacitor plugins, behind one small interface, so the
website keeps working with Web Bluetooth and foreground GPS.

## What carries over

Kept, with their unit tests moving alongside them:

- Meshtastic: `services/meshtastic/protocol.ts`, `meshtasticBleMqttService.ts` (Bluetooth part),
  `utils/nodeId.ts`, the T-Echo replay fixture and tests.
- Relay and positions: `trackerRelay.ts`, `server/gpsBatch.ts`, `server/skipperBinding.ts`,
  `trackerFix.ts` ideas (rewritten as engine rules).
- Racing rules: `recallAndFinish.ts` (start-line geometry, X flag, finish records), `handicap.ts`,
  the low-point and discard logic from `scoringService.ts`.
- Exports: `csv.ts`, Sailwave CSV.
- Connection status: `serverConnection.ts` and the banner.
- UI pieces: `ui/Button`, `ui/Dialog`, theme tokens, the 44 px and contrast work.

Rewritten: `App.tsx`, `server.ts`, `deviceTrackerService.ts`, `db.ts` (and the JSON store).

## Phases

Each phase ends with something that can be checked. Sizes are relative (S, M, L), not dates.

| # | Phase | Size | Done when |
|---|---|---|---|
| 0 | **Test day on today's app** (checklist ready) | — | Results back: position rates, what the race officer used, what broke. Adjust this plan. |
| 1 | **Race engine**, no UI | M | Scripted races pass: start, AP, general recall, X flag, finishes, penalties, scoring for IRC/ORC/PY, series with discards. |
| 2 | **Server, protocol, event log** | M | Two devices always agree; a restart restores the exact state; a duplicated or late command is handled; Android position uploads still accepted. |
| 3 | **Race officer and spectator screens** | L | A race can be run from a phone with no help; 375 px and sunlight checks pass. |
| 4 | **Phone app and tracking**: Capacitor Android build, native Bluetooth relay, background GPS, binding | L | A T-Echo on a desk and two phones (one locked in a pocket) move boats for an hour; GPS finish suggestions appear; the app installs from Play Store internal testing. |
| 5 | **Shadow a real race** next to the club's usual method | — | Results match paper (or the differences are explained). |
| 6 | Switch over; bring back what clubs ask for | — | Accounts, billing, MQTT, extra exports, as needed. |

Today's app stays deployed until phase 5 succeeds. Fixes to it are limited to safety and
correctness.

## Hosting

**Decided: cPanel (Exabytes) with Node 22**, using Node's built-in `node:sqlite`. No JSON fallback
store in the new server.

- `node:sqlite` works without a flag from Node 22.13; on 22.5–22.12 the app must start with
  `--experimental-sqlite`. Check the exact version in cPanel's Node.js selector.
- The database file lives outside `public_html` (as today's `DATA_DIR`), with a nightly copy.
- The current site and the new one can run side by side on separate subdomains until switch-over.

## Risks

- **LoRa positions are slow** (every 30 s or more), so GPS can only *suggest* OCS and finishes.
  Taps by the race officer are the record; GPS is the check. The test day will measure the rate.
- **Background tracking on Android.** Phone makers' battery savers stop background apps; tracking
  needs a foreground service with a visible notification, and testing on the phones skippers
  actually use.
- **Store accounts.** Google Play needs a developer account (one-time fee) and a privacy policy for
  location data; Apple (later) needs a yearly membership and stricter review of background location.
- **Scope creep.** Anything not in the version 1 list waits until phase 6.

## Decisions

Made:

1. **Code:** new repository `dodol183/boat-race-tracker`.
2. **Hosting:** cPanel with Node 22.
3. **App:** a new phone app is part of the rebuild (see "The phone app").
4. **Scope:** the five version 1 items and the out-of-scope list, as above.
5. **App:** Capacitor.
6. **Platforms:** Android only for version 1; iOS after the first real races.

Still open:

7. **Google Play developer account and a privacy policy** for location data: needed before
   store testing in phase 4.
