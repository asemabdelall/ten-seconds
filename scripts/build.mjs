/** Vercel build: copy public/ to dist/ and stamp sw.js with the content hash. */
import { cp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHash } from '../lib/build-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

await rm(DIST, { recursive: true, force: true });
await cp(PUB, DIST, { recursive: true });
const hash = await buildHash(PUB);
const sw = path.join(DIST, 'sw.js');
await writeFile(sw, (await readFile(sw, 'utf8')).replace('__BUILD_HASH__', hash));
console.log(`Built dist/ (sw ${hash})`);
