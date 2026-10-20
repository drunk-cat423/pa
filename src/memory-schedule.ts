export const MEMORY_IDLE_MS = 600_000;
export const MEMORY_MAX_WAIT_MS = 1_800_000;

export interface MemoryScheduleWindow {
  firstContentAt: number;
  lastContentAt: number;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validWindow(window: MemoryScheduleWindow): boolean {
  return window !== null && typeof window === 'object' &&
    validTimestamp(window.firstContentAt) && validTimestamp(window.lastContentAt) &&
    window.lastContentAt >= window.firstContentAt;
}

export function noteMemoryContent(
  window: MemoryScheduleWindow | undefined,
  now: number,
): MemoryScheduleWindow {
  if (!validTimestamp(now)) throw new RangeError('now must be a non-negative safe integer');

  if (!window || !validWindow(window)) {
    return { firstContentAt: now, lastContentAt: now };
  }

  // A backwards clock observation is not new elapsed time and must not move either marker.
  if (now < window.lastContentAt || now < window.firstContentAt) return window;
  return { firstContentAt: window.firstContentAt, lastContentAt: now };
}

export function memoryScheduleDue(
  window: MemoryScheduleWindow | undefined,
  now: number,
): 'idle' | 'interval' | undefined {
  if (!window || !validWindow(window) || !validTimestamp(now) || now < window.firstContentAt || now < window.lastContentAt) {
    return undefined;
  }

  const idleElapsed = now - window.lastContentAt;
  const intervalElapsed = now - window.firstContentAt;
  const idleDue = idleElapsed >= MEMORY_IDLE_MS;
  const intervalDue = intervalElapsed >= MEMORY_MAX_WAIT_MS;
  if (idleDue && intervalDue) {
    return window.lastContentAt - window.firstContentAt <= MEMORY_MAX_WAIT_MS - MEMORY_IDLE_MS
      ? 'idle'
      : 'interval';
  }
  if (intervalDue) return 'interval';
  if (idleDue) return 'idle';
  return undefined;
}

export function resetMemorySchedule(): undefined {
  return undefined;
}
