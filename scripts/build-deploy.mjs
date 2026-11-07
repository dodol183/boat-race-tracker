// Builds the cPanel package: deploy-out/boat-race-tracker-cpanel.zip
//
//   app.js        startup file for cPanel's "Setup Node.js App" (checks, then starts the server)
//   server.mjs    the server and race engine in one file: no npm install on the host
//   public/       the website (the app's build)
//   package.json  no dependencies; says Node 22.13+
//   tmp/restart.txt   extracting an update restarts the app
//   DEPLOY.md     the steps
//
// Run after `npm run build` (the app); `npm run deploy:build` does both.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'deploy-out', 'boat-race-tracker');
const zip = path.join(root, 'deploy-out', 'boat-race-tracker-cpanel.zip');
const appDist = path.join(root, 'packages', 'app', 'dist');

if (!fs.existsSync(path.join(appDist, 'index.html'))) {
  console.error('No app build: run `npm run build` first.');
  process.exit(1);
}

let version = 'dev';
try {
  version = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch {}
version = process.env.BRT_VERSION || version;

fs.rmSync(path.join(root, 'deploy-out'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'packages', 'server', 'src', 'main.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws loads these if present, for speed; it works without them
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS and uses require(); give the ES module one
  banner: { js: "import { createRequire as __brtRequire } from 'node:module'; const require = __brtRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

fs.cpSync(appDist, path.join(out, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'deploy', 'app.js'), path.join(out, 'app.js'));
fs.copyFileSync(path.join(root, 'docs', 'DEPLOY_CPANEL.md'), path.join(out, 'DEPLOY.md'));
fs.writeFileSync(path.join(out, 'tmp', 'restart.txt'), `${version} ${new Date().toISOString()}\n`);
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'boat-race-tracker',
      version: '0.1.0',
      private: true,
      description: 'Boat Race Tracker server and website. No dependencies to install.',
      main: 'app.js',
      scripts: { start: 'node app.js' },
      engines: { node: '>=22.13' },
    },
    null,
    2
  ) + '\n'
);

// Zipped with the files at the top level, ready to extract into the application root
execSync(`cd "${out}" && zip -qr "${zip}" .`);
const kb = Math.round(fs.statSync(zip).size / 1024);
console.log(`Built ${path.relative(root, zip)} (${kb} KB), version ${version}`);
