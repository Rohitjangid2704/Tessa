import uuid
from dataclasses import dataclass
from typing import Any

import yaml
from sqlalchemy.ext.asyncio import AsyncSession
from yaml import YAMLError

from tessa_api.db.models import FindingRow, RunScenarioRow, ScenarioRow, ScenarioVersionRow
from tessa_api.errors import ApiError, not_found
from tessa_api.schemas.enums import CoverageUpdateReason, FindingClass, ScenarioOrigin
from tessa_api.schemas.findings import PROMOTED_SCENARIO_TITLE_MAX_LENGTH, PromoteFindingCreate
from tessa_api.schemas.scenarios import Scenario
from tessa_api.schemas.streams import IngestEvent
from tessa_api.services.findings.events import updated_event
from tessa_api.services.findings.repro import pick_occurrence
from tessa_api.services.grading_rules import clip_text
from tessa_api.services.scenario_library import to_scenario
from tessa_api.services.scenario_lifecycle import (
    NewScenario,
    ProvenanceInput,
    check_for_target,
    conflict_error,
    create_scenario_row,
    lifecycle_events,
    require_valid,
)

TITLE_PREFIX = "Regression: "
DROPPED_HEADER_KEYS = ("id", "authored_from")
FINDING_LOCATION = ("path", "finding_id")


@dataclass(frozen=True, slots=True)
class PromotedFinding:
    scenario: Scenario
    events: list[IngestEvent]
    finding_event: IngestEvent


@dataclass(frozen=True, slots=True)
class PromotionSource:
    scenario: ScenarioRow
    run_scenario: RunScenarioRow
    text: str


def not_promotable(message: str, code: str) -> ApiError:
    return conflict_error(message, FINDING_LOCATION, code, message)


def default_title(finding: FindingRow) -> str:
    return clip_text(f"{TITLE_PREFIX}{finding.title}", PROMOTED_SCENARIO_TITLE_MAX_LENGTH)


def retitled_text(source_text: str, title: str) -> str:
    try:
        document: Any = yaml.safe_load(source_text)
    except YAMLError:
        raise not_promotable(
            "The scenario of this finding cannot be read as YAML", "scenario_unreadable"
        ) from None
    if not isinstance(document, dict):
        raise not_promotable(
            "The scenario of this finding is not a YAML mapping", "scenario_unreadable"
        )
    for key in DROPPED_HEADER_KEYS:
        document.pop(key, None)
    document["title"] = title
    return yaml.safe_dump(document, sort_keys=False, allow_unicode=True, width=100)


async def promotion_source(session: AsyncSession, finding: FindingRow) -> PromotionSource:
    occurrence = await pick_occurrence(session, finding.id, None)
    run_scenario = (
        None
        if occurrence is None or occurrence.run_scenario_id is None
        else await session.get(RunScenarioRow, occurrence.run_scenario_id)
    )
    scenario = (
        None if run_scenario is None else await session.get(ScenarioRow, run_scenario.scenario_id)
    )
    if run_scenario is None or scenario is None:
        raise not_promotable(
            "No run scenario recorded this finding, so there is nothing to promote",
            "no_source_scenario",
        )
    if scenario.parsed.get("synthetic") is True:
        raise not_promotable(
            "Synthetic scenarios already run in every run and cannot be promoted",
            "synthetic_scenario",
        )
    version = await session.get(ScenarioVersionRow, (scenario.id, run_scenario.scenario_version))
    return PromotionSource(
        scenario=scenario,
        run_scenario=run_scenario,
        text=scenario.yaml if version is None else version.yaml,
    )


def ensure_promotable(finding: FindingRow) -> None:
    if finding.promoted_scenario_id is not None:
        raise not_promotable(
            f"This finding was already promoted to scenario {finding.promoted_scenario_id}",
            "already_promoted",
        )
    if finding.class_ is FindingClass.harness:
        raise not_promotable(
            "Harness findings come from Tessa itself and have no application case to promote",
            "harness_finding",
        )


async def promote_finding(
    session: AsyncSession, user_id: uuid.UUID, finding_id: uuid.UUID, body: PromoteFindingCreate
) -> PromotedFinding:
    finding = await session.get(FindingRow, finding_id, with_for_update=True)
    if finding is None:
        raise not_found("Finding not found")
    ensure_promotable(finding)
    source = await promotion_source(session, finding)
    title = body.title or default_title(finding)
    text = retitled_text(source.text, title)
    checked = await check_for_target(session, finding.target_id, text)
    valid = require_valid(text, checked.check)
    write = await create_scenario_row(
        session,
        NewScenario(
            bundle=checked.bundle,
            valid=valid,
            origin=ScenarioOrigin.promoted_finding,
            created_by=user_id,
            cell_id=source.scenario.cell_id,
            note=f"Promoted from finding {finding.id}",
            provenance=ProvenanceInput(
                finding_id=finding.id,
                ticket_url=finding.ticket_url,
                details={
                    "source_scenario_id": str(source.scenario.id),
                    "source_run_id": str(source.run_scenario.run_id),
                },
            ),
        ),
    )
    finding.promoted_scenario_id = write.row.id
    await session.commit()
    return PromotedFinding(
        scenario=to_scenario(write.row),
        events=lifecycle_events(write, CoverageUpdateReason.review),
        finding_event=updated_event(
            finding.id, {"promoted_scenario_id": (None, str(write.row.id))}
        ),
    )
