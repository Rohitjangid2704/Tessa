import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import ValidationError

from tessa_api.schemas.enums import ProbeAnswerType, ProbeInputField
from tessa_api.schemas.probes import ProbeBankFile, ProbeDefinition

PROBE_FILE_SUFFIX = ".yaml"
PROBE_TOTAL_INPUT_MAX_CHARS = 1600
YES_ANSWER = "yes"
NO_ANSWER = "no"

NUMBER_PATTERN = re.compile(
    r"\d|\b(?:how many|how much|number|numbers|count|counts|counted|total|totals|sum|average"
    r"|percent|percentage|amount|amounts|price|prices|cost|costs|quantity)\b",
    re.IGNORECASE,
)
DATE_PATTERN = re.compile(
    r"\b(?:date|dates|day|days|week|weeks|month|months|year|years|today|tomorrow|yesterday"
    r"|tonight|deadline|when|time|times|hour|hours|minute|minutes|monday|tuesday|wednesday"
    r"|thursday|friday|saturday|sunday|january|february|april|june|july|august|september"
    r"|october|november|december)\b",
    re.IGNORECASE,
)
EVIDENCE_PATTERN = re.compile(
    r"\b(?:transcript|entire|whole|every message|all messages"
    r"|(?:full|complete) (?:text|log|history|conversation|page|document))\b",
    re.IGNORECASE,
)
FORBIDDEN_TOPICS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("numbers", NUMBER_PATTERN),
    ("dates", DATE_PATTERN),
    ("long evidence", EVIDENCE_PATTERN),
)


class ProbeBankError(Exception):
    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = tuple(problems)


@dataclass(frozen=True, slots=True)
class ProbeBank:
    version: str
    probes: tuple[ProbeDefinition, ...]

    def get(self, probe_id: str) -> ProbeDefinition | None:
        return next((probe for probe in self.probes if probe.id == probe_id), None)


def compliant_answer(answer_type: ProbeAnswerType, choices: Sequence[str]) -> str:
    if answer_type is ProbeAnswerType.yes_no:
        return YES_ANSWER
    return choices[0]


def is_compliant_answer(
    answer_type: ProbeAnswerType, choices: Sequence[str], answer: str | None
) -> bool:
    return answer is not None and answer == compliant_answer(answer_type, choices)


def bank_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        raise ProbeBankError([f"probe directory {directory} does not exist"])
    files = sorted(directory.glob(f"*{PROBE_FILE_SUFFIX}"))
    if not files:
        raise ProbeBankError([f"no {PROBE_FILE_SUFFIX} probe files in {directory}"])
    return files


def normalized_content(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def compute_bank_version(contents: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name in sorted(contents):
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(contents[name])
        digest.update(b"\0")
    return digest.hexdigest()


def lint_text(probe_id: str, label: str, text: str) -> list[str]:
    return [
        f"{probe_id}: {label} asks about {topic} ({match.group(0)!r})"
        for topic, pattern in FORBIDDEN_TOPICS
        if (match := pattern.search(text)) is not None
    ]


def lint_probe(probe: ProbeDefinition, pack_of_file: str) -> list[str]:
    problems = lint_text(probe.id, "the question", probe.question)
    for choice in probe.choices:
        problems.extend(lint_text(probe.id, f"the choice {choice!r}", choice))
    if probe.pack.value != pack_of_file:
        problems.append(f"{probe.id}: pack {probe.pack.value} does not match file {pack_of_file}")
    total_chars = sum(spec.max_chars for spec in probe.input.fields)
    if total_chars > PROBE_TOTAL_INPUT_MAX_CHARS:
        problems.append(
            f"{probe.id}: input fields allow {total_chars} characters, "
            f"at most {PROBE_TOTAL_INPUT_MAX_CHARS} are accepted"
        )
    if any(spec.name is ProbeInputField.invariant_rule for spec in probe.input.fields):
        problems.append(f"{probe.id}: invariant_rule is only available to bundle probes")
    return problems


def parse_probe_file(path: Path, content: bytes) -> ProbeBankFile:
    try:
        document = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise ProbeBankError([f"{path.name}: not valid YAML ({type(error).__name__})"]) from None
    try:
        return ProbeBankFile.model_validate(document)
    except ValidationError as error:
        raise ProbeBankError(
            [
                f"{path.name}: {'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()
            ]
        ) from None


def duplicate_ids(probes: Iterable[ProbeDefinition]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for probe in probes:
        if probe.id in seen:
            duplicates.add(probe.id)
        seen.add(probe.id)
    return sorted(duplicates)


def read_probe_bank(directory: Path) -> ProbeBank:
    contents: dict[str, bytes] = {}
    probes: list[ProbeDefinition] = []
    problems: list[str] = []
    for path in bank_files(directory):
        content = normalized_content(path)
        contents[path.name] = content
        try:
            parsed = parse_probe_file(path, content)
        except ProbeBankError as error:
            problems.extend(error.problems)
            continue
        for probe in parsed.probes:
            problems.extend(lint_probe(probe, path.stem))
        probes.extend(parsed.probes)
    problems.extend(f"duplicate probe id {probe_id}" for probe_id in duplicate_ids(probes))
    if problems:
        raise ProbeBankError(problems)
    return ProbeBank(version=compute_bank_version(contents), probes=tuple(probes))


@lru_cache(maxsize=8)
def cached_probe_bank(directory: str, signature: tuple[tuple[str, int, int], ...]) -> ProbeBank:
    return read_probe_bank(Path(directory))


def file_signature(files: Sequence[Path]) -> tuple[tuple[str, int, int], ...]:
    stats = [(path, path.stat()) for path in files]
    return tuple((path.name, stat.st_mtime_ns, stat.st_size) for path, stat in stats)


def load_probe_bank(directory: Path) -> ProbeBank:
    resolved = directory.resolve()
    return cached_probe_bank(str(resolved), file_signature(bank_files(resolved)))
