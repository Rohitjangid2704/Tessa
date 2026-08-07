import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Select, Subquery, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from tessa_api.db.models import JudgeResultRow, LabelRow, ProbeResultRow, RunRow
from tessa_api.schemas.calibration import CalibrationItem, CalibrationReport
from tessa_api.schemas.enums import (
    CalibrationKind,
    LabelSource,
    LabelSubjectType,
    LabelValue,
    ProbeAnswerType,
    ProbeStatus,
)
from tessa_api.services.calibration_cache import CALIBRATION_CACHE
from tessa_api.services.calibration_math import (
    PairTally,
    kappa_when_enough,
    raw_agreement,
    weighted_mean_kappa,
)
from tessa_api.services.grading_rules import LABEL_VALUE_OF_STATUS
from tessa_api.services.probe_bank import NO_ANSWER, YES_ANSWER, ProbeBank, compliant_answer
from tessa_api.services.probe_listing import read_bank
from tessa_api.services.probe_specs import TARGET_PROBE_ID_PREFIX
from tessa_api.settings import Settings

JUDGE_SUBJECT_SEPARATOR = ":"
YES_NO_ANSWERS = frozenset({YES_ANSWER, NO_ANSWER})
MACHINE_VALUES = tuple(LABEL_VALUE_OF_STATUS.values())


@dataclass(frozen=True, slots=True)
class ProbePolarity:
    compliant: str
    allowed: frozenset[str]


TARGET_PROBE_POLARITY = ProbePolarity(YES_ANSWER, YES_NO_ANSWERS)


def answer_options(answer_type: ProbeAnswerType, choices: Sequence[str]) -> frozenset[str]:
    if answer_type is ProbeAnswerType.yes_no:
        return YES_NO_ANSWERS
    return frozenset(choices)


def probe_polarities(bank: ProbeBank) -> dict[str, ProbePolarity]:
    return {
        probe.id: ProbePolarity(
            compliant=compliant_answer(probe.answer_type, probe.choices),
            allowed=answer_options(probe.answer_type, probe.choices),
        )
        for probe in bank.probes
    }


def polarity_of(probe_id: str, polarities: Mapping[str, ProbePolarity]) -> ProbePolarity | None:
    known = polarities.get(probe_id)
    if known is not None:
        return known
    return TARGET_PROBE_POLARITY if probe_id.startswith(TARGET_PROBE_ID_PREFIX) else None


def probe_machine_value(
    status: ProbeStatus, answer: str | None, polarity: ProbePolarity | None
) -> LabelValue | None:
    if status is ProbeStatus.error:
        return None
    if status is ProbeStatus.uncertain:
        return LabelValue.uncertain
    if polarity is None:
        return None
    if answer is None or answer not in polarity.allowed:
        return LabelValue.uncertain
    return LabelValue.pass_ if answer == polarity.compliant else LabelValue.fail


def judge_subject(family: str, rubric_version: str) -> str:
    return f"{family}{JUDGE_SUBJECT_SEPARATOR}{rubric_version}"


def latest_human_labels(subject_type: LabelSubjectType) -> Subquery:
    ranked = (
        select(
            LabelRow.subject_id.label("subject_id"),
            LabelRow.value.label("value"),
            func.row_number()
            .over(
                partition_by=LabelRow.subject_id,
                order_by=(LabelRow.labeled_at.desc(), LabelRow.id.desc()),
            )
            .label("position"),
        )
        .where(LabelRow.source == LabelSource.human, LabelRow.subject_type == subject_type)
        .subquery(f"ranked_{subject_type.value}_labels")
    )
    return (
        select(ranked.c.subject_id, ranked.c.value)
        .where(ranked.c.position == 1)
        .subquery(f"latest_{subject_type.value}_labels")
    )


def restricted_to_target[*Columns](
    statement: Select[*Columns],
    run_id_column: InstrumentedAttribute[uuid.UUID],
    target_id: uuid.UUID | None,
) -> Select[*Columns]:
    if target_id is None:
        return statement
    return statement.join(RunRow, RunRow.id == run_id_column).where(RunRow.target_id == target_id)


def probe_statement(target_id: uuid.UUID | None) -> Select[*tuple[Any, ...]]:
    labels = latest_human_labels(LabelSubjectType.probe_result)
    statement = (
        select(
            ProbeResultRow.probe_id,
            labels.c.value.label("human"),
            ProbeResultRow.status,
            ProbeResultRow.answer,
            func.count().label("pairs"),
        )
        .select_from(ProbeResultRow)
        .join(labels, labels.c.subject_id == ProbeResultRow.id)
        .group_by(
            ProbeResultRow.probe_id, labels.c.value, ProbeResultRow.status, ProbeResultRow.answer
        )
    )
    return restricted_to_target(statement, ProbeResultRow.run_id, target_id)


def judge_statement(target_id: uuid.UUID | None) -> Select[*tuple[Any, ...]]:
    direct = latest_human_labels(LabelSubjectType.judge_result)
    by_step = latest_human_labels(LabelSubjectType.step)
    human = func.coalesce(direct.c.value, by_step.c.value)
    machine_status = func.jsonb_extract_path_text(JudgeResultRow.verdict, "status")
    statement = (
        select(
            JudgeResultRow.family,
            JudgeResultRow.rubric_version,
            human.label("human"),
            *(
                func.count().filter(machine_status == status.value).label(f"machine_{value.value}")
                for status, value in LABEL_VALUE_OF_STATUS.items()
            ),
        )
        .select_from(JudgeResultRow)
        .outerjoin(direct, direct.c.subject_id == JudgeResultRow.id)
        .outerjoin(by_step, by_step.c.subject_id == JudgeResultRow.step_id)
        .where(human.is_not(None))
        .group_by(JudgeResultRow.family, JudgeResultRow.rubric_version, human)
    )
    return restricted_to_target(statement, JudgeResultRow.run_id, target_id)


async def probe_tallies(
    session: AsyncSession, polarities: Mapping[str, ProbePolarity], target_id: uuid.UUID | None
) -> dict[str, PairTally]:
    tallies: defaultdict[str, PairTally] = defaultdict(PairTally)
    for probe_id, human, status, answer, pairs in await session.execute(probe_statement(target_id)):
        machine = probe_machine_value(status, answer, polarity_of(probe_id, polarities))
        if machine is not None:
            tallies[probe_id].add(human, machine, int(pairs))
    return dict(tallies)


async def judge_tallies(session: AsyncSession, target_id: uuid.UUID | None) -> dict[str, PairTally]:
    tallies: defaultdict[str, PairTally] = defaultdict(PairTally)
    for family, rubric_version, human, *counts in await session.execute(judge_statement(target_id)):
        tally = tallies[judge_subject(family.value, rubric_version)]
        for value, count in zip(MACHINE_VALUES, counts, strict=True):
            tally.add(human, value, int(count))
    return dict(tallies)


def to_item(
    subject: str, kind: CalibrationKind, tally: PairTally, min_labels: int
) -> CalibrationItem:
    table = tally.decided_table()
    return CalibrationItem(
        subject=subject,
        kind=kind,
        n_labels=table.total,
        kappa=kappa_when_enough(table, min_labels),
        agreement=raw_agreement(tally.agreed, tally.compared),
    )


def to_items(
    tallies: Mapping[str, PairTally], kind: CalibrationKind, min_labels: int
) -> list[CalibrationItem]:
    return [
        to_item(subject, kind, tallies[subject], min_labels)
        for subject in sorted(tallies)
        if tallies[subject].compared > 0
    ]


async def compute_calibration_report(
    session: AsyncSession, settings: Settings, target_id: uuid.UUID | None
) -> CalibrationReport:
    polarities = probe_polarities(read_bank(settings))
    min_labels = settings.calibration_min_labels
    probes = await probe_tallies(session, polarities, target_id)
    judges = await judge_tallies(session, target_id)
    return CalibrationReport(
        generated_at=datetime.now(UTC),
        min_labels=min_labels,
        items=[
            *to_items(probes, CalibrationKind.probe, min_labels),
            *to_items(judges, CalibrationKind.judge, min_labels),
        ],
    )


async def build_calibration_report(
    session: AsyncSession, settings: Settings, target_id: uuid.UUID | None
) -> CalibrationReport:
    key = (target_id, settings.calibration_min_labels)
    cached = CALIBRATION_CACHE.get(key)
    if cached is not None:
        return cached
    generation = CALIBRATION_CACHE.generation
    report = await compute_calibration_report(session, settings, target_id)
    CALIBRATION_CACHE.put(key, report, generation)
    return report


def overall_kappa(report: CalibrationReport) -> float | None:
    return weighted_mean_kappa((item.n_labels, item.kappa) for item in report.items)
