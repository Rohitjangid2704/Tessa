import json
import uuid
from collections.abc import Mapping
from typing import Any

from pydantic import JsonValue, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    FindingOccurrenceRow,
    FindingRow,
    RunRow,
    RunScenarioRow,
    StepRow,
)
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import VerdictStatus
from tessa_api.schemas.findings import StoredFindingRepro
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_api.services.findings.queries import evidence_json, latest_evidence
from tessa_api.services.findings.repro import (
    ReproUnavailableError,
    build_stored_repro,
    parsed_stored_repro,
)
from tessa_api.services.grading_rules import clip_text
from tessa_api.services.prompts.explain import ExplainInputs, ExplainStep
from tessa_api.services.seed_resolution import parse_stored_manifest

MAX_STEPS = 200
FIELD_LIMIT = 4000
FAILURE_VALUE_LIMIT = 200
EXPECTED_KEY = "expected"
ACTUAL_KEY = "actual"


def json_brief(value: JsonValue) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return clip_text(text, FAILURE_VALUE_LIMIT)


def failure_text(failure: Tier0Failure) -> str:
    detail = f"{failure.check.value}: {failure.message}"
    if failure.expected is None and failure.actual is None:
        return detail
    return (
        f"{detail} [expected {json_brief(failure.expected)}, actual {json_brief(failure.actual)}]"
    )


def tier0_failures(raw: Mapping[str, Any]) -> tuple[Tier0Failure, ...]:
    try:
        return tuple(Tier0Result.model_validate(raw).failures)
    except ValidationError:
        return ()


def verdict_of(raw: Mapping[str, Any] | None) -> Verdict | None:
    if raw is None:
        return None
    try:
        return Verdict.model_validate(raw)
    except ValidationError:
        return None


def verdict_text(verdict: Verdict | None) -> str | None:
    if verdict is None or verdict.status is VerdictStatus.pass_:
        return None
    detail = f": {verdict.reason}" if verdict.reason else ""
    return f"{verdict.status.value} ({verdict.tier.value}, {verdict.reason_code}){detail}"


def request_method(request: Mapping[str, Any] | None) -> str | None:
    if request is None:
        return None
    method = request.get("method") or request.get("action")
    return method if isinstance(method, str) else None


def request_address(request: Mapping[str, Any] | None) -> str | None:
    if request is None:
        return None
    address = request.get("url") or request.get("target")
    return address if isinstance(address, str) else None


def response_status(response: Mapping[str, Any] | None) -> int | None:
    status = None if response is None else response.get("status")
    return status if isinstance(status, int) and not isinstance(status, bool) else None


def response_excerpt(response: Mapping[str, Any] | None) -> str | None:
    if response is None:
        return None
    body_text = response.get("body_text") or response.get("text_excerpt")
    if isinstance(body_text, str) and body_text:
        return clip_text(body_text, FIELD_LIMIT)
    body = response.get("body")
    if body is None:
        return None
    return clip_text(json.dumps(body, ensure_ascii=False, sort_keys=True), FIELD_LIMIT)


def explain_step(row: StepRow, marked_step_id: uuid.UUID | None) -> ExplainStep:
    failures = tier0_failures(row.tier0)
    verdict = verdict_of(row.verdict)
    failing = (
        row.ok is False
        or bool(failures)
        or (verdict is not None and verdict.status is VerdictStatus.fail)
        or row.id == marked_step_id
    )
    return ExplainStep(
        index=row.index,
        label=row.label,
        method=request_method(row.request),
        address=request_address(row.request),
        status_code=response_status(row.response),
        latency_ms=row.latency_ms,
        ok=row.ok,
        failing=failing,
        ask=None if row.ask is None else clip_text(row.ask, FIELD_LIMIT),
        answer=None if row.answer is None else clip_text(row.answer, FIELD_LIMIT),
        excerpt=response_excerpt(row.response),
        failures=tuple(failure_text(item) for item in failures),
        verdict=verdict_text(verdict),
    )


async def explain_steps(
    session: AsyncSession, stored: StoredFindingRepro, marked_step_id: uuid.UUID | None
) -> tuple[ExplainStep, ...]:
    rows = await session.scalars(
        select(StepRow)
        .where(StepRow.run_scenario_id == stored.run_scenario_id, StepRow.attempt == stored.attempt)
        .order_by(StepRow.index)
        .limit(MAX_STEPS)
    )
    return tuple(explain_step(row, marked_step_id) for row in rows)


async def invariant_text(
    session: AsyncSession, finding: FindingRow, stored: StoredFindingRepro | None
) -> str | None:
    if finding.invariant_id is None:
        return None
    rule: str | None = None
    run = None if stored is None else await session.get(RunRow, stored.run_id)
    bundle = (
        None
        if run is None or run.bundle_id is None
        else await session.get(BundleRow, run.bundle_id)
    )
    manifest = None if bundle is None else parse_stored_manifest(bundle)
    if manifest is not None:
        rule = next(
            (item.rule for item in manifest.invariants if item.id == finding.invariant_id), None
        )
    if rule:
        return f"Violated invariant `{finding.invariant_id}`: {rule}"
    return f"Violated invariant `{finding.invariant_id}` (built-in rule)"


async def repro_of(session: AsyncSession, finding: FindingRow) -> StoredFindingRepro | None:
    stored = parsed_stored_repro(finding.repro)
    if stored is not None:
        return stored
    try:
        return await build_stored_repro(session, finding.id)
    except ReproUnavailableError:
        return None


async def repro_facts(session: AsyncSession, stored: StoredFindingRepro) -> tuple[str, ...]:
    run_scenario = await session.get(RunScenarioRow, stored.run_scenario_id)
    facts = [
        f"Run {stored.run_id}, attempt {stored.attempt + 1}",
        f"Bundle version {stored.bundle_version}, scenario version {stored.scenario_version}",
        f"Clock: {stored.clock.mode} at {stored.clock.at.isoformat()}",
        f"Seed: version {stored.seed.version}, hash {stored.seed.hash}",
    ]
    if run_scenario is not None:
        facts.insert(1, f"Role {run_scenario.role} on interface {run_scenario.interface_id}")
    return tuple(f"- {fact}" for fact in facts)


async def load_explain_inputs(
    session: AsyncSession, finding: FindingRow, target_token: str
) -> ExplainInputs:
    stored = await repro_of(session, finding)
    evidence = await latest_evidence(session, finding.id)
    occurrence_step_id = (
        None if stored is None else await marked_step_id(session, finding.id, stored)
    )
    return ExplainInputs(
        finding_id=finding.id,
        target_token=target_token,
        title=finding.title,
        finding_class=finding.class_.value,
        severity=finding.severity.value,
        status=finding.status.value,
        occurrence_count=finding.occurrence_count,
        first_seen=finding.first_seen_at,
        last_seen=finding.last_seen_at,
        invariant_text=await invariant_text(session, finding, stored),
        expected=evidence_json(evidence, EXPECTED_KEY) if stored is None else stored.expected,
        actual=evidence_json(evidence, ACTUAL_KEY) if stored is None else stored.actual,
        repro_facts=() if stored is None else await repro_facts(session, stored),
        scenario_yaml=None if stored is None else stored.scenario_yaml,
        steps=() if stored is None else await explain_steps(session, stored, occurrence_step_id),
        oracle_rows=() if stored is None else tuple(stored.oracle_rows),
    )


async def marked_step_id(
    session: AsyncSession, finding_id: uuid.UUID, stored: StoredFindingRepro
) -> uuid.UUID | None:
    return await session.scalar(
        select(FindingOccurrenceRow.step_id)
        .where(
            FindingOccurrenceRow.finding_id == finding_id,
            FindingOccurrenceRow.run_scenario_id == stored.run_scenario_id,
            FindingOccurrenceRow.attempt == stored.attempt,
            FindingOccurrenceRow.step_id.is_not(None),
        )
        .order_by(FindingOccurrenceRow.seen_at.desc())
        .limit(1)
    )
