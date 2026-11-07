// Starts the server from environment settings.
//   PORT          (default 3000; cPanel sets it)
//   DATA_DIR      folder for the SQLite file (outside public_html in production)
//   ADMIN_TOKEN   needed to create regattas; the server won't start without one
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

const server = await startServer({
  port: Number(process.env.PORT) || 3000,
  dbPath: path.join(dataDir, 'regattas.db'),
  adminToken,
});
console.log(`Boat Race Tracker server on port ${server.port}, data in ${dataDir}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
