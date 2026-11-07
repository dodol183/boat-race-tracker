// Starts the server from environment settings.
//   PORT          (default 3000; cPanel sets it)
//   DATA_DIR      folder for the SQLite file (outside public_html in production)
//   ADMIN_TOKEN   needed to create regattas; the server won't start without one
//   STATIC_DIR    the built app (default: packages/app/dist next to this package)
// A copy of the database is kept in DATA_DIR/backups, one per weekday.
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './server.ts';

const adminToken = (process.env.ADMIN_TOKEN ?? '').trim();
if (adminToken.length < 16) {
  console.error('Set ADMIN_TOKEN (at least 16 characters) before starting the server.');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const staticDir = process.env.STATIC_DIR ?? path.resolve(import.meta.dirname, '../../app/dist');
if (!fs.existsSync(path.join(staticDir, 'index.html'))) console.warn(`No app build in ${staticDir}: run npm run build. The API still works.`);

// cPanel's app runner (Phusion Passenger) hands the app a socket called 'passenger'; LiteSpeed's
// may pass a socket path in PORT; anywhere else, a port number
const listenOn: number | string =
  typeof (globalThis as { PhusionPassenger?: unknown }).PhusionPassenger !== 'undefined'
    ? 'passenger'
    : process.env.PORT && !/^\d+$/.test(process.env.PORT)
      ? process.env.PORT
      : Number(process.env.PORT) || 3000;

const server = await startServer({
  port: listenOn,
  dbPath: path.join(dataDir, 'regattas.db'),
  adminToken,
  staticDir,
  backupDir: path.join(dataDir, 'backups'),
});
console.log(`Boat Race Tracker server (Node ${process.version}) listening on ${server.port}, data in ${dataDir}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
