import { submitResult } from '../lib/supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const b = req.body && typeof req.body === 'object' ? req.body : null;
  if (!b || !UUID_RE.test(b.clientId || '') || !UUID_RE.test(b.playerId || '') ||
      typeof b.name !== 'string' || typeof b.elapsedMs !== 'number' || !Number.isFinite(b.elapsedMs) ||
      typeof b.playedAt !== 'number' || !Number.isFinite(b.playedAt)) {
    return res.status(422).json({ error: 'Invalid body' });
  }
  try {
    // The database validates, de-duplicates by clientId and re-computes "perfect".
    const { status = 500, ...body } = await submitResult(b);
    res.status(status).json(body);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not store result, try again later' });
  }
}
