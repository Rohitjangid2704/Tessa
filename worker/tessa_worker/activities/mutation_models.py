from uuid import UUID

from pydantic import BaseModel, Field

PREPARE_MUTATION_RUN = "prepare_mutation_run"
VERIFY_DEPLOYED_MARKER = "verify_deployed_marker"
RESOLVE_BASELINE_RUN = "resolve_baseline_run"
CLOSE_MUTATION_RUN = "close_mutation_run"

MUTATION_RUN_NOT_FOUND = "mutation_run_not_found"
MUTANT_NOT_DEPLOYED = "mutant_not_deployed"
OVERRIDE_NOT_APPLICABLE = "override_not_applicable"
MARKER_UNREACHABLE = "marker_unreachable"
BASELINE_UNUSABLE = "baseline_unusable"

MARKER_REASON_MAX_CHARS = 300


class PrepareMutationRunInput(BaseModel):
    run_id: UUID
    mutation_run_id: UUID


class MutationRunContext(BaseModel):
    target_id: UUID
    mutant_name: str
    marker_declared: bool = Field(description="the mutant declares a deployed marker to verify")
    max_concurrency: int = Field(ge=1, description="the effective run concurrency")


class VerifyDeployedMarkerInput(BaseModel):
    mutation_run_id: UUID


class VerifiedMarker(BaseModel):
    checked: bool = Field(description="false when the mutant declares no marker")
    ok: bool = Field(description="the marker text was found, or there was no marker to check")
    reason: str | None = Field(
        max_length=MARKER_REASON_MAX_CHARS, description="why the marker check failed"
    )


class ResolveBaselineInput(BaseModel):
    run_id: UUID
    mutation_run_id: UUID


class ResolvedBaseline(BaseModel):
    baseline_run_id: UUID
    reused: bool = Field(
        description="true when a completed suite run is reused, false when the baseline run was "
        "created and still has to run"
    )


class CloseMutationRunInput(BaseModel):
    mutation_run_id: UUID
