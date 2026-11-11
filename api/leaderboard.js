import { getLeaderboard } from '../lib/supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const player = UUID_RE.test(req.query.player || '') ? req.query.player : null;
  try {
    res.status(200).json(await getLeaderboard(limit, player));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Leaderboard unavailable' });
  }
}
