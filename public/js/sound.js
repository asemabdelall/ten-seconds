/** Tiny synthesized arcade sounds (no audio files, so nothing extra to cache). */
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('ten.muted') === '1'; } catch { /* storage unavailable */ }

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('ten.muted', muted ? '1' : '0'); } catch { /* ignore */ }
}

/** Must be called from a user gesture (iOS requires it to unlock audio). */
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, start, dur, type = 'square', gain = 0.06) {
  if (muted || !ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  start() { tone(660, 0, 0.09); tone(990, 0.07, 0.12); },
  stop() { tone(440, 0, 0.12, 'triangle', 0.09); },
  good() { [523, 659, 784].forEach((f, i) => tone(f, i * 0.08, 0.14)); },
  miss() { tone(220, 0, 0.18, 'sawtooth', 0.05); tone(165, 0.14, 0.25, 'sawtooth', 0.05); },
  perfect() { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.18, 'square', 0.07)); },
};
