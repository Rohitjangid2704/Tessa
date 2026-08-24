export const FALLBACK_TIME_ZONE = "UTC";

const COMPONENT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat(undefined, { ...COMPONENT_OPTIONS, timeZone });
  formatters.set(timeZone, created);
  return created;
}

export function formatInTimeZone(iso: string | null | undefined, timeZone: string): string | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) {
    return null;
  }
  const zone = isValidTimeZone(timeZone) ? timeZone.trim() : FALLBACK_TIME_ZONE;
  return formatterFor(zone).format(moment);
}

export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
