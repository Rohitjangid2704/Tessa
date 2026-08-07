import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

CRON_FIELD_COUNT = 5
SEARCH_HORIZON_DAYS = 366 * 8
MAX_TIMEZONE_LENGTH = 64
TIMEZONE_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+)*$")
WILDCARD = "*"
MONTH_NAMES = {
    name: number
    for number, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1
    )
}
WEEKDAY_NAMES = {
    name: number for number, name in enumerate(("sun", "mon", "tue", "wed", "thu", "fri", "sat"))
}
NO_NAMES: dict[str, int] = {}


class CronError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class FieldRule:
    label: str
    low: int
    high: int
    names: dict[str, int]
    hint: str = ""


MINUTE_RULE = FieldRule("minute", 0, 59, NO_NAMES)
HOUR_RULE = FieldRule("hour", 0, 23, NO_NAMES)
DAY_OF_MONTH_RULE = FieldRule("day of month", 1, 31, NO_NAMES)
MONTH_RULE = FieldRule("month", 1, 12, MONTH_NAMES)
DAY_OF_WEEK_RULE = FieldRule("day of week", 0, 6, WEEKDAY_NAMES, "; Sunday is 0, not 7")
FIELD_RULES = (MINUTE_RULE, HOUR_RULE, DAY_OF_MONTH_RULE, MONTH_RULE, DAY_OF_WEEK_RULE)


@dataclass(frozen=True, slots=True)
class CronSchedule:
    minutes: tuple[int, ...]
    hours: tuple[int, ...]
    days_of_month: frozenset[int]
    months: frozenset[int]
    days_of_week: frozenset[int]
    fields: tuple[str, ...]

    def matches_day(self, day: date) -> bool:
        return (
            day.month in self.months
            and day.day in self.days_of_month
            and day.isoweekday() % 7 in self.days_of_week
        )

    @property
    def canonical(self) -> str:
        return " ".join(self.fields)


def invalid_cron(message: str) -> CronError:
    return CronError("invalid_cron", message)


def parse_value(text: str, rule: FieldRule) -> int:
    lowered = text.lower()
    if lowered in rule.names:
        return rule.names[lowered]
    if not text.isascii() or not text.isdigit():
        raise invalid_cron(f"{rule.label} value {text!r} is not a number or a known name")
    value = int(text)
    if not rule.low <= value <= rule.high:
        raise invalid_cron(
            f"{rule.label} must be between {rule.low} and {rule.high}, got {value}{rule.hint}"
        )
    return value


def parse_step(text: str, rule: FieldRule) -> int:
    if not text.isascii() or not text.isdigit() or int(text) < 1:
        raise invalid_cron(f"{rule.label} step {text!r} must be a positive whole number")
    return int(text)


def parse_part(part: str, rule: FieldRule) -> set[int]:
    if not part:
        raise invalid_cron(f"{rule.label} has an empty list entry")
    base, separator, step_text = part.partition("/")
    step = parse_step(step_text, rule) if separator else 1
    if base == WILDCARD:
        return set(range(rule.low, rule.high + 1, step))
    first_text, dash, last_text = base.partition("-")
    if not first_text or (dash and not last_text):
        raise invalid_cron(f"{rule.label} value {base!r} is malformed")
    first = parse_value(first_text, rule)
    if not dash:
        if separator:
            raise invalid_cron(
                f"{rule.label} step needs a range or *, write {first_text}-{rule.high}/{step_text}"
            )
        return {first}
    last = parse_value(last_text, rule)
    if last < first:
        raise invalid_cron(f"{rule.label} range {base!r} runs backwards")
    return set(range(first, last + 1, step))


def parse_field(text: str, rule: FieldRule) -> frozenset[int]:
    values: set[int] = set()
    for part in text.split(","):
        values |= parse_part(part, rule)
    return frozenset(values)


def canonical_field(text: str, values: frozenset[int]) -> str:
    if text == WILDCARD:
        return WILDCARD
    return ",".join(str(value) for value in sorted(values))


def parse_cron(expression: str) -> CronSchedule:
    parts = expression.split()
    if len(parts) != CRON_FIELD_COUNT:
        raise invalid_cron(
            f"a cron has five fields: minute hour day-of-month month day-of-week, got {len(parts)}"
        )
    parsed = [parse_field(text, rule) for text, rule in zip(parts, FIELD_RULES, strict=True)]
    if parts[2] != WILDCARD and parts[4] != WILDCARD:
        raise invalid_cron(
            "day of month and day of week cannot both be restricted; use one of them and *"
        )
    fields = tuple(
        canonical_field(text, values) for text, values in zip(parts, parsed, strict=True)
    )
    return CronSchedule(
        minutes=tuple(sorted(parsed[0])),
        hours=tuple(sorted(parsed[1])),
        days_of_month=parsed[2],
        months=parsed[3],
        days_of_week=parsed[4],
        fields=fields,
    )


def load_timezone(name: str) -> ZoneInfo:
    if len(name) > MAX_TIMEZONE_LENGTH or not TIMEZONE_NAME_PATTERN.match(name):
        raise CronError("invalid_timezone", f"{name!r} is not an IANA time zone name")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise CronError("invalid_timezone", f"{name!r} is not an IANA time zone name") from None


def resolve_local_time(naive: datetime, zone: ZoneInfo) -> datetime | None:
    aware = naive.replace(tzinfo=zone)
    roundtrip = aware.astimezone(UTC).astimezone(zone).replace(tzinfo=None)
    return aware if roundtrip == naive else None


def next_fire_time(schedule: CronSchedule, zone: ZoneInfo, after: datetime) -> datetime | None:
    first_day = after.astimezone(zone).date()
    for offset in range(SEARCH_HORIZON_DAYS):
        day = first_day + timedelta(days=offset)
        if not schedule.matches_day(day):
            continue
        for hour in schedule.hours:
            for minute in schedule.minutes:
                moment = resolve_local_time(datetime.combine(day, time(hour, minute)), zone)
                if moment is not None and moment > after:
                    return moment.astimezone(UTC)
    return None
