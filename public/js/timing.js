/**
 * Timing core: pure functions, shared by the browser game, the server and the tests.
 *
 * Display convention  SS:CC:XX
 *   SS  whole seconds                     (00–99)
 *   CC  centiseconds, 1/100 s             (00–99)
 *   XX  the next two decimal places, i.e. the millisecond digit followed by the
 *       1/10 000 s digit                  (00–99)
 *
 *   00:00:00  zero
 *   05:00:00  five seconds
 *   09:99:99  9.9999 s, almost ten seconds
 *   10:00:00  exactly ten seconds
 *
 * The display is always TRUNCATED (never rounded up), so it can only show
 * 10:00:00 once the real elapsed time has actually reached 10 000 ms.
 *
 * Scoring never looks at the formatted string. It is computed from the raw
 * elapsed milliseconds measured with performance.now() / event.timeStamp.
 */

export const TARGET_MS = 10_000;

/**
 * PERFECT means the raw elapsed time equals 10 000 ms at millisecond precision:
 * |elapsed - 10 000| < 0.5 ms. Browsers deliberately coarsen high-resolution
 * timers (Safari and Firefox report 1 ms steps, Chrome ~0.1 ms), so this is the
 * finest tolerance that is achievable on every engine.
 */
export const PERFECT_TOLERANCE_MS = 0.5;

/** The run auto-ends (as "too late") if the player never stops the clock. */
export const MAX_RUN_MS = 30_000;

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/** Split milliseconds into display parts. Truncates; clamps to 0…99.9999 s. */
export function timeParts(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  // Work in integer units of 1/10 000 s. The tiny epsilon absorbs binary float
  // noise such as 4999.999999999999 while staying far below one display unit.
  let units = Math.floor(ms * 10 + 1e-6);
  const max = 99 * 10_000 + 9_999;
  if (units > max) units = max;
  return {
    ss: Math.floor(units / 10_000),
    cc: Math.floor(units / 100) % 100,
    xx: units % 100,
  };
}

/** Format milliseconds as SS:CC:XX. */
export function formatTime(ms) {
  const { ss, cc, xx } = timeParts(ms);
  return `${pad2(ss)}:${pad2(cc)}:${pad2(xx)}`;
}

/** Signed difference from the target, e.g. "+12.345 ms", "−0.250 s". */
export function formatDelta(deltaMs) {
  if (!Number.isFinite(deltaMs)) return '';
  const sign = deltaMs > 0 ? '+' : deltaMs < 0 ? '−' : '±';
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return `${sign}${abs.toFixed(3)} ms`;
  return `${sign}${(abs / 1000).toFixed(3)} s`;
}

const TIERS = [
  { max: 10, key: 'inhuman', label: 'INHUMAN' },
  { max: 30, key: 'incredible', label: 'INCREDIBLE' },
  { max: 100, key: 'great', label: 'GREAT' },
  { max: 250, key: 'good', label: 'GOOD' },
  { max: 500, key: 'close', label: 'CLOSE' },
];

/**
 * Evaluate a run from the RAW elapsed time (never from the display string).
 * @param {number} elapsedMs
 */
export function evaluate(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError('elapsedMs must be a finite, non-negative number');
  }
  const deltaMs = elapsedMs - TARGET_MS;
  const absDeltaMs = Math.abs(deltaMs);
  const perfect = absDeltaMs < PERFECT_TOLERANCE_MS;

  let tier;
  if (perfect) tier = { key: 'perfect', label: 'PERFECT' };
  else tier = TIERS.find((t) => absDeltaMs <= t.max) ||
    (deltaMs < 0 ? { key: 'early', label: 'TOO EARLY' } : { key: 'late', label: 'TOO LATE' });

  return {
    elapsedMs,
    deltaMs,
    absDeltaMs,
    perfect,
    tier: tier.key,
    label: tier.label,
    display: formatTime(elapsedMs),
  };
}
