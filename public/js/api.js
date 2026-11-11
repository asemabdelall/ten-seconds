/** Network helpers for the online leaderboard. */

export const RESULTS_ENDPOINT = '/api/results';

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** Top results. Throws on network failure so callers can show the offline state. */
export async function fetchLeaderboard(limit = 50, playerId = '') {
  const q = new URLSearchParams({ limit: String(limit) });
  if (playerId) q.set('player', playerId);
  const res = await fetchWithTimeout(`/api/leaderboard?${q}`);
  if (!res.ok) throw new Error(`Leaderboard unavailable (HTTP ${res.status})`);
  return res.json();
}

/** Cheap reachability check: navigator.onLine alone can report "online" on captive / dead networks. */
export async function serverReachable() {
  if (!navigator.onLine) return false;
  try {
    const res = await fetchWithTimeout('/api/health', {}, 4000);
    return res.ok;
  } catch {
    return false;
  }
}
