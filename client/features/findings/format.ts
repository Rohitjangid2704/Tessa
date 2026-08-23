const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MAX_RELATIVE_DAYS = 30;

export function formatRelativeAge(timestampMs: number, nowMs: number): string | null {
  const seconds = Math.floor((nowMs - timestampMs) / MS_PER_SECOND);
  if (seconds < 0) {
    return "just now";
  }
  if (seconds < SECONDS_PER_MINUTE) {
    return "just now";
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  return days <= MAX_RELATIVE_DAYS ? `${days} d ago` : null;
}

export function formatOccurrenceCount(count: number): string {
  return count > 999 ? "999+" : String(count);
}
