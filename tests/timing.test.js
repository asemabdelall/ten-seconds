import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, timeParts, evaluate, formatDelta, TARGET_MS } from '../public/js/timing.js';

test('display convention SS:CC:XX from the spec', () => {
  assert.equal(formatTime(0), '00:00:00');
  assert.equal(formatTime(5000), '05:00:00');
  assert.equal(formatTime(9999.9), '09:99:99');
  assert.equal(formatTime(10000), '10:00:00');
});

test('sections: seconds, centiseconds, then ms + 1/10000 s digits', () => {
  assert.deepEqual(timeParts(1234.5), { ss: 1, cc: 23, xx: 45 });
  assert.equal(formatTime(7_089.1), '07:08:91');
  assert.equal(formatTime(12_345.6789), '12:34:56');
});

test('display truncates: never shows 10:00:00 before 10 000 ms', () => {
  assert.equal(formatTime(9999.99), '09:99:99');
  assert.equal(formatTime(9999.999999), '09:99:99');
  assert.equal(formatTime(10000.04), '10:00:00');
});

test('float noise does not drop a unit', () => {
  assert.equal(formatTime(0.1 + 0.2), '00:00:03');
  assert.equal(formatTime(4999.999999999999), '05:00:00');
});

test('clamps negatives, NaN and overflow', () => {
  assert.equal(formatTime(-5), '00:00:00');
  assert.equal(formatTime(NaN), '00:00:00');
  assert.equal(formatTime(1e9), '99:99:99');
});

test('perfect is decided from raw elapsed time, not the display', () => {
  assert.equal(evaluate(10000).perfect, true);
  assert.equal(evaluate(10000.4).perfect, true);
  assert.equal(evaluate(9999.6).perfect, true);
  // The verdict uses the raw value: 09:99:96 on screen is still within 0.5 ms...
  assert.equal(formatTime(9999.6), '09:99:96');
  // ...and 0.5 ms or more away is not perfect, whatever is displayed.
  assert.equal(formatTime(10000.5), '10:00:05');
  assert.equal(evaluate(10000.5).perfect, false);
  assert.equal(evaluate(10000.9).perfect, false);
  assert.equal(evaluate(9999.5).perfect, false);
});

test('tiers and signed delta', () => {
  assert.equal(evaluate(10008).tier, 'inhuman');
  assert.equal(evaluate(9975).tier, 'incredible');
  assert.equal(evaluate(10090).tier, 'great');
  assert.equal(evaluate(9800).tier, 'good');
  assert.equal(evaluate(10400).tier, 'close');
  assert.equal(evaluate(8000).tier, 'early');
  assert.equal(evaluate(12000).tier, 'late');
  assert.equal(evaluate(10012.3456).deltaMs.toFixed(4), '12.3456');
  assert.equal(formatDelta(12.3456), '+12.346 ms');
  assert.equal(formatDelta(-1500), '−1.500 s');
  assert.equal(TARGET_MS, 10000);
});

test('evaluate rejects invalid input', () => {
  assert.throws(() => evaluate(-1));
  assert.throws(() => evaluate(Infinity));
});
