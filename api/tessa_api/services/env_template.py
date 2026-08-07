import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from tessa_api.schemas.bundle import ENV_TEMPLATE_LINE_PATTERN
from tessa_api.schemas.bundles import BundleValidationError

ENV_TEMPLATE_FILE = "env.template"
LINE_PATTERN = re.compile(ENV_TEMPLATE_LINE_PATTERN)
ASSIGNMENT_START = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*=")


@dataclass(frozen=True)
class EnvTemplateEntry:
    name: str
    example: str
    purpose: str | None
    line: int


@dataclass
class ParsedEnvTemplate:
    entries: dict[str, EnvTemplateEntry] = field(default_factory=dict)
    errors: list[BundleValidationError] = field(default_factory=list)
    warnings: list[BundleValidationError] = field(default_factory=list)

    @property
    def names(self) -> frozenset[str]:
        return frozenset(self.entries)


def template_problem(
    code: str, message: str, line: int, severity: str = "error"
) -> BundleValidationError:
    return BundleValidationError(
        code=code,
        message=message,
        severity="warning" if severity == "warning" else "error",
        file=ENV_TEMPLATE_FILE,
        line=line,
        column=1,
    )


def parse_env_template(text: str) -> ParsedEnvTemplate:
    parsed = ParsedEnvTemplate()
    pending_purpose: str | None = None
    for number, raw_line in enumerate(text.split("\n"), start=1):
        line = raw_line.rstrip()
        if not line.strip():
            pending_purpose = None
            continue
        if line.lstrip().startswith("#"):
            pending_purpose = line.lstrip().removeprefix("#").strip() or None
            continue
        match = LINE_PATTERN.fullmatch(line)
        if match is None:
            reason = (
                "the name must be upper case letters, digits and underscores"
                if ASSIGNMENT_START.match(line)
                else "expected NAME=value"
            )
            parsed.errors.append(
                template_problem(
                    "env_template_invalid_line",
                    f"Line is not a valid env.template entry ({reason}, and a value without "
                    f"spaces): {line[:80]!r}",
                    number,
                )
            )
            pending_purpose = None
            continue
        name, example, trailing = match.group(1), match.group(2), match.group(4)
        if name in parsed.entries:
            parsed.errors.append(
                template_problem(
                    "env_template_duplicate",
                    f"Variable {name} is listed twice; the first is on line "
                    f"{parsed.entries[name].line}",
                    number,
                )
            )
            pending_purpose = None
            continue
        purpose = trailing or pending_purpose
        if not purpose:
            parsed.warnings.append(
                template_problem(
                    "env_template_purpose_missing",
                    f"Variable {name} has no purpose; add a # comment line above it or after "
                    "the value",
                    number,
                    "warning",
                )
            )
        parsed.entries[name] = EnvTemplateEntry(name, example, purpose, number)
        pending_purpose = None
    return parsed


def example_has_credentials(example: str) -> bool:
    if "://" not in example:
        return False
    try:
        parts = urlsplit(example)
    except ValueError:
        return False
    return bool(parts.username or parts.password)


def example_has_path(example: str) -> bool:
    if not example.lower().startswith(("http://", "https://", "ws://", "wss://")):
        return False
    try:
        parts = urlsplit(example)
    except ValueError:
        return False
    return parts.path not in {"", "/"}
