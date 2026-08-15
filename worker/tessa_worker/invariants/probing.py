from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID

from tessa_api.schemas.enums import ProbeStatus
from tessa_api.schemas.probes import ProbeResult
from tessa_api.schemas.temporal import RunLayaProbesInput
from tessa_worker.activities.grading_models import ProbePolarity
from tessa_worker.invariants.contracts import ProbeRunner


class ProbeJudgement(StrEnum):
    compliant = "compliant"
    violated = "violated"
    unsure = "unsure"
    refused = "refused"
    unavailable = "unavailable"


@dataclass(frozen=True, slots=True)
class ProbeVerdict:
    probe_id: str
    judgement: ProbeJudgement
    confidence: float | None


@dataclass(frozen=True, slots=True)
class ProbeSummary:
    judgement: ProbeJudgement
    confidence: float | None
    probe_ids: tuple[str, ...]


def judge_result(result: ProbeResult, polarity: Mapping[str, ProbePolarity]) -> ProbeVerdict:
    if result.status is ProbeStatus.error:
        return ProbeVerdict(result.probe_id, ProbeJudgement.unavailable, None)
    if result.status is ProbeStatus.uncertain:
        refused = result.answer is None
        judgement = ProbeJudgement.refused if refused else ProbeJudgement.unsure
        return ProbeVerdict(result.probe_id, judgement, None if refused else result.confidence)
    known = polarity.get(result.probe_id)
    if known is None or result.answer not in known.allowed_answers:
        return ProbeVerdict(result.probe_id, ProbeJudgement.unsure, result.confidence)
    judgement = (
        ProbeJudgement.compliant
        if result.answer == known.compliant_answer
        else ProbeJudgement.violated
    )
    return ProbeVerdict(result.probe_id, judgement, result.confidence)


async def ask_probes(
    probes: ProbeRunner,
    step_id: UUID,
    probe_ids: Sequence[str],
    polarity: Mapping[str, ProbePolarity],
) -> list[ProbeVerdict]:
    batch = await probes.run_laya_probes(
        RunLayaProbesInput(step_id=step_id, probe_ids=list(probe_ids))
    )
    by_id = {result.probe_id: result for result in batch.results}
    return [
        judge_result(by_id[probe_id], polarity)
        if probe_id in by_id
        else ProbeVerdict(probe_id, ProbeJudgement.unavailable, None)
        for probe_id in probe_ids
    ]


def lowest_confidence(verdicts: Sequence[ProbeVerdict]) -> float | None:
    known = [verdict.confidence for verdict in verdicts if verdict.confidence is not None]
    return min(known) if known else None


def summarize(verdicts: Sequence[ProbeVerdict]) -> ProbeSummary:
    probe_ids = tuple(verdict.probe_id for verdict in verdicts)
    for judgement in (
        ProbeJudgement.violated,
        ProbeJudgement.unavailable,
        ProbeJudgement.unsure,
    ):
        matching = [verdict for verdict in verdicts if verdict.judgement is judgement]
        if matching:
            return ProbeSummary(judgement, lowest_confidence(matching), probe_ids)
    compliant = [verdict for verdict in verdicts if verdict.judgement is ProbeJudgement.compliant]
    if compliant:
        return ProbeSummary(ProbeJudgement.compliant, lowest_confidence(compliant), probe_ids)
    return ProbeSummary(ProbeJudgement.refused, None, probe_ids)
