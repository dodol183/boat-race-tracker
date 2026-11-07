# Boat Race Tracker

Sailing race management. Read docs/PLAN.md for scope and phases before adding features: version 1
is tracking, start sequences with recalls, finishes, scoring with Sailwave export, and a spectator
view. Anything else waits.

## Rules of the codebase

- **The server owns the race.** Race logic lives in `packages/engine` and runs on the server only.
  Devices send commands and display state. Never put racing rules in the app.
- **The engine is pure.** No clock (callers pass `now`), no I/O, no randomness. Every rule change
  comes with a test in `packages/engine/tests`, written as a scripted race.
- **Events are the record.** `apply` must stay a dumb fold: anything decided (a default code, a
  time) goes into the event payload by `decide`.
- **Refusals are for people.** `Refusal.message` is shown to a race officer on a phone: plain
  words, what to do next.
- **Racing rules:** follow the Racing Rules of Sailing (RRS 26 sequence, 27.3/Race Signals AP,
  29.1 X flag, 29.2 general recall, Appendix A scoring). Cite the rule in comments when it matters.

- **Server:** `packages/server`. A `RegattaHub` per regatta stores events before sending them,
  answers each command id once (resends get the first answer), and fires the start gun on a
  timer (`tick`). Inject the clock (`now`) in tests instead of waiting.

- **App:** `packages/app`, React + Tailwind, phone first (44 px targets, works at 375 px).
  `RegattaClient` (`src/lib/client.ts`) is the only thing that talks to the server; it has no
  React or DOM so it is tested in Node and reused by the Android app. Screens read state and call
  `client.send(command)`; they never change state themselves. Use `client.serverNow()` for any
  time shown or sent (finish taps carry `at`).

- **Tracking:** positions are not events. They go through `RegattaHub.acceptPositions`, are kept
  in the `fixes` table, and never change the race. GPS only *suggests* (OCS at the gun, finish
  crossings; `gpsSuggestions` in the engine, sent to the race office only); a race office command
  is the record. Never keep or show positions of a tracker that no boat has: a relay hears
  strangers' radios. Tests use made-up positions near 1°N 1°E; never commit real coordinates.

- **Phone hardware** lives behind small interfaces so the website and the Android app share the
  screens: `GpsSource` (`PhoneGps` for browsers, `NativeGps` for the app's background service) and
  `RadioLink` (`openRadio` in `src/lib/meshtastic/bleLink.ts`, the same code for Web Bluetooth and
  native). `MeshtasticRelay` is tested against `tests/fixtures/techo-rm1-usb.jsonl`, a cleaned
  recording of a real T-Echo; never add uncleaned radio recordings. `src/lib/platform.ts` decides
  where the server is (the site, or the address set in the app).

- **Practice boats** (trackers `sim-…`) are sailed by `packages/server/src/practice.ts` while
  `options.practiceBoatsSail` is on. A boat's position is a pure function of the race and the time,
  so several server processes agree; keep it that way.

## Commands

- `npm install`, `npm test`, `npm run typecheck`, `npm run build` (Node 22.13+).
- `npm run dev -w @brt/app` with the server running on port 3000.
- The Android APK is built by `.github/workflows/ci.yml` (this environment has no Android SDK).
- `npm run deploy:build`: the cPanel zip (`scripts/build-deploy.mjs`, startup file `scripts/deploy/app.js`).

## Hosting

cPanel (Exabytes) with Node 22, built-in `node:sqlite`. No JSON fallback store. Steps in
`docs/DEPLOY_CPANEL.md`. cPanel may run more than one copy of the server: each hub reads the
events and fixes the others stored (`syncFromStore`, `syncFixes`), so never keep race state that
isn't in the database.
