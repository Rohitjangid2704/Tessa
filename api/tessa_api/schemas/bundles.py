from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import UploadFile
from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import (
    BundleChange,
    BundleCompletenessStatus,
    BundleSourceKind,
    BundleValidationStatus,
)

BundleNote = Annotated[str, Field(max_length=500)]


class BundleUploadForm(BaseModel):
    file: UploadFile = Field(description="zip of the tessa folder, application/zip")
    target_id: UUID | None = Field(
        default=None, description="when present it must match the target token of the manifest"
    )
    note: BundleNote | None = None


class BundlePasteCreate(BaseModel):
    target_id: UUID | None = None
    manifest_yaml: str = Field(min_length=1)
    note: BundleNote | None = None


class BundleValidationError(BaseModel):
    code: str
    message: str
    severity: Literal["error", "warning"]
    file: str
    pointer: str | None = Field(default=None, description="JSON pointer into the manifest")
    line: int | None = None
    column: int | None = None


class BundleCompletenessCheck(BaseModel):
    id: str
    label: str
    passed: bool = Field(description="true when earned equals weight")
    weight: int
    earned: int = Field(description="points from 0 to weight")
    detail: str | None = None
    fix_hint: str | None = None


class BundleCompleteness(BaseModel):
    score: int = Field(ge=0, le=100, description="sum of earned over all checks")
    bar: int = Field(description="minimum score for meets_bar")
    status: BundleCompletenessStatus
    checks: list[BundleCompletenessCheck]


class BundleDiffSummary(BaseModel):
    against_bundle_id: UUID | None = None
    against_version: int | None = None
    features_added: int
    features_removed: int
    features_changed: int


class BundleHookMissing(BaseModel):
    id: str
    description: str


class Bundle(BaseModel):
    id: UUID
    target_id: UUID
    version: int
    hash: str
    source: BundleSourceKind
    note: str | None = None
    schema_version: int
    uploaded_by: UUID
    uploaded_at: Timestamp
    validation_status: BundleValidationStatus
    errors: list[BundleValidationError]
    warnings: list[BundleValidationError]
    completeness: BundleCompleteness
    diff_summary: BundleDiffSummary | None
    feature_count: int
    file_count: int
    size_bytes: int
    hooks_missing: list[BundleHookMissing]
    scenarios_imported: int = Field(
        description="authored scenarios this upload created or versioned from scenarios/*.yaml"
    )
    mutants_imported: int = Field(
        description="mutants this upload registered from tessa/mutants.yaml"
    )
    commit_sha: str | None = Field(
        default=None,
        description="commit of the repository the bundle was produced from, from the source "
        "section of the manifest; null when the manifest names none",
    )
    branch: str | None = Field(
        default=None, description="branch of that commit, from the source section of the manifest"
    )


class FixupItem(BaseModel):
    kind: Literal["error", "check", "warning"] = Field(
        description="error and warning come from validation, check from a completeness point"
    )
    location: str = Field(description="file, pointer and line, or the completeness check")
    message: str
    fix_hint: str | None = None


class ProposalCheck(BaseModel):
    items: int = Field(ge=0, description="items of tessa/proposal.yaml that parsed")
    errors: list[BundleValidationError] = Field(
        description="problems that keep the proposal from being imported; they never make the "
        "bundle itself invalid"
    )
    warnings: list[BundleValidationError]


class BundleValidationReport(BaseModel):
    validation_status: BundleValidationStatus
    errors: list[BundleValidationError]
    warnings: list[BundleValidationError]
    completeness: BundleCompleteness
    diff_summary: BundleDiffSummary | None = Field(
        description="against the latest valid version of the target; null without a target"
    )
    fixup_items: list[FixupItem] = Field(
        description="everything that is open, errors first, in the order the Fix-up prompt "
        "would list it"
    )
    hooks_missing: list[BundleHookMissing]
    feature_count: int
    file_count: int
    size_bytes: int
    commit_sha: str | None
    branch: str | None
    proposal: ProposalCheck | None = Field(
        description="check of tessa/proposal.yaml; null when the bundle has none"
    )


class BundleSummary(BaseModel):
    id: UUID
    version: int
    hash: str
    source: BundleSourceKind
    validation_status: BundleValidationStatus
    completeness_score: int
    completeness_status: BundleCompletenessStatus
    feature_count: int
    uploaded_at: Timestamp


class BundleSummaryPage(BaseModel):
    items: list[BundleSummary]
    next_cursor: str | None
    total: int | None


class BundleUploadResult(BaseModel):
    bundle: Bundle
    created: bool = Field(description="false when the identical content already existed")
    dry_run_run_id: UUID | None = Field(
        description="generate run that dry-runs the imported scenarios in the background; null "
        "when none were imported or the target is a production target"
    )


class BundleDiffFeature(BaseModel):
    feature_id: str
    change: BundleChange
    fields_changed: list[str]
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class BundleDiffSection(BaseModel):
    section: str
    change: BundleChange


class BundleDiff(BaseModel):
    bundle_id: UUID
    against_bundle_id: UUID | None
    features: list[BundleDiffFeature]
    sections: list[BundleDiffSection]
    summary: str


class BundleFileEntry(BaseModel):
    path: str
    size_bytes: int
    sha256: str


class BundleFileList(BaseModel):
    items: list[BundleFileEntry]


class BundleFileContent(BaseModel):
    path: str
    content: str
    truncated: bool
