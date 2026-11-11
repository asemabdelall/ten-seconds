/** Leaderboard storage for the Vercel deployment: Supabase RPCs (see supabase/migrations). */
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY; // publishable key; the RPCs validate everything

async function rpc(fn, args) {
  if (!URL_ || !KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY not configured');
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase ${fn} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export const getLeaderboard = (limit, player) => rpc('get_leaderboard', { p_limit: limit, p_player: player || null });
export const submitResult = (r) => rpc('submit_result', {
  p_client_id: r.clientId, p_player_id: r.playerId, p_name: r.name, p_elapsed_ms: r.elapsedMs, p_played_at: Math.round(r.playedAt),
});
