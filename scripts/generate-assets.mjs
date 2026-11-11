/**
 * Generates every icon and iOS launch screen from one vector design.
 *   node scripts/generate-assets.mjs
 * Requires Playwright (Chromium) to rasterise the SVG/HTML.
 */
import { createRequire } from 'node:module';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const ICONS = path.join(PUB, 'icons');
const SPLASH = path.join(PUB, 'splash');
const FONT_FILE = path.join(PUB, 'fonts', 'orbitron-latin-900-normal.woff2');

/** The mark: a neon stopwatch whose dial reads "10". Font-free so it renders anywhere. */
function mark({ mono = false } = {}) {
  const cyan = mono ? '#fff' : '#00f0ff';
  const gold = mono ? '#fff' : '#ffd23f';
  const mag = mono ? '#fff' : '#ff2bd6';
  const white = mono ? '#fff' : '#e8f6ff';
  return `
    <g filter="${mono ? '' : 'url(#glow)'}">
      <rect x="221" y="74" width="70" height="34" rx="12" fill="${cyan}"/>
      <rect x="244" y="104" width="24" height="34" rx="6" fill="${cyan}"/>
      <rect x="372" y="128" width="24" height="44" rx="8" fill="${cyan}" transform="rotate(45 384 150)"/>
      <circle cx="256" cy="290" r="150" fill="none" stroke="${cyan}" stroke-width="26"/>
      <path d="M256 166 A124 124 0 1 1 148.6 228" fill="none" stroke="${mag}" stroke-width="12" stroke-linecap="round" opacity=".9"/>
      <path d="M176 256 l30 -22 h14 v136 h-30 v-98 l-14 10z" fill="${white}"/>
      <rect x="250" y="234" width="92" height="136" rx="40" fill="none" stroke="${gold}" stroke-width="28"/>
    </g>`;
}

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#17173a"/><stop offset="1" stop-color="#07070d"/>
    </linearGradient>
    <radialGradient id="halo" cx=".5" cy=".55" r=".55">
      <stop offset="0" stop-color="#00f0ff" stop-opacity=".22"/><stop offset="1" stop-color="#00f0ff" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

const svg = (body, { bg = true, radius = 0 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs}
  ${bg ? `<rect width="512" height="512" rx="${radius}" fill="url(#bg)"/><rect width="512" height="512" rx="${radius}" fill="url(#halo)"/>` : ''}
  ${body}</svg>`;

// "any" icon: full-bleed square (platforms apply their own rounding).
const iconSvg = svg(`<g transform="translate(256 262) scale(.86) translate(-256 -262)">${mark()}</g>`);
// maskable: artwork inside the 80% safe zone so any mask shape keeps it intact.
const maskableSvg = svg(`<g transform="translate(256 262) scale(.76) translate(-256 -262)">${mark()}</g>`);
// in-app logo / favicon: transparent, rounded tile.
const logoSvg = svg(mark(), { bg: false });
const faviconSvg = svg(`<g transform="translate(256 262) scale(.9) translate(-256 -262)">${mark()}</g>`, { radius: 110 });
const monoSvg = svg(`<g transform="translate(256 262) scale(.76) translate(-256 -262)">${mark({ mono: true })}</g>`, { bg: false });

const ICON_SIZES = [48, 72, 96, 128, 144, 152, 192, 256, 384, 512];

// iOS launch screens: [device width px, height px, CSS width, CSS height, DPR]
const SPLASH_SIZES = [
  [1320, 2868, 440, 956, 3], [1206, 2622, 402, 874, 3], [1290, 2796, 430, 932, 3], [1179, 2556, 393, 852, 3],
  [1284, 2778, 428, 926, 3], [1170, 2532, 390, 844, 3], [1125, 2436, 375, 812, 3], [1242, 2688, 414, 896, 3],
  [828, 1792, 414, 896, 2], [1242, 2208, 414, 736, 3], [750, 1334, 375, 667, 2], [640, 1136, 320, 568, 2],
  [2048, 2732, 1024, 1366, 2], [1668, 2388, 834, 1194, 2], [1640, 2360, 820, 1180, 2], [1668, 2224, 834, 1112, 2],
  [1620, 2160, 810, 1080, 2], [1536, 2048, 768, 1024, 2], [1488, 2266, 744, 1133, 2],
];

async function main() {
  await mkdir(ICONS, { recursive: true });
  await mkdir(SPLASH, { recursive: true });
  await writeFile(path.join(ICONS, 'logo.svg'), logoSvg);
  await writeFile(path.join(ICONS, 'favicon.svg'), faviconSvg);

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  async function rasterise(markup, size, out, transparent = false) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">
      <div style="width:${size}px;height:${size}px">${markup.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</div></body></html>`);
    await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  }

  for (const s of ICON_SIZES) await rasterise(iconSvg, s, path.join(ICONS, `icon-${s}.png`));
  for (const s of [192, 512]) await rasterise(maskableSvg, s, path.join(ICONS, `maskable-${s}.png`));
  await rasterise(monoSvg, 512, path.join(ICONS, 'monochrome-512.png'), true);
  await rasterise(iconSvg, 180, path.join(ICONS, 'apple-touch-icon.png'));
  await rasterise(faviconSvg, 32, path.join(ICONS, 'favicon-32.png'), true);
  await rasterise(faviconSvg, 16, path.join(ICONS, 'favicon-16.png'), true);

  // Launch screens: rendered at CSS size × DPR so text and glow are crisp.
  // setContent pages are about:blank and cannot load file:// fonts, so inline the font.
  const FONT = 'data:font/woff2;base64,' + (await readFile(FONT_FILE)).toString('base64');
  const links = [];
  for (const [w, h, cw, ch, dpr] of SPLASH_SIZES) {
    const p = await browser.newPage({ viewport: { width: cw, height: ch }, deviceScaleFactor: dpr });
    const logo = Math.round(Math.min(cw, ch) * 0.34);
    await p.setContent(`<html><head><style>
      @font-face { font-family: O; src: url('${FONT}') format('woff2'); font-weight: 900; }
      html,body{margin:0;height:100%;background:#07070d}
      body{display:grid;place-content:center;justify-items:center;gap:${Math.round(logo * .16)}px;
        background: radial-gradient(80% 60% at 50% 42%, #12122a, #07070d)}
      .t{font:900 ${Math.round(logo * .17)}px/1 O;letter-spacing:.32em;padding-left:.32em;color:#e8f6ff;text-shadow:0 0 14px rgba(0,240,255,.7)}
      svg{width:${logo}px;height:${logo}px;filter:drop-shadow(0 0 24px rgba(0,240,255,.5))}
    </style></head><body>${logoSvg}<div class="t">TEN SECONDS</div></body></html>`);
    await p.evaluate(() => document.fonts.ready);
    const name = `splash-${w}x${h}.png`;
    await p.screenshot({ path: path.join(SPLASH, name) });
    await p.close();
    links.push(`  <link rel="apple-touch-startup-image" href="/splash/${name}" media="(device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)">`);
  }
  await browser.close();

  // Inject launch-screen tags into index.html between the markers.
  const indexPath = path.join(PUB, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const next = html.replace(/(<!-- SPLASH:START -->)[\s\S]*?(\s*<!-- SPLASH:END -->)/, `$1\n${links.join('\n')}$2`);
  await writeFile(indexPath, next);
  console.log(`Generated ${ICON_SIZES.length + 7} icons and ${SPLASH_SIZES.length} launch screens.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
