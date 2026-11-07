// Commands in, events out. `decide` checks a command against the racing rules and returns the
// events it causes (or why it can't be done); `apply` folds one event into the state; `advance`
// returns the events that time alone causes (the start gun). The server keeps the events, so the
// state can always be rebuilt by applying them in order.
import { emptyRegatta, type Boat, type Course, type Entry, type PenaltyCode, type Race, type RaceClass, type RatingSystem, type RegattaOptions, type RegattaState } from './types.ts';
import { distanceM, isPoint, startLineOffset } from './geo.ts';
import { isPhoneTracker, trackerId } from './tracking.ts';

export const MINUTE = 60_000;
/** RRS 29.1: X comes down once every recalled boat has returned, and no later than 4 minutes after the start */
export const X_FLAG_LIMIT_MS = 4 * MINUTE;
/** Race Signals (AP, first substitute): the warning signal is made 1 minute after removal */
export const RESUME_DELAY_MS = 1 * MINUTE;
/** A device's estimate of the server clock can be a little ahead; within this, "now" is meant */
export const CLOCK_TOLERANCE_MS = 2_000;

// ---------------------------------------------------------------------------------------------
// Commands

export type Command =
  | { type: 'saveClass'; class: { id: string; name: string; ratingSystem: RatingSystem; sequenceMinutes?: number } }
  | { type: 'removeClass'; classId: string }
  | { type: 'saveBoat'; boat: Omit<Boat, 'trackerId'> }
  | { type: 'removeBoat'; boatId: string }
  | { type: 'bindTracker'; boatId: string; trackerId: string | null }
  /** A skipper connecting their phone or tracker to a boat with none (when the race office allows it) */
  | { type: 'claimTracker'; boatId: string; trackerId: string }
  /** A skipper disconnecting their own phone; knowing its id is the proof */
  | { type: 'releaseTracker'; boatId: string; trackerId: string }
  | { type: 'setCourse'; course: Course }
  | { type: 'setOptions'; options: Partial<RegattaOptions> }
  | { type: 'startSequence'; classId: string }
  | { type: 'postpone'; raceId: string }
  | { type: 'resumeSequence'; raceId: string }
  | { type: 'generalRecall'; raceId: string }
  | { type: 'individualRecall'; raceId: string; boatIds: string[] }
  | { type: 'markReturned'; raceId: string; boatId: string }
  | { type: 'lowerX'; raceId: string }
  | { type: 'recordFinish'; raceId: string; boatId: string; at?: number; source?: 'TAP' | 'GPS' }
  | { type: 'undoFinish'; raceId: string; boatId: string }
  | { type: 'setPenalty'; raceId: string; boatId: string; code: PenaltyCode | null }
  | { type: 'endRace'; raceId: string }
  | { type: 'abandonRace'; raceId: string };

// ---------------------------------------------------------------------------------------------
// Events: what happened, with everything needed to apply it (apply never decides anything)

export type RegattaEvent =
  | { type: 'classSaved'; class: RaceClass }
  | { type: 'classRemoved'; classId: string }
  | { type: 'boatSaved'; boat: Omit<Boat, 'trackerId'> }
  | { type: 'boatRemoved'; boatId: string }
  | { type: 'trackerBound'; boatId: string; trackerId: string | null }
  | { type: 'courseSet'; course: Course }
  | { type: 'optionsSet'; options: RegattaOptions }
  | { type: 'sequenceStarted'; raceId: string; classId: string; number: number; warningAt: number; startAt: number }
  | { type: 'postponed'; raceId: string; at: number }
  | { type: 'sequenceResumed'; raceId: string; warningAt: number; startAt: number }
  | { type: 'raceStarted'; raceId: string; at: number; boatIds: string[] }
  | { type: 'generalRecalled'; raceId: string; at: number }
  | { type: 'xFlagRaised'; raceId: string; at: number; boatIds: string[] }
  | { type: 'boatReturned'; raceId: string; boatId: string; at: number }
  | { type: 'xFlagLowered'; raceId: string; at: number }
  | { type: 'finishRecorded'; raceId: string; boatId: string; at: number; source: 'TAP' | 'GPS' }
  | { type: 'finishUndone'; raceId: string; boatId: string }
  | { type: 'penaltySet'; raceId: string; boatId: string; code: PenaltyCode | null }
  | { type: 'raceEnded'; raceId: string; at: number; penalties: { boatId: string; code: PenaltyCode }[] }
  | { type: 'raceAbandoned'; raceId: string; at: number };

export interface Refusal {
  code: string;
  /** What the race officer sees */
  message: string;
}

export type Decision = { ok: true; events: RegattaEvent[] } | { ok: false; error: Refusal };

const refuse = (code: string, message: string): Decision => ({ ok: false, error: { code, message } });
const accept = (...events: RegattaEvent[]): Decision => ({ ok: true, events });

// ---------------------------------------------------------------------------------------------
// Queries used by the rules (and by screens)

const ACTIVE: Race['phase'][] = ['SEQUENCE', 'POSTPONED', 'RECALLED', 'RACING'];

export const raceIdFor = (classId: string, number: number) => `${classId}-R${number}`;

/** The class's race that is under way (sequence, postponed, recalled or racing), if any */
export function activeRace(state: RegattaState, classId: string): Race | undefined {
  return Object.values(state.races).find((r) => r.classId === classId && ACTIVE.includes(r.phase));
}

/** The number the class's next race will get: abandoned races keep their number */
export function nextRaceNumber(state: RegattaState, classId: string): number {
  return Object.values(state.races).filter((r) => r.classId === classId).reduce((n, r) => Math.max(n, r.number), 0) + 1;
}

/** The race's phase at `now`: a sequence whose start time has passed is racing */
export function phaseAt(race: Race, now: number): Race['phase'] {
  return race.phase === 'SEQUENCE' && race.startAt !== undefined && now >= race.startAt ? 'RACING' : race.phase;
}

const boatLabel = (state: RegattaState, boatId: string) => state.boats[boatId]?.sailNumber || boatId;
const normalizeSail = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------
// decide

export function decide(state: RegattaState, cmd: Command, now: number): Decision {
  // Time first: a command just after the gun acts on a started race
  const pending = advance(state, now);
  const s = pending.length ? pending.reduce(apply, state) : state;
  const d = decideNow(s, cmd, now);
  return d.ok && pending.length ? { ok: true, events: [...pending, ...d.events] } : d;
}

function decideNow(state: RegattaState, cmd: Command, now: number): Decision {
  switch (cmd.type) {
    case 'saveClass': {
      const c = cmd.class;
      if (!c.id?.trim() || !c.name?.trim()) return refuse('BAD_CLASS', 'A class needs a name.');
      if (!['IRC', 'ORC', 'PY'].includes(c.ratingSystem)) return refuse('BAD_RATING_SYSTEM', 'Choose IRC, ORC or Portsmouth (PY).');
      const minutes = c.sequenceMinutes ?? 5;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10) return refuse('BAD_SEQUENCE', 'The start sequence is 1 to 10 minutes.');
      const clash = Object.values(state.classes).find((o) => o.id !== c.id && o.name.trim().toLowerCase() === c.name.trim().toLowerCase());
      if (clash) return refuse('CLASS_NAME_TAKEN', `There is already a class called ${clash.name}.`);
      const existing = state.classes[c.id];
      if (existing && existing.ratingSystem !== c.ratingSystem && activeRace(state, c.id)) {
        return refuse('CLASS_RACING', `${existing.name} has a race under way; change its rating system after the race.`);
      }
      return accept({ type: 'classSaved', class: { id: c.id, name: c.name.trim(), ratingSystem: c.ratingSystem, sequenceMinutes: minutes } });
    }

    case 'removeClass': {
      const c = state.classes[cmd.classId];
      if (!c) return refuse('NO_SUCH_CLASS', 'That class no longer exists.');
      if (Object.values(state.boats).some((b) => b.classId === c.id)) return refuse('CLASS_HAS_BOATS', `Move or remove the boats in ${c.name} first.`);
      if (Object.values(state.races).some((r) => r.classId === c.id)) return refuse('CLASS_HAS_RACES', `${c.name} has races; it can't be removed.`);
      return accept({ type: 'classRemoved', classId: c.id });
    }

    case 'saveBoat': {
      const b = cmd.boat;
      const cls = state.classes[b.classId];
      if (!b.id?.trim()) return refuse('BAD_BOAT', 'A boat needs an id.');
      if (!cls) return refuse('NO_SUCH_CLASS', 'Choose a class for the boat.');
      if (!normalizeSail(b.sailNumber ?? '')) return refuse('NO_SAIL_NUMBER', 'A boat needs a sail number.');
      if (!Number.isFinite(b.rating) || b.rating <= 0) return refuse('BAD_RATING', 'Give the boat a rating.');
      if (cls.ratingSystem === 'PY' && (b.rating < 500 || b.rating > 2000)) return refuse('BAD_RATING', 'A Portsmouth Number is between 500 and 2000 (e.g. 1100).');
      if (cls.ratingSystem !== 'PY' && (b.rating < 0.5 || b.rating > 2)) return refuse('BAD_RATING', 'A time correction factor is between 0.500 and 2.000 (e.g. 1.042).');
      const sail = normalizeSail(b.sailNumber);
      const clash = Object.values(state.boats).find((o) => o.id !== b.id && normalizeSail(o.sailNumber) === sail);
      if (clash) return refuse('SAIL_TAKEN', `${clash.name || clash.sailNumber} already has sail number ${sail}.`);
      const existing = state.boats[b.id];
      if (existing && existing.classId !== b.classId && isEnteredInActiveRace(state, b.id)) {
        return refuse('BOAT_RACING', `${existing.sailNumber} is in a race under way; change its class after the race.`);
      }
      return accept({ type: 'boatSaved', boat: { id: b.id, classId: b.classId, sailNumber: sail, name: (b.name ?? '').trim(), rating: b.rating } });
    }

    case 'removeBoat': {
      const b = state.boats[cmd.boatId];
      if (!b) return refuse('NO_SUCH_BOAT', 'That boat is no longer in the fleet.');
      if (isEnteredInActiveRace(state, b.id)) return refuse('BOAT_RACING', `${b.sailNumber} is in a race under way; remove it after the race.`);
      return accept({ type: 'boatRemoved', boatId: b.id });
    }

    case 'bindTracker': {
      const b = state.boats[cmd.boatId];
      if (!b) return refuse('NO_SUCH_BOAT', 'That boat is no longer in the fleet.');
      if (cmd.trackerId !== null) {
        const id = trackerId(cmd.trackerId);
        if (!id) return refuse('BAD_TRACKER', 'A tracker ID is a Meshtastic node ID such as !a1b2c3d4.');
        const other = Object.values(state.boats).find((o) => o.id !== b.id && o.trackerId === id);
        if (other) return refuse('TRACKER_IN_USE', `That tracker is on ${other.sailNumber}. Unbind it there first.`);
        return accept({ type: 'trackerBound', boatId: b.id, trackerId: id });
      }
      return accept({ type: 'trackerBound', boatId: b.id, trackerId: null });
    }

    case 'claimTracker': {
      if (!state.options?.skippersConnectTrackers) return refuse('CLAIM_OFF', 'The race office has not allowed skippers to connect trackers. Ask them to connect yours.');
      const b = state.boats[cmd.boatId];
      if (!b) return refuse('NO_SUCH_BOAT', 'That boat is no longer in the fleet.');
      const id = trackerId(cmd.trackerId);
      if (!id) return refuse('BAD_TRACKER', 'That is not a tracker this app knows.');
      // Asking again for the connection already there is fine
      if (b.trackerId === id) return accept();
      // A skipper can't replace another tracker, so can't take another boat off the map
      if (b.trackerId) return refuse('BOAT_HAS_TRACKER', `${b.sailNumber} already has a tracker. Ask the race office to change it.`);
      const other = Object.values(state.boats).find((o) => o.trackerId === id);
      if (other) return refuse('TRACKER_IN_USE', `This tracker is on ${other.sailNumber}. Ask the race office to move it.`);
      return accept({ type: 'trackerBound', boatId: b.id, trackerId: id });
    }

    case 'releaseTracker': {
      const b = state.boats[cmd.boatId];
      const id = trackerId(cmd.trackerId);
      if (!b || !id || b.trackerId !== id) return refuse('NOT_YOUR_TRACKER', 'This phone is not connected to that boat.');
      // Only a phone: a radio's id is printed on it, so knowing it proves nothing
      if (!isPhoneTracker(id)) return refuse('ASK_RACE_OFFICE', 'Ask the race office to disconnect a radio tracker.');
      return accept({ type: 'trackerBound', boatId: b.id, trackerId: null });
    }

    case 'setCourse': {
      const course: Course = {};
      const keys = ['startPin', 'startCommittee', 'firstMark', 'finishPin', 'finishCommittee'] as const;
      for (const k of keys) {
        const p = cmd.course?.[k];
        if (p === undefined || p === null) continue;
        if (!isPoint(p)) return refuse('BAD_POSITION', 'A mark has a position that is not on the map.');
        course[k] = { lat: p.lat, lng: p.lng };
      }
      for (const [a, b, what] of [['startPin', 'startCommittee', 'start'], ['finishPin', 'finishCommittee', 'finish']] as const) {
        const pa = course[a];
        const pb = course[b];
        if (!pa !== !pb) return refuse('HALF_LINE', `The ${what} line needs both ends.`);
        if (pa && pb) {
          const len = distanceM(pa, pb);
          if (len < 5 || len > 3000) return refuse('BAD_LINE', `The ${what} line is ${Math.round(len)} m long; check its ends.`);
        }
      }
      if (course.firstMark && course.startPin && course.startCommittee && startLineOffset(course.firstMark, course.startPin, course.startCommittee, course.firstMark) === null) {
        return refuse('MARK_ON_LINE', 'The first mark is on the start line; move it up the course.');
      }
      return accept({ type: 'courseSet', course });
    }

    case 'setOptions': {
      const v = cmd.options?.skippersConnectTrackers;
      if (v !== undefined && typeof v !== 'boolean') return refuse('BAD_OPTION', 'That setting could not be read.');
      return accept({ type: 'optionsSet', options: { ...emptyRegatta().options, ...state.options, ...(v !== undefined ? { skippersConnectTrackers: v } : {}) } });
    }

    case 'startSequence': {
      const cls = state.classes[cmd.classId];
      if (!cls) return refuse('NO_SUCH_CLASS', 'That class no longer exists.');
      const busy = activeRace(state, cls.id);
      if (busy) return refuse('RACE_UNDER_WAY', `${cls.name} race ${busy.number} is still under way. End or abandon it first.`);
      if (!Object.values(state.boats).some((b) => b.classId === cls.id)) return refuse('NO_BOATS', `${cls.name} has no boats.`);
      const number = nextRaceNumber(state, cls.id);
      return accept({
        type: 'sequenceStarted',
        raceId: raceIdFor(cls.id, number),
        classId: cls.id,
        number,
        warningAt: now,
        startAt: now + cls.sequenceMinutes * MINUTE,
      });
    }

    case 'postpone': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'SEQUENCE') return refuse('NOT_BEFORE_START', 'AP can only go up before the start.');
      return accept({ type: 'postponed', raceId: r.id, at: now });
    }

    case 'resumeSequence': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'POSTPONED' && r.phase !== 'RECALLED') return refuse('NOT_WAITING', 'The race is not postponed or recalled.');
      const cls = state.classes[r.classId]!;
      const warningAt = now + RESUME_DELAY_MS;
      return accept({ type: 'sequenceResumed', raceId: r.id, warningAt, startAt: warningAt + cls.sequenceMinutes * MINUTE });
    }

    case 'generalRecall': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'RACING') return refuse('NOT_STARTED', 'A general recall is made after the start.');
      if (Object.values(r.entries).some((e) => e.finishAt !== undefined)) return refuse('BOATS_FINISHED', 'Boats have finished; abandon the race instead.');
      return accept({ type: 'generalRecalled', raceId: r.id, at: now });
    }

    case 'individualRecall': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'RACING' || r.startedAt === undefined) return refuse('NOT_STARTED', 'X goes up after the start.');
      if (r.xFlag) return refuse('X_ALREADY', 'X has already been used for this start.');
      if (now - r.startedAt >= X_FLAG_LIMIT_MS) return refuse('X_TOO_LATE', 'More than 4 minutes since the start: mark those boats OCS instead.');
      const ids = [...new Set(cmd.boatIds)];
      if (ids.length === 0) return refuse('NO_BOATS', 'Choose the boats over the line.');
      const stranger = ids.find((id) => !r.entries[id]);
      if (stranger) return refuse('NOT_IN_RACE', `${boatLabel(state, stranger)} is not in this race.`);
      return accept({ type: 'xFlagRaised', raceId: r.id, at: now, boatIds: ids });
    }

    case 'markReturned': {
      const r = state.races[cmd.raceId];
      const e = r?.entries[cmd.boatId];
      if (!r || !e) return refuse('NOT_IN_RACE', 'That boat is not in this race.');
      if (!e.ocs) return refuse('NOT_OCS', `${boatLabel(state, cmd.boatId)} is not marked over the line.`);
      return accept({ type: 'boatReturned', raceId: r.id, boatId: cmd.boatId, at: now });
    }

    case 'lowerX': {
      const r = state.races[cmd.raceId];
      if (!r?.xFlag || r.xFlag.loweredAt !== undefined) return refuse('X_NOT_UP', 'X is not up.');
      return accept({ type: 'xFlagLowered', raceId: r.id, at: now });
    }

    case 'recordFinish': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'RACING' || r.startedAt === undefined) return refuse('NOT_RACING', 'Finishes are recorded while the race is on.');
      const e = r.entries[cmd.boatId];
      if (!e) return refuse('NOT_IN_RACE', 'That boat is not in this race.');
      if (e.finishAt !== undefined) return refuse('ALREADY_FINISHED', `${boatLabel(state, cmd.boatId)} already has a finish.`);
      if (e.penalty && e.penalty !== 'OCS') return refuse('HAS_PENALTY', `${boatLabel(state, cmd.boatId)} is scored ${e.penalty}. Clear that first.`);
      if (cmd.at !== undefined && (!Number.isFinite(cmd.at) || cmd.at > now + CLOCK_TOLERANCE_MS)) return refuse('IN_FUTURE', 'A finish can’t be in the future.');
      // A tap timed by the device on its estimate of the server clock may be a hair ahead
      const at = Math.min(cmd.at ?? now, now);
      if (at < r.startedAt) return refuse('BEFORE_START', 'A finish can’t be before the start.');
      return accept({ type: 'finishRecorded', raceId: r.id, boatId: cmd.boatId, at, source: cmd.source ?? 'TAP' });
    }

    case 'undoFinish': {
      const r = state.races[cmd.raceId];
      const e = r?.entries[cmd.boatId];
      if (!r || !e) return refuse('NOT_IN_RACE', 'That boat is not in this race.');
      if (r.phase !== 'RACING') return refuse('NOT_RACING', 'The race has ended; correct the result with a penalty code instead.');
      if (e.finishAt === undefined) return refuse('NOT_FINISHED', `${boatLabel(state, cmd.boatId)} has no finish.`);
      return accept({ type: 'finishUndone', raceId: r.id, boatId: cmd.boatId });
    }

    case 'setPenalty': {
      const r = state.races[cmd.raceId];
      const e = r?.entries[cmd.boatId];
      if (!r || !e) return refuse('NOT_IN_RACE', 'That boat is not in this race.');
      if (r.phase !== 'RACING' && r.phase !== 'FINISHED') return refuse('NOT_STARTED', 'Penalty codes apply once the race has started.');
      if (cmd.code !== null && !['DNC', 'DNS', 'OCS', 'DNF', 'RET', 'DSQ'].includes(cmd.code)) return refuse('BAD_CODE', 'Unknown scoring code.');
      return accept({ type: 'penaltySet', raceId: r.id, boatId: cmd.boatId, code: cmd.code });
    }

    case 'endRace': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase !== 'RACING') return refuse('NOT_RACING', 'Only a race that has started can be ended.');
      // A boat still over the line is OCS, finished or not (RRS A5.1); one with neither a finish nor
      // a code is DNF. Codes already given stand.
      const penalties: { boatId: string; code: PenaltyCode }[] = [];
      for (const e of Object.values(r.entries)) {
        if (e.penalty) continue;
        if (e.ocs) penalties.push({ boatId: e.boatId, code: 'OCS' });
        else if (e.finishAt === undefined) penalties.push({ boatId: e.boatId, code: 'DNF' });
      }
      return accept({ type: 'raceEnded', raceId: r.id, at: now, penalties });
    }

    case 'abandonRace': {
      const r = state.races[cmd.raceId];
      if (!r) return refuse('NO_SUCH_RACE', 'That race no longer exists.');
      if (r.phase === 'FINISHED' || r.phase === 'ABANDONED') return refuse('RACE_OVER', 'That race is already over.');
      return accept({ type: 'raceAbandoned', raceId: r.id, at: now });
    }
  }
}

function isEnteredInActiveRace(state: RegattaState, boatId: string): boolean {
  return Object.values(state.races).some((r) => ACTIVE.includes(r.phase) && r.entries[boatId] !== undefined);
}

// ---------------------------------------------------------------------------------------------
// advance: events caused by time alone

export function advance(state: RegattaState, now: number): RegattaEvent[] {
  const events: RegattaEvent[] = [];
  for (const r of Object.values(state.races)) {
    if (r.phase === 'SEQUENCE' && r.startAt !== undefined && now >= r.startAt) {
      // Every boat in the class at the gun is entered
      const boatIds = Object.values(state.boats).filter((b) => b.classId === r.classId).map((b) => b.id).sort();
      events.push({ type: 'raceStarted', raceId: r.id, at: r.startAt, boatIds });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// apply

const withRace = (state: RegattaState, raceId: string, change: (r: Race) => Race): RegattaState => {
  const r = state.races[raceId];
  if (!r) return state;
  return { ...state, races: { ...state.races, [raceId]: change(r) } };
};
const withEntry = (r: Race, boatId: string, change: (e: Entry) => Entry): Race => {
  const e = r.entries[boatId];
  if (!e) return r;
  return { ...r, entries: { ...r.entries, [boatId]: change(e) } };
};

export function apply(state: RegattaState, ev: RegattaEvent): RegattaState {
  const next = applyEvent(state, ev);
  return { ...next, version: state.version + 1 };
}

function applyEvent(state: RegattaState, ev: RegattaEvent): RegattaState {
  switch (ev.type) {
    case 'classSaved':
      return { ...state, classes: { ...state.classes, [ev.class.id]: ev.class } };
    case 'classRemoved': {
      const { [ev.classId]: _gone, ...classes } = state.classes;
      return { ...state, classes };
    }
    case 'boatSaved': {
      const prev = state.boats[ev.boat.id];
      return { ...state, boats: { ...state.boats, [ev.boat.id]: { ...ev.boat, ...(prev?.trackerId ? { trackerId: prev.trackerId } : {}) } } };
    }
    case 'boatRemoved': {
      const { [ev.boatId]: _gone, ...boats } = state.boats;
      return { ...state, boats };
    }
    case 'trackerBound': {
      const b = state.boats[ev.boatId];
      if (!b) return state;
      const { trackerId: _old, ...rest } = b;
      return { ...state, boats: { ...state.boats, [b.id]: ev.trackerId ? { ...rest, trackerId: ev.trackerId } : rest } };
    }
    case 'courseSet':
      return { ...state, course: ev.course };
    case 'optionsSet':
      return { ...state, options: ev.options };
    case 'sequenceStarted':
      return {
        ...state,
        races: {
          ...state.races,
          [ev.raceId]: { id: ev.raceId, classId: ev.classId, number: ev.number, phase: 'SEQUENCE', warningAt: ev.warningAt, startAt: ev.startAt, generalRecalls: 0, entries: {} },
        },
      };
    case 'postponed':
      return withRace(state, ev.raceId, (r) => ({ ...r, phase: 'POSTPONED', warningAt: undefined, startAt: undefined }));
    case 'sequenceResumed':
      return withRace(state, ev.raceId, (r) => ({ ...r, phase: 'SEQUENCE', warningAt: ev.warningAt, startAt: ev.startAt }));
    case 'raceStarted':
      return withRace(state, ev.raceId, (r) => ({
        ...r,
        phase: 'RACING',
        startedAt: ev.at,
        entries: Object.fromEntries(ev.boatIds.map((id) => [id, { boatId: id, ocs: false, returned: false }])),
      }));
    case 'generalRecalled':
      return withRace(state, ev.raceId, (r) => ({
        ...r,
        phase: 'RECALLED',
        generalRecalls: r.generalRecalls + 1,
        warningAt: undefined,
        startAt: undefined,
        startedAt: undefined,
        xFlag: undefined,
        entries: {},
      }));
    case 'xFlagRaised':
      return withRace(state, ev.raceId, (r) => {
        let next: Race = { ...r, xFlag: { raisedAt: ev.at, boatIds: ev.boatIds } };
        for (const id of ev.boatIds) next = withEntry(next, id, (e) => ({ ...e, ocs: true, returned: false }));
        return next;
      });
    case 'boatReturned':
      return withRace(state, ev.raceId, (r) => withEntry(r, ev.boatId, (e) => ({ ...e, ocs: false, returned: true })));
    case 'xFlagLowered':
      return withRace(state, ev.raceId, (r) => (r.xFlag ? { ...r, xFlag: { ...r.xFlag, loweredAt: ev.at } } : r));
    case 'finishRecorded':
      return withRace(state, ev.raceId, (r) => withEntry(r, ev.boatId, (e) => ({ ...e, finishAt: ev.at, finishSource: ev.source })));
    case 'finishUndone':
      return withRace(state, ev.raceId, (r) =>
        withEntry(r, ev.boatId, (e) => {
          const { finishAt: _f, finishSource: _s, ...rest } = e;
          return rest;
        })
      );
    case 'penaltySet':
      return withRace(state, ev.raceId, (r) =>
        withEntry(r, ev.boatId, (e) => {
          const { penalty: _p, ...rest } = e;
          return ev.code ? { ...rest, penalty: ev.code } : rest;
        })
      );
    case 'raceEnded':
      return withRace(state, ev.raceId, (r) => {
        let next: Race = { ...r, phase: 'FINISHED', endedAt: ev.at };
        for (const p of ev.penalties) next = withEntry(next, p.boatId, (e) => ({ ...e, penalty: p.code }));
        return next;
      });
    case 'raceAbandoned':
      return withRace(state, ev.raceId, (r) => ({ ...r, phase: 'ABANDONED', endedAt: ev.at }));
  }
}

/** The state after a list of events, from empty or from a snapshot */
export function replay(events: RegattaEvent[], from: RegattaState): RegattaState {
  return events.reduce(apply, from);
}
