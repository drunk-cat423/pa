import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_IDLE_MS,
  MEMORY_MAX_WAIT_MS,
  memoryScheduleDue,
  noteMemoryContent,
  resetMemorySchedule,
} from '../dist/memory-schedule.js';

test('starts on the first content event and refreshes only the idle marker', () => {
  let window = noteMemoryContent(undefined, 100);
  assert.deepEqual(window, { firstContentAt: 100, lastContentAt: 100 });
  window = noteMemoryContent(window, 200);
  assert.deepEqual(window, { firstContentAt: 100, lastContentAt: 200 });
});

test('triggers at exact idle and maximum-wait boundaries', () => {
  const idle = { firstContentAt: 10, lastContentAt: 20 };
  assert.equal(memoryScheduleDue(idle, 20 + MEMORY_IDLE_MS - 1), undefined);
  assert.equal(memoryScheduleDue(idle, 20 + MEMORY_IDLE_MS), 'idle');

  const interval = { firstContentAt: 10, lastContentAt: 10 + MEMORY_MAX_WAIT_MS - 1 };
  assert.equal(memoryScheduleDue(interval, 10 + MEMORY_MAX_WAIT_MS - 1), undefined);
  assert.equal(memoryScheduleDue(interval, 10 + MEMORY_MAX_WAIT_MS), 'interval');
});

test('reports the earliest deadline once when idle and interval deadlines are both passed', () => {
  const window = { firstContentAt: 0, lastContentAt: 0 };
  assert.equal(memoryScheduleDue(window, MEMORY_MAX_WAIT_MS + MEMORY_IDLE_MS), 'idle');
  const reset = resetMemorySchedule();
  assert.equal(reset, undefined);
  assert.equal(memoryScheduleDue(reset, MEMORY_MAX_WAIT_MS + MEMORY_IDLE_MS), undefined);
});

test('continuous content refreshes idle timing without extending the 30 minute cap', () => {
  let window = noteMemoryContent(undefined, 0);
  for (let now = MEMORY_IDLE_MS - 1; now < MEMORY_MAX_WAIT_MS; now += MEMORY_IDLE_MS - 1) {
    window = noteMemoryContent(window, now);
    assert.equal(memoryScheduleDue(window, now), undefined);
  }
  assert.equal(window.firstContentAt, 0);
  assert.equal(memoryScheduleDue(window, MEMORY_MAX_WAIT_MS), 'interval');
});

test('polling without content does not create or refresh a schedule', () => {
  assert.equal(memoryScheduleDue(undefined, 0), undefined);
  const window = { firstContentAt: 0, lastContentAt: 0 };
  assert.equal(memoryScheduleDue(window, MEMORY_IDLE_MS - 1), undefined);
  assert.deepEqual(window, { firstContentAt: 0, lastContentAt: 0 });
  assert.equal(memoryScheduleDue(undefined, MEMORY_IDLE_MS * 10), undefined);
});

test('a backwards clock does not trigger or move either content marker', () => {
  const window = { firstContentAt: 100, lastContentAt: 200 };
  assert.deepEqual(noteMemoryContent(window, 150), window);
  assert.equal(memoryScheduleDue(window, 150), undefined);
  assert.equal(memoryScheduleDue(window, 100), undefined);
});

test('rejects invalid times and ignores invalid windows for due checks', () => {
  const valid = { firstContentAt: 10, lastContentAt: 10 };
  for (const now of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => noteMemoryContent(valid, now), RangeError);
    assert.equal(memoryScheduleDue(valid, now), undefined);
  }
  assert.equal(memoryScheduleDue({ firstContentAt: -1, lastContentAt: 0 }, MEMORY_IDLE_MS), undefined);
  assert.equal(memoryScheduleDue({ firstContentAt: 10, lastContentAt: 9 }, MEMORY_IDLE_MS), undefined);
});
