export type CronParseResult =
  | { ok: true; cron: ParsedCron }
  | { ok: false; message: string };

export interface ParsedCron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  wildcardMax: number;
  aliases: Readonly<Record<string, number>>;
  sundayIsSeven?: boolean;
}

const MONTH_ALIASES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59, wildcardMax: 59, aliases: {} },
  { name: "hour", min: 0, max: 23, wildcardMax: 23, aliases: {} },
  { name: "day of month", min: 1, max: 31, wildcardMax: 31, aliases: {} },
  { name: "month", min: 1, max: 12, wildcardMax: 12, aliases: MONTH_ALIASES },
  {
    name: "day of week",
    min: 0,
    max: 7,
    wildcardMax: 6,
    aliases: WEEKDAY_ALIASES,
    sundayIsSeven: true,
  },
];

const FIELD_COUNT_MESSAGE =
  "A cron expression has 5 fields: minute, hour, day of month, month and day of week";
const WEEKDAY_SUNDAY_ALIAS = 7;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const SEARCH_STEP_LIMIT = 200_000;
const WHOLE_NUMBER = /^\d+$/;

function readValue(text: string, spec: FieldSpec): number | string {
  const alias = spec.aliases[text.toLowerCase()];
  if (alias !== undefined) {
    return alias;
  }
  if (!WHOLE_NUMBER.test(text)) {
    return `The ${spec.name} field has an unreadable value '${text}'`;
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    return `The ${spec.name} field takes values from ${spec.min} to ${spec.max}, got ${value}`;
  }
  return value;
}

function readToken(token: string, spec: FieldSpec): number[] | string {
  const [rangeText = "", stepText, ...extra] = token.split("/");
  if (extra.length > 0 || rangeText === "") {
    return `The ${spec.name} field has an unreadable part '${token}'`;
  }
  let step = 1;
  if (stepText !== undefined) {
    if (!WHOLE_NUMBER.test(stepText) || Number(stepText) < 1) {
      return `The ${spec.name} field has an invalid step '${stepText}'`;
    }
    step = Number(stepText);
  }
  let start: number;
  let end: number;
  if (rangeText === "*") {
    start = spec.min;
    end = spec.wildcardMax;
  } else {
    const [firstText = "", secondText, ...surplus] = rangeText.split("-");
    if (surplus.length > 0) {
      return `The ${spec.name} field has an unreadable range '${rangeText}'`;
    }
    const first = readValue(firstText, spec);
    if (typeof first === "string") {
      return first;
    }
    start = first;
    if (secondText === undefined) {
      end = stepText === undefined ? first : spec.max;
    } else {
      const second = readValue(secondText, spec);
      if (typeof second === "string") {
        return second;
      }
      end = second;
    }
    if (start > end) {
      return `The ${spec.name} field has a range that runs backwards '${rangeText}'`;
    }
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function readField(text: string, spec: FieldSpec): Set<number> | string {
  const values = new Set<number>();
  for (const token of text.split(",")) {
    const read = readToken(token, spec);
    if (typeof read === "string") {
      return read;
    }
    for (const value of read) {
      values.add(spec.sundayIsSeven === true && value === WEEKDAY_SUNDAY_ALIAS ? 0 : value);
    }
  }
  return values;
}

export function parseCron(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELD_SPECS.length || fields.some((field) => field === "")) {
    return { ok: false, message: FIELD_COUNT_MESSAGE };
  }
  const sets: Array<Set<number>> = [];
  for (const [index, spec] of FIELD_SPECS.entries()) {
    const read = readField(fields[index] ?? "", spec);
    if (typeof read === "string") {
      return { ok: false, message: read };
    }
    sets.push(read);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets;
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    daysOfWeek === undefined
  ) {
    return { ok: false, message: FIELD_COUNT_MESSAGE };
  }
  return {
    ok: true,
    cron: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      dayOfMonthRestricted: fields[2] !== "*",
      dayOfWeekRestricted: fields[4] !== "*",
    },
  };
}

export function validateCron(expression: string): string | null {
  const parsed = parseCron(expression);
  return parsed.ok ? null : parsed.message;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface LocalMinute {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  formatters.set(timeZone, created);
  return created;
}

function localMinute(instantMs: number, timeZone: string): LocalMinute {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    weekday: WEEKDAY_ALIASES[read("weekday").slice(0, 3).toLowerCase()] ?? 0,
  };
}

function dayMatches(cron: ParsedCron, local: LocalMinute): boolean {
  const dayOfMonth = cron.daysOfMonth.has(local.day);
  const dayOfWeek = cron.daysOfWeek.has(local.weekday);
  return cron.dayOfMonthRestricted && cron.dayOfWeekRestricted
    ? dayOfMonth || dayOfWeek
    : dayOfMonth && dayOfWeek;
}

export function nextRunAfter(cron: ParsedCron, timeZone: string, after: Date): Date | null {
  let candidate = (Math.floor(after.getTime() / MINUTE_MS) + 1) * MINUTE_MS;
  for (let step = 0; step < SEARCH_STEP_LIMIT; step += 1) {
    const local = localMinute(candidate, timeZone);
    if (!cron.months.has(local.month) || !dayMatches(cron, local)) {
      const intoDay = local.hour * MINUTES_PER_HOUR + local.minute;
      const skip = Math.max(1, MINUTES_PER_DAY - intoDay - MINUTES_PER_HOUR);
      candidate += skip * MINUTE_MS;
    } else if (!cron.hours.has(local.hour)) {
      candidate += (MINUTES_PER_HOUR - local.minute) * MINUTE_MS;
    } else if (!cron.minutes.has(local.minute)) {
      candidate += MINUTE_MS;
    } else {
      return new Date(candidate);
    }
  }
  return null;
}

export function nextCronRun(expression: string, timeZone: string, after: Date): Date | null {
  const parsed = parseCron(expression);
  if (!parsed.ok || !isValidTimeZone(timeZone)) {
    return null;
  }
  return nextRunAfter(parsed.cron, timeZone, after);
}
