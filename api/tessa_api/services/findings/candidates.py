import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import JsonValue, ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    InvariantResultRow,
    ProbeResultRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
)
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    FeatureKind,
    FindingClass,
    ProbeStatus,
    RunScenarioStatus,
    Severity,
    SkipReason,
    VerdictStatus,
)
from tessa_api.schemas.model_calls import EMBED_MAX_TEXT_CHARS
from tessa_api.schemas.oracles import DbCheck
from tessa_api.schemas.runs import RunScenarioAttempt
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_api.schemas.temporal import FindingCandidate
from tessa_api.services.findings.classify import (
    CHECK_FLAKY,
    CHECK_SKIPPED_PREFIX,
    CHECK_TRIAGE_TRUNCATED,
    Classification,
    classify_harness,
)
from tessa_api.services.findings.fingerprint import compute_fingerprint, normalize_signal
from tessa_api.services.findings.severity import (
    SEVERITY_RANK,
    role_standing,
    severity_for,
)
from tessa_api.services.findings.signals import (
    PROBES_FAILED_CODE,
    SCENARIO_TIMEOUT_CODE,
    Signal,
    StepView,
    attempt_error_signal,
    attempt_timeout_signal,
    compact_value,
    invariant_signal,
    safe_text,
    tier0_signals,
    verdict_signals,
)
from tessa_api.services.grading_rules import clip_text
from tessa_api.services.probe_specs import ProbeSpec
from tessa_api.services.seed_resolution import parse_stored_manifest

MAX_CANDIDATES = 100
TITLE_LIMIT = 200
MAX_LISTED_SCENARIOS = 5
ATTEMPT_ERROR_CODES = frozenset({"attempt_errored", "scenario_workflow_failed"})
SKIP_REASONS_TO_FILE = frozenset({SkipReason.service_down, SkipReason.seed_mismatch})
INVARIANT_STATUSES = (VerdictStatus.fail, VerdictStatus.flaky)
STEP_TEXT_LIMIT = 2000
TRUNCATION_SIGNAL = "triage candidate limit exceeded"


class RunNotFoundError(LookupError):
    pass


@dataclass(frozen=True, slots=True)
class ScenarioContext:
    run_scenario_id: uuid.UUID
    scenario_id: uuid.UUID
    title: str
    family: str
    feature_id: str | None
    role: str
    interface_id: str
    status: RunScenarioStatus
    skip_reason: SkipReason | None
    verdict: Verdict | None
    attempts: tuple[RunScenarioAttempt, ...]


@dataclass(frozen=True, slots=True)
class InvariantFailure:
    run_scenario_id: uuid.UUID | None
    step_id: uuid.UUID | None
    attempt: int | None
    invariant_id: str
    status: VerdictStatus
    message: str


@dataclass(frozen=True, slots=True)
class CandidateInputs:
    target_id: uuid.UUID
    scenarios: tuple[ScenarioContext, ...]
    steps: tuple[StepView, ...]
    invariant_failures: tuple[InvariantFailure, ...]
    violated_probes: Mapping[uuid.UUID, tuple[ProbeSpec, ...]]
    feature_kinds: Mapping[str, FeatureKind]
    role_levels: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class Location:
    scenario_id: uuid.UUID | None
    run_scenario_id: uuid.UUID | None
    title: str | None
    family: str | None
    feature_id: str | None
    role: str | None
    interface_id: str | None


NOWHERE = Location(None, None, None, None, None, None, None)


def location_of(scenario: ScenarioContext | None) -> Location:
    if scenario is None:
        return NOWHERE
    return Location(
        scenario_id=scenario.scenario_id,
        run_scenario_id=scenario.run_scenario_id,
        title=scenario.title,
        family=scenario.family,
        feature_id=scenario.feature_id,
        role=scenario.role,
        interface_id=scenario.interface_id,
    )


@dataclass(slots=True)
class Draft:
    candidate: FindingCandidate
    hits: int = 1
    attempts: set[int] = field(default_factory=set)
    scenario_titles: list[str] = field(default_factory=list)

    def note(self, attempt: int | None, scenario_title: str | None) -> None:
        if attempt is not None:
            self.attempts.add(attempt)
        if scenario_title and scenario_title not in self.scenario_titles:
            self.scenario_titles.append(scenario_title)

    def finished(self) -> FindingCandidate:
        evidence: dict[str, JsonValue] = dict(self.candidate.evidence)
        evidence["hits"] = self.hits
        if self.attempts:
            evidence["attempts"] = [*sorted(self.attempts)]
        if self.scenario_titles:
            evidence["scenarios"] = list(self.scenario_titles[:MAX_LISTED_SCENARIOS])
        return self.candidate.model_copy(update={"evidence": evidence})


def parsed_verdict(raw: Mapping[str, Any] | None) -> Verdict | None:
    if raw is None:
        return None
    try:
        return Verdict.model_validate(raw)
    except ValidationError:
        return None


def parsed_attempts(raw: Iterable[Mapping[str, Any]]) -> tuple[RunScenarioAttempt, ...]:
    attempts: list[RunScenarioAttempt] = []
    for item in raw:
        try:
            attempts.append(RunScenarioAttempt.model_validate(item))
        except ValidationError:
            continue
    return tuple(sorted(attempts, key=lambda attempt: attempt.attempt))


def parsed_tier0_failures(raw: Mapping[str, Any]) -> tuple[Tier0Failure, ...]:
    try:
        return tuple(Tier0Result.model_validate(raw).failures)
    except ValidationError:
        return ()


def parsed_db_checks(raw: Iterable[Mapping[str, Any]]) -> tuple[DbCheck, ...]:
    checks: list[DbCheck] = []
    for item in raw:
        try:
            checks.append(DbCheck.model_validate(item))
        except ValidationError:
            continue
    return tuple(checks)


def parsed_status_code(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


async def load_scenarios(session: AsyncSession, run_id: uuid.UUID) -> tuple[ScenarioContext, ...]:
    rows = await session.execute(
        select(RunScenarioRow, ScenarioRow.title, ScenarioRow.family, ScenarioRow.feature_id)
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(RunScenarioRow.run_id == run_id)
        .order_by(ScenarioRow.family, ScenarioRow.title, RunScenarioRow.role, RunScenarioRow.id)
    )
    return tuple(
        ScenarioContext(
            run_scenario_id=run_scenario.id,
            scenario_id=run_scenario.scenario_id,
            title=title,
            family=family,
            feature_id=feature_id,
            role=run_scenario.role,
            interface_id=run_scenario.interface_id,
            status=run_scenario.status,
            skip_reason=run_scenario.skip_reason,
            verdict=parsed_verdict(run_scenario.verdict),
            attempts=parsed_attempts(run_scenario.attempts),
        )
        for run_scenario, title, family, feature_id in rows
    )


async def load_invariant_failures(
    session: AsyncSession, run_id: uuid.UUID
) -> tuple[InvariantFailure, ...]:
    rows = await session.scalars(
        select(InvariantResultRow)
        .where(
            InvariantResultRow.run_id == run_id, InvariantResultRow.status.in_(INVARIANT_STATUSES)
        )
        .order_by(InvariantResultRow.invariant_id, InvariantResultRow.created_at)
    )
    return tuple(
        InvariantFailure(
            run_scenario_id=row.run_scenario_id,
            step_id=row.step_id,
            attempt=row.attempt,
            invariant_id=row.invariant_id,
            status=row.status,
            message=row.message,
        )
        for row in rows
    )


async def load_steps(
    session: AsyncSession, run_id: uuid.UUID, extra_step_ids: Sequence[uuid.UUID]
) -> tuple[StepView, ...]:
    failing = or_(
        StepRow.ok.is_(False),
        StepRow.tier0_failure_count > 0,
        StepRow.verdict["status"].astext == VerdictStatus.fail.value,
    )
    condition = or_(failing, StepRow.id.in_(list(extra_step_ids))) if extra_step_ids else failing
    rows = await session.execute(
        select(
            StepRow.id,
            StepRow.run_scenario_id,
            StepRow.attempt,
            StepRow.index.label("step_index"),
            StepRow.label,
            StepRow.request["method"].astext.label("method"),
            StepRow.request["url"].astext.label("address"),
            StepRow.request["fuzz"]["operation"].astext.label("fuzz_operation"),
            StepRow.response["status"].astext.label("status_code"),
            StepRow.ok,
            StepRow.ask,
            StepRow.answer,
            StepRow.tier0,
            StepRow.verdict,
            StepRow.db_checks,
        )
        .where(StepRow.run_id == run_id, condition)
        .order_by(StepRow.run_scenario_id, StepRow.attempt, StepRow.index)
    )
    return tuple(
        StepView(
            id=row.id,
            run_scenario_id=row.run_scenario_id,
            attempt=row.attempt,
            index=row.step_index,
            label=row.label,
            method=row.method,
            address=row.address,
            status_code=parsed_status_code(row.status_code),
            ok=row.ok,
            ask=None if row.ask is None else clip_text(row.ask, STEP_TEXT_LIMIT),
            answer=None if row.answer is None else clip_text(row.answer, STEP_TEXT_LIMIT),
            tier0_failures=parsed_tier0_failures(row.tier0),
            verdict=parsed_verdict(row.verdict),
            db_checks=parsed_db_checks(row.db_checks),
            operation=row.fuzz_operation,
        )
        for row in rows
    )


async def load_violated_probes(
    session: AsyncSession, steps: Sequence[StepView], probe_specs: Mapping[str, ProbeSpec]
) -> dict[uuid.UUID, tuple[ProbeSpec, ...]]:
    probe_failed = [
        step.id
        for step in steps
        if step.verdict is not None and step.verdict.reason_code == PROBES_FAILED_CODE
    ]
    if not probe_failed or not probe_specs:
        return {}
    rows = await session.execute(
        select(ProbeResultRow.step_id, ProbeResultRow.probe_id, ProbeResultRow.answer).where(
            ProbeResultRow.step_id.in_(probe_failed), ProbeResultRow.status == ProbeStatus.decided
        )
    )
    violated: dict[uuid.UUID, list[ProbeSpec]] = defaultdict(list)
    for step_id, probe_id, answer in rows:
        spec = probe_specs.get(probe_id)
        if spec is not None and answer != spec.compliant_choice:
            violated[step_id].append(spec)
    return {step_id: tuple(specs) for step_id, specs in violated.items()}


async def load_candidate_inputs(
    session: AsyncSession, run_id: uuid.UUID, probe_specs: Mapping[str, ProbeSpec]
) -> CandidateInputs | None:
    run = await session.get(RunRow, run_id)
    if run is None:
        raise RunNotFoundError(f"run {run_id} does not exist")
    if run.target_id is None:
        return None
    bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
    manifest = None if bundle is None else parse_stored_manifest(bundle)
    invariant_failures = await load_invariant_failures(session, run_id)
    steps = await load_steps(
        session, run_id, [item.step_id for item in invariant_failures if item.step_id is not None]
    )
    return CandidateInputs(
        target_id=run.target_id,
        scenarios=await load_scenarios(session, run_id),
        steps=steps,
        invariant_failures=invariant_failures,
        violated_probes=await load_violated_probes(session, steps, probe_specs),
        feature_kinds={}
        if manifest is None
        else {item.id: item.kind for item in manifest.features},
        role_levels={} if manifest is None else {item.id: item.level for item in manifest.roles},
    )


def attempt_level_signal(attempt: RunScenarioAttempt) -> Signal | None:
    verdict = attempt.verdict
    if verdict is None:
        return None
    if verdict.status is VerdictStatus.fail and verdict.reason_code == SCENARIO_TIMEOUT_CODE:
        return attempt_timeout_signal(verdict.reason)
    if verdict.reason_code in ATTEMPT_ERROR_CODES:
        return attempt_error_signal(verdict.reason_code or "", verdict.reason)
    return None


def title_of(signal: Signal, location: Location) -> str:
    where = location.feature_id or location.title
    text = signal.summary if where is None else f"{signal.summary} ({where})"
    return clip_text(text, TITLE_LIMIT)


def evidence_of(
    signal: Signal,
    location: Location,
    step: StepView | None,
    extra: Mapping[str, JsonValue],
) -> dict[str, JsonValue]:
    facts: dict[str, JsonValue] = {
        "check": signal.classification.check,
        "reason_code": signal.reason_code,
        "scenario_title": location.title,
        "family": location.family,
        "step_label": None if step is None else safe_text(step.label),
        "step_index": None if step is None else step.index,
        **extra,
    }
    return {key: value for key, value in facts.items() if value is not None}


class CandidateAssembler:
    def __init__(self, inputs: CandidateInputs) -> None:
        self.inputs = inputs
        self.scenarios = {item.run_scenario_id: item for item in inputs.scenarios}
        self.steps = {item.id: item for item in inputs.steps}
        self.drafts: dict[str, Draft] = {}
        self.covered: set[tuple[uuid.UUID | None, int | None, str]] = set()
        self.checks_by_scenario: dict[uuid.UUID, set[str]] = defaultdict(set)

    def assemble(self) -> list[FindingCandidate]:
        self.add_invariants()
        self.add_steps()
        self.add_attempt_level()
        self.add_flaky()
        self.add_skips()
        return self.limited(self.ordered())

    def add(
        self,
        signal: Signal,
        location: Location,
        step: StepView | None,
        attempt: int | None,
        extra: Mapping[str, JsonValue] | None = None,
        member_title: str | None = None,
    ) -> None:
        candidate = self.candidate_of(signal, location, step, attempt, extra or {})
        title = member_title or location.title
        if location.run_scenario_id is not None:
            self.checks_by_scenario[location.run_scenario_id].add(signal.classification.check)
        existing = self.drafts.get(candidate.fingerprint)
        if existing is not None:
            existing.hits += 1
            existing.note(attempt, title)
            return
        draft = Draft(candidate=candidate)
        draft.note(attempt, title)
        self.drafts[candidate.fingerprint] = draft

    def candidate_of(
        self,
        signal: Signal,
        location: Location,
        step: StepView | None,
        attempt: int | None,
        extra: Mapping[str, JsonValue],
    ) -> FindingCandidate:
        classification = signal.classification
        title = title_of(signal, location)
        return FindingCandidate(
            fingerprint=compute_fingerprint(
                self.inputs.target_id,
                classification.finding_class,
                classification.check,
                location.feature_id,
                location.interface_id,
                location.role,
                signal.signal,
            ),
            finding_class=classification.finding_class,
            severity=self.severity_of(classification, location),
            title=title,
            invariant_id=classification.invariant_id,
            scenario_id=location.scenario_id,
            run_scenario_id=location.run_scenario_id,
            step_id=None if step is None else step.id,
            attempt=attempt,
            feature_id=location.feature_id,
            interface_id=location.interface_id,
            role=location.role,
            family=location.family,
            signal=signal.signal,
            embedding_text=clip_text(
                f"{classification.finding_class.value}: {title}. {signal.signal}",
                EMBED_MAX_TEXT_CHARS,
            ),
            evidence=evidence_of(signal, location, step, extra),
            expected=compact_value(signal.expected),
            actual=compact_value(signal.actual),
        )

    def severity_of(self, classification: Classification, location: Location) -> Severity:
        kind = (
            None
            if location.feature_id is None
            else self.inputs.feature_kinds.get(location.feature_id)
        )
        standing = role_standing(self.inputs.role_levels, location.role)
        return severity_for(classification.finding_class, kind, standing)

    def is_covered(self, step: StepView, invariant_id: str) -> bool:
        return (step.run_scenario_id, step.attempt, invariant_id) in self.covered or (
            step.run_scenario_id,
            None,
            invariant_id,
        ) in self.covered

    def add_invariants(self) -> None:
        for failure in self.inputs.invariant_failures:
            scenario = (
                None
                if failure.run_scenario_id is None
                else self.scenarios.get(failure.run_scenario_id)
            )
            step = None if failure.step_id is None else self.steps.get(failure.step_id)
            self.covered.add((failure.run_scenario_id, failure.attempt, failure.invariant_id))
            signal = invariant_signal(
                failure.invariant_id,
                failure.message,
                step,
                flaky=failure.status is VerdictStatus.flaky,
            )
            self.add(signal, location_of(scenario), step, failure.attempt)

    def add_steps(self) -> None:
        for step in self.inputs.steps:
            location = location_of(self.scenarios.get(step.run_scenario_id))
            violated = self.inputs.violated_probes.get(step.id, ())
            for signal in [*tier0_signals(step), *verdict_signals(step, violated)]:
                invariant_id = signal.classification.invariant_id
                if invariant_id is not None and self.is_covered(step, invariant_id):
                    continue
                self.add(signal, location, step, step.attempt)

    def add_attempt_level(self) -> None:
        for scenario in self.inputs.scenarios:
            location = location_of(scenario)
            produced = False
            for attempt in scenario.attempts:
                signal = attempt_level_signal(attempt)
                if signal is not None:
                    self.add(signal, location, None, attempt.attempt)
                    produced = True
            verdict = scenario.verdict
            if (
                not produced
                and scenario.status is RunScenarioStatus.errored
                and verdict is not None
            ):
                self.add(
                    attempt_error_signal(verdict.reason_code or "attempt_errored", verdict.reason),
                    location,
                    None,
                    None,
                )

    def add_flaky(self) -> None:
        for scenario in self.inputs.scenarios:
            verdict = scenario.verdict
            if verdict is None or verdict.status is not VerdictStatus.flaky:
                continue
            checks = sorted(self.checks_by_scenario.get(scenario.run_scenario_id, ()))
            detail = ", ".join(checks) if checks else "attempts disagree"
            signal = Signal(
                classification=Classification(FindingClass.flaky, CHECK_FLAKY, None),
                signal=normalize_signal(f"flaky: {detail}"),
                summary=safe_text(f"Flaky: {scenario.title}"),
                expected="every attempt passes",
                actual=None if verdict.reason is None else safe_text(verdict.reason),
                reason_code=verdict.reason_code,
            )
            self.add(signal, location_of(scenario), None, None)

    def add_skips(self) -> None:
        groups: dict[tuple[str, str, SkipReason], list[ScenarioContext]] = defaultdict(list)
        for scenario in self.inputs.scenarios:
            if (
                scenario.status is RunScenarioStatus.skipped
                and scenario.skip_reason in SKIP_REASONS_TO_FILE
            ):
                groups[(scenario.family, scenario.interface_id, scenario.skip_reason)].append(
                    scenario
                )
        for (family, interface_id, reason), members in sorted(
            groups.items(), key=lambda item: (item[0][0], item[0][1], item[0][2].value)
        ):
            first = members[0]
            location = Location(
                scenario_id=first.scenario_id,
                run_scenario_id=first.run_scenario_id,
                title=first.title,
                family=family,
                feature_id=None,
                role=None,
                interface_id=interface_id,
            )
            signal = Signal(
                classification=classify_harness(f"{CHECK_SKIPPED_PREFIX}{reason.value}"),
                signal=normalize_signal(f"family {family} skipped: {reason.value}"),
                summary=safe_text(f"Family {family} was skipped on {interface_id}: {reason.value}"),
                expected="the family runs",
                actual=reason.value,
                reason_code=reason.value,
            )
            extra: dict[str, JsonValue] = {
                "skip_family": family,
                "skip_interface": interface_id,
                "skip_reason": reason.value,
                "skipped_scenarios": len(members),
            }
            for member in members:
                self.add(signal, location, None, None, extra, member.title)

    def ordered(self) -> list[FindingCandidate]:
        finished = [draft.finished() for draft in self.drafts.values()]
        return sorted(
            finished,
            key=lambda candidate: (
                -SEVERITY_RANK[candidate.severity],
                candidate.title,
                candidate.fingerprint,
            ),
        )

    def limited(self, candidates: list[FindingCandidate]) -> list[FindingCandidate]:
        if len(candidates) <= MAX_CANDIDATES:
            return candidates
        kept = candidates[: MAX_CANDIDATES - 1]
        dropped = len(candidates) - len(kept)
        signal = Signal(
            classification=classify_harness(CHECK_TRIAGE_TRUNCATED),
            signal=normalize_signal(TRUNCATION_SIGNAL),
            summary=f"Triage kept {len(kept)} finding candidates and dropped {dropped}",
            expected=f"at most {MAX_CANDIDATES} finding candidates per run",
            actual=dropped,
        )
        truncation = self.candidate_of(signal, NOWHERE, None, None, {"dropped": dropped})
        return [*kept, truncation]


def assemble_candidates(inputs: CandidateInputs) -> list[FindingCandidate]:
    return CandidateAssembler(inputs).assemble()


async def build_run_candidates(
    session: AsyncSession, run_id: uuid.UUID, probe_specs: Mapping[str, ProbeSpec]
) -> list[FindingCandidate]:
    inputs = await load_candidate_inputs(session, run_id, probe_specs)
    if inputs is None:
        return []
    return assemble_candidates(inputs)
