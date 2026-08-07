import json
import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from pydantic import JsonValue, ValidationError
from sqlalchemy import ScalarResult, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BrowserSessionRow,
    BundleRow,
    FindingOccurrenceRow,
    FindingRow,
    OracleResultRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    ScenarioVersionRow,
    StepRow,
)
from tessa_api.errors import not_found
from tessa_api.schemas.artifacts import StoredArtifact
from tessa_api.schemas.enums import ArtifactKind
from tessa_api.schemas.findings import (
    FINDING_REPRO_SCHEMA_VERSION,
    REPRO_MAX_ORACLE_ROWS,
    FindingRepro,
    ReproSeed,
    ReproTranscriptRow,
    StoredFindingRepro,
)
from tessa_api.schemas.runs import ClockSnapshot, RunConfigSnapshot
from tessa_api.services.artifacts import ArtifactSigner
from tessa_api.services.grading_rules import clip_text, redacted_text
from tessa_api.services.seed_resolution import seed_in_force

MAX_TRANSCRIPT_ROWS = 100
TRANSCRIPT_TEXT_LIMIT = 1500
ORACLE_VALUE_LIMIT = 300
MAX_SCREENCAST_ITEMS = 8
MAX_FAILING_STEP_SCREENSHOTS = 5


class ReproUnavailableError(LookupError):
    pass


class FindingMissingError(LookupError):
    pass


def safe_value(value: JsonValue) -> JsonValue:
    if isinstance(value, str):
        return clip_text(redacted_text(value), ORACLE_VALUE_LIMIT)
    if isinstance(value, list):
        return [safe_value(item) for item in value]
    if isinstance(value, dict):
        return {key: safe_value(item) for key, item in value.items()}
    return value


def safe_transcript_text(text: str | None) -> str | None:
    if text is None:
        return None
    return clip_text(redacted_text(text), TRANSCRIPT_TEXT_LIMIT)


async def pick_occurrence(
    session: AsyncSession, finding_id: uuid.UUID, occurrence_id: uuid.UUID | None
) -> FindingOccurrenceRow | None:
    statement = select(FindingOccurrenceRow).where(FindingOccurrenceRow.finding_id == finding_id)
    if occurrence_id is not None:
        statement = statement.where(FindingOccurrenceRow.id == occurrence_id)
    else:
        statement = statement.where(FindingOccurrenceRow.run_scenario_id.is_not(None))
    return await session.scalar(statement.order_by(FindingOccurrenceRow.seen_at.desc()).limit(1))


def snapshot_of(run: RunRow) -> RunConfigSnapshot | None:
    try:
        return RunConfigSnapshot.model_validate(run.config_snapshot)
    except ValidationError:
        return None


def clock_of(run: RunRow, snapshot: RunConfigSnapshot | None) -> ClockSnapshot:
    if snapshot is not None and snapshot.clock is not None:
        return snapshot.clock
    return ClockSnapshot(mode="real", at=run.started_at or run.created_at)


async def scenario_text(session: AsyncSession, scenario: ScenarioRow, version: int) -> str:
    stored = await session.get(ScenarioVersionRow, (scenario.id, version))
    return redacted_text(scenario.yaml if stored is None else stored.yaml)


async def seed_of(
    session: AsyncSession, bundle: BundleRow | None, snapshot: RunConfigSnapshot | None
) -> ReproSeed:
    seed = None if bundle is None else await seed_in_force(session, bundle)
    return ReproSeed(
        version=None if seed is None else seed.version,
        hash=None if snapshot is None else snapshot.seed_hash,
    )


async def transcript_of(
    session: AsyncSession, run_scenario_id: uuid.UUID, attempt: int
) -> list[ReproTranscriptRow]:
    rows = await session.execute(
        select(StepRow.index, StepRow.id, StepRow.ask, StepRow.answer, StepRow.label)
        .where(StepRow.run_scenario_id == run_scenario_id, StepRow.attempt == attempt)
        .order_by(StepRow.index)
        .limit(MAX_TRANSCRIPT_ROWS)
    )
    return [
        ReproTranscriptRow(
            index=index,
            step_id=step_id,
            ask=safe_transcript_text(ask),
            answer=safe_transcript_text(answer),
            label=clip_text(redacted_text(label), TRANSCRIPT_TEXT_LIMIT),
        )
        for index, step_id, ask, answer, label in rows
    ]


def stored_artifacts(entries: Iterable[Mapping[str, Any]]) -> list[StoredArtifact]:
    artifacts: list[StoredArtifact] = []
    for entry in entries:
        try:
            artifacts.append(StoredArtifact.model_validate(entry))
        except ValidationError:
            continue
    return artifacts


async def screencast_of(
    session: AsyncSession, session_row: BrowserSessionRow | None, failing_step: StepRow | None
) -> list[StoredArtifact]:
    items: list[StoredArtifact] = []
    if session_row is not None and session_row.recording is not None:
        items.extend(stored_artifacts([session_row.recording]))
    if failing_step is not None:
        screenshots = [
            artifact
            for artifact in stored_artifacts(failing_step.artifacts)
            if artifact.kind is ArtifactKind.screenshot
        ]
        items.extend(screenshots[:MAX_FAILING_STEP_SCREENSHOTS])
    return items[:MAX_SCREENCAST_ITEMS]


def oracle_result_ids(step: StepRow | None) -> list[uuid.UUID]:
    if step is None:
        return []
    identifiers: list[uuid.UUID] = []
    for entry in [*step.db_checks, *step.gold_points]:
        raw = entry.get("oracle_result_id")
        if raw is None:
            continue
        try:
            identifier = uuid.UUID(str(raw))
        except ValueError:
            continue
        if identifier not in identifiers:
            identifiers.append(identifier)
    return identifiers


async def oracle_rows_of(session: AsyncSession, step: StepRow | None) -> list[dict[str, JsonValue]]:
    identifiers = oracle_result_ids(step)
    if not identifiers:
        return []
    results: ScalarResult[list[dict[str, Any]]] = await session.scalars(
        select(OracleResultRow.rows).where(OracleResultRow.id.in_(identifiers))
    )
    rows: list[dict[str, JsonValue]] = []
    for result_rows in results:
        for row in result_rows:
            if len(rows) >= REPRO_MAX_ORACLE_ROWS:
                return rows
            rows.append({key: safe_value(value) for key, value in row.items()})
    return rows


class ReproSource:
    def __init__(
        self,
        finding: FindingRow,
        occurrence: FindingOccurrenceRow,
        run_scenario: RunScenarioRow,
        run: RunRow,
        scenario: ScenarioRow,
    ) -> None:
        self.finding = finding
        self.occurrence = occurrence
        self.run_scenario = run_scenario
        self.run = run
        self.scenario = scenario

    @property
    def attempt(self) -> int:
        return self.occurrence.attempt or 0


async def load_source(
    session: AsyncSession, finding_id: uuid.UUID, occurrence_id: uuid.UUID | None
) -> ReproSource:
    finding = await session.get(FindingRow, finding_id)
    if finding is None:
        raise FindingMissingError(f"finding {finding_id} does not exist")
    occurrence = await pick_occurrence(session, finding_id, occurrence_id)
    if occurrence is None or occurrence.run_scenario_id is None:
        raise ReproUnavailableError(f"finding {finding_id} has no occurrence with a run scenario")
    run_scenario = await session.get(RunScenarioRow, occurrence.run_scenario_id)
    run = await session.get(RunRow, occurrence.run_id)
    scenario = (
        None if run_scenario is None else await session.get(ScenarioRow, run_scenario.scenario_id)
    )
    if run_scenario is None or run is None or scenario is None:
        raise ReproUnavailableError(f"finding {finding_id} lost the rows its occurrence points at")
    return ReproSource(finding, occurrence, run_scenario, run, scenario)


def evidence_value(occurrence: FindingOccurrenceRow, key: str) -> JsonValue:
    value = occurrence.evidence.get(key)
    return value if isinstance(value, str | int | float | bool | list | dict) else None


async def build_stored_repro(
    session: AsyncSession, finding_id: uuid.UUID, occurrence_id: uuid.UUID | None = None
) -> StoredFindingRepro:
    source = await load_source(session, finding_id, occurrence_id)
    run, run_scenario, occurrence = source.run, source.run_scenario, source.occurrence
    snapshot = snapshot_of(run)
    bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
    failing_step = (
        None if occurrence.step_id is None else await session.get(StepRow, occurrence.step_id)
    )
    browser_session = await session.scalar(
        select(BrowserSessionRow).where(
            BrowserSessionRow.run_scenario_id == run_scenario.id,
            BrowserSessionRow.attempt == source.attempt,
        )
    )
    return StoredFindingRepro(
        schema_version=FINDING_REPRO_SCHEMA_VERSION,
        finding_id=finding_id,
        run_id=run.id,
        run_scenario_id=run_scenario.id,
        attempt=source.attempt,
        bundle_version=(
            snapshot.bundle_version
            if snapshot is not None and snapshot.bundle_version is not None
            else (bundle.version if bundle is not None else 1)
        ),
        scenario_id=source.scenario.id,
        scenario_version=run_scenario.scenario_version,
        scenario_yaml=await scenario_text(session, source.scenario, run_scenario.scenario_version),
        seed=await seed_of(session, bundle, snapshot),
        clock=clock_of(run, snapshot),
        browser_session_id=None if browser_session is None else browser_session.id,
        transcript=await transcript_of(session, run_scenario.id, source.attempt),
        screencast=await screencast_of(session, browser_session, failing_step),
        expected=evidence_value(occurrence, "expected"),
        actual=evidence_value(occurrence, "actual"),
        oracle_rows=await oracle_rows_of(session, failing_step),
        invariant_id=source.finding.invariant_id,
    )


async def store_repro(
    session: AsyncSession, finding_id: uuid.UUID, occurrence_id: uuid.UUID | None = None
) -> int:
    stored = await build_stored_repro(session, finding_id, occurrence_id)
    document = stored.model_dump(mode="json")
    finding = await session.get(FindingRow, finding_id, with_for_update=True)
    if finding is None:
        raise FindingMissingError(f"finding {finding_id} does not exist")
    finding.repro = document
    await session.flush()
    return len(json.dumps(document, separators=(",", ":")).encode("utf-8"))


def parsed_stored_repro(document: Mapping[str, Any] | None) -> StoredFindingRepro | None:
    if document is None:
        return None
    try:
        return StoredFindingRepro.model_validate(document)
    except ValidationError:
        return None


def to_finding_repro(stored: StoredFindingRepro, signer: ArtifactSigner) -> FindingRepro:
    data = stored.model_dump(exclude={"schema_version", "screencast"})
    return FindingRepro(
        **data, screencast=[signer.reference(artifact) for artifact in stored.screencast]
    )


async def read_repro(
    session: AsyncSession, signer: ArtifactSigner, finding_id: uuid.UUID
) -> FindingRepro:
    finding = await session.get(FindingRow, finding_id)
    if finding is None:
        raise not_found("Finding not found")
    stored = parsed_stored_repro(finding.repro)
    if stored is None:
        try:
            await store_repro(session, finding_id)
        except ReproUnavailableError:
            raise not_found("No run recorded this finding, so there is no repro") from None
        await session.commit()
        stored = parsed_stored_repro(finding.repro)
    if stored is None:
        raise not_found("The repro of this finding could not be built")
    return to_finding_repro(stored, signer)
