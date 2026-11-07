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

## Commands

- `npm install`, `npm test`, `npm run typecheck` (Node 22.13+).

## Hosting

cPanel (Exabytes) with Node 22, built-in `node:sqlite`. No JSON fallback store.
