import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Hash of every app file (excluding launch screens/screenshots), stamped into sw.js. */
export async function buildHash(publicDir) {
  const h = createHash('sha256');
  async function walk(dir) {
    for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!['splash', 'screenshots'].includes(ent.name)) await walk(p); }
      else { h.update(path.relative(publicDir, p)); h.update(await readFile(p)); }
    }
  }
  await walk(publicDir);
  return h.digest('hex').slice(0, 12);
}
