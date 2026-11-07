// SQLite: regattas, their events (the record), and the commands already answered.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt } from 'node:crypto';
import type { RegattaEvent } from '@brt/engine';

export interface RegattaRow {
  id: string;
  name: string;
  officerPin: string;
  skipperPin: string;
  createdAt: number;
}

export interface StoredEvent {
  seq: number;
  at: number;
  event: RegattaEvent;
}

export interface CommandRecord {
  /** The answer given the first time, returned again for a resent command */
  result: { ok: true; seq: number } | { ok: false; error: { code: string; message: string } };
}

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS regattas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      officer_pin TEXT NOT NULL,
      skipper_pin TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      regatta_id TEXT NOT NULL REFERENCES regattas(id),
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      command_id TEXT,
      body TEXT NOT NULL,
      PRIMARY KEY (regatta_id, seq)
    );
    CREATE TABLE IF NOT EXISTS commands (
      regatta_id TEXT NOT NULL REFERENCES regattas(id),
      command_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY (regatta_id, command_id)
    );
  `);

  const insertEvent = db.prepare('INSERT INTO events (regatta_id, seq, at, command_id, body) VALUES (?, ?, ?, ?, ?)');
  const insertCommand = db.prepare('INSERT INTO commands (regatta_id, command_id, received_at, result) VALUES (?, ?, ?, ?)');

  return {
    db,

    createRegatta(name: string, now: number): RegattaRow {
      const id = randomBytes(4).toString('hex').toUpperCase();
      const officerPin = String(randomInt(0, 10_000)).padStart(4, '0');
      let skipperPin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      while (skipperPin.endsWith(officerPin)) skipperPin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare('INSERT INTO regattas (id, name, officer_pin, skipper_pin, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, officerPin, skipperPin, now);
      return { id, name, officerPin, skipperPin, createdAt: now };
    },

    getRegatta(id: string): RegattaRow | undefined {
      const r = db.prepare('SELECT id, name, officer_pin, skipper_pin, created_at FROM regattas WHERE id = ?').get(id) as any;
      return r ? { id: r.id, name: r.name, officerPin: r.officer_pin, skipperPin: r.skipper_pin, createdAt: r.created_at } : undefined;
    },

    events(regattaId: string, afterSeq = 0): StoredEvent[] {
      return (db.prepare('SELECT seq, at, body FROM events WHERE regatta_id = ? AND seq > ? ORDER BY seq').all(regattaId, afterSeq) as any[]).map((r) => ({
        seq: r.seq,
        at: r.at,
        event: JSON.parse(r.body),
      }));
    },

    command(regattaId: string, commandId: string): CommandRecord | undefined {
      const r = db.prepare('SELECT result FROM commands WHERE regatta_id = ? AND command_id = ?').get(regattaId, commandId) as any;
      return r ? { result: JSON.parse(r.result) } : undefined;
    },

    /** Events and the command that caused them are stored together, or not at all */
    append(regattaId: string, events: StoredEvent[], command?: { id: string; receivedAt: number; result: CommandRecord['result'] }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const e of events) insertEvent.run(regattaId, e.seq, e.at, command?.id ?? null, JSON.stringify(e.event));
        if (command) insertCommand.run(regattaId, command.id, command.receivedAt, JSON.stringify(command.result));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
