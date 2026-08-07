import uuid
from collections.abc import Mapping
from typing import Any

from tessa_api.db.models import (
    BundleRow,
    ScenarioProvenanceRow,
    ScenarioRow,
    ScenarioVersionRow,
)


def version_row(
    row: ScenarioRow, created_by: uuid.UUID | None, note: str | None
) -> ScenarioVersionRow:
    return ScenarioVersionRow(
        scenario_id=row.id,
        version=row.version,
        yaml=row.yaml,
        parsed=row.parsed,
        created_by=created_by,
        note=note,
    )


def provenance_row(
    row: ScenarioRow,
    bundle: BundleRow,
    finding_id: uuid.UUID | None = None,
    ticket_url: str | None = None,
    prompt_issue_id: uuid.UUID | None = None,
    generator: Mapping[str, Any] | None = None,
) -> ScenarioProvenanceRow:
    return ScenarioProvenanceRow(
        scenario_id=row.id,
        cell_id=row.cell_id,
        bundle_id=bundle.id,
        bundle_version=bundle.version,
        finding_id=finding_id,
        ticket_url=ticket_url,
        prompt_issue_id=prompt_issue_id,
        generator=dict(generator) if generator else None,
        dry_runs=[],
    )
