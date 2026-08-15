from collections.abc import Sequence
from dataclasses import dataclass

from tessa_api.schemas.attack_pack import ATTACK_PROMPT_MAX_CHARS
from tessa_api.schemas.enums import AttackOutcome
from tessa_worker.lab.redteam.context import FamilyBrief

CONTEXT_DIGEST_MAX_CHARS = 6000
HISTORY_WINDOW = 8
NOTE_EXCERPT_CHARS = 140
SEED_MAX_CHARS = ATTACK_PROMPT_MAX_CHARS
FIELD_MAX_CHARS = 400
NO_CANARY = "none"


@dataclass(frozen=True, slots=True)
class AttackNote:
    prompt: str
    outcome: AttackOutcome
    confirmed: bool


@dataclass(frozen=True, slots=True)
class DigestInput:
    brief: FamilyBrief
    app_brief: str
    role_brief: str
    canary: str | None
    history: Sequence[AttackNote]
    round_index: int
    ordinal: int
    attacks_per_family: int


def one_line(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 3]}..."


def note_line(position: int, note: AttackNote) -> str:
    label = "confirmed" if note.confirmed else note.outcome.value
    return f"earlier {position}: [{label}] {one_line(note.prompt, NOTE_EXCERPT_CHARS)}"


def head_lines(item: DigestInput) -> list[str]:
    brief = item.brief
    return [
        f"family: {brief.id} - {one_line(brief.title, FIELD_MAX_CHARS)}",
        f"objective: {one_line(brief.objective, FIELD_MAX_CHARS)}",
        *(f"tactic: {one_line(tactic, FIELD_MAX_CHARS)}" for tactic in brief.tactics),
        f"application: {one_line(item.app_brief, FIELD_MAX_CHARS)}",
        f"role under test: {one_line(item.role_brief, FIELD_MAX_CHARS)}",
        f"canary: {item.canary or NO_CANARY}",
        f"attempt: {item.ordinal + 1} of {item.attacks_per_family} in round {item.round_index}",
    ]


def joined(head: Sequence[str], seeds: Sequence[str], history: Sequence[str]) -> str:
    return "\n".join([*head, *seeds, *history])


def build_context_digest(item: DigestInput) -> str:
    head = head_lines(item)
    seeds = [
        f"seed {position}: {one_line(seed, SEED_MAX_CHARS)}"
        for position, seed in enumerate(item.brief.seeds, start=1)
    ]
    recent = item.history[-HISTORY_WINDOW:]
    history = [note_line(position, note) for position, note in enumerate(recent, start=1)]
    while len(joined(head, seeds, history)) > CONTEXT_DIGEST_MAX_CHARS and history:
        history.pop(0)
    while len(joined(head, seeds, history)) > CONTEXT_DIGEST_MAX_CHARS and len(seeds) > 1:
        seeds.pop()
    return joined(head, seeds, history)[:CONTEXT_DIGEST_MAX_CHARS]
