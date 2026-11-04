export const TRENDING_SEND_TIME = '08:50';
export const TRENDING_CATCHUP_MS = 60 * 60_000;

export function trendingDueAt(day: string): number {
  return Date.parse(`${day}T${TRENDING_SEND_TIME}:00+08:00`);
}
