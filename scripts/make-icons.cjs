// Renders the app icon (packages/app/assets/icon-foreground.svg) to every size Android and the
// website need: launcher icons (square and round), adaptive-icon foregrounds, splash screens, and
// the favicon. Run with Playwright available: node scripts/make-icons.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'packages/app');
const res = path.join(app, 'android/app/src/main/res');
const NAVY = '#0b2545';
const fg = fs.readFileSync(path.join(app, 'assets/icon-foreground.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const inner = fg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

/** The whole icon: navy shape behind the artwork */
const full = (shape) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${
    shape === 'circle' ? `<circle cx="54" cy="54" r="54" fill="${NAVY}"/>` : `<rect width="108" height="108" rx="22" fill="${NAVY}"/>`
  }<g transform="translate(54 54) scale(1.25) translate(-54 -54)">${inner}</g></svg>`;

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (svg, w, h, file, background = 'transparent') => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<html><body style="margin:0;background:${background}">${svg.replace('<svg ', `<svg width="${w}" height="${h}" `)}</body></html>`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: background === 'transparent' });
  };

  for (const [d, k] of Object.entries(DENSITIES)) {
    await render(full('square'), 48 * k, 48 * k, path.join(res, `mipmap-${d}/ic_launcher.png`));
    await render(full('circle'), 48 * k, 48 * k, path.join(res, `mipmap-${d}/ic_launcher_round.png`));
    await render(fg, 108 * k, 108 * k, path.join(res, `mipmap-${d}/ic_launcher_foreground.png`));
  }

  // Splash screens, at the sizes the Android project already has
  const { execSync } = require('node:child_process');
  const splashes = execSync(`find "${res}" -name splash.png`).toString().trim().split('\n');
  for (const file of splashes) {
    const [w, h] = sizeOf(file);
    const side = Math.round(Math.min(w, h) * 0.45);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${NAVY}"/>
      <svg x="${(w - side) / 2}" y="${(h - side) / 2 - side * 0.12}" width="${side}" height="${side}" viewBox="0 0 108 108">${inner}</svg>
      <text x="${w / 2}" y="${(h + side) / 2 + side * 0.08}" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="${Math.round(side * 0.13)}" fill="#ffffff">Boat Race Tracker</text></svg>`;
    await render(svg, w, h, file, NAVY);
  }

  // Website
  fs.writeFileSync(path.join(app, 'public/icon.svg'), full('square') + '\n');
  await render(full('square'), 180, 180, path.join(app, 'public/apple-touch-icon.png'));
  await render(full('square'), 512, 512, path.join(app, 'public/icon-512.png'));
  await browser.close();
  console.log(`icons: ${Object.keys(DENSITIES).length * 3} launcher files, ${splashes.length} splash screens, favicon`);
})();

/** Width and height of a PNG, from its header */
function sizeOf(file) {
  const b = fs.readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
