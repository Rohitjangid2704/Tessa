from datetime import timedelta
from uuid import UUID

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from tessa_api.schemas.enums import DedupeMode
    from tessa_api.schemas.model_calls import EmbedCallSpec
    from tessa_api.schemas.temporal import (
        APPLY_FLAKINESS_POLICY_ACTIVITY,
        BUILD_REPRO_BUNDLE_ACTIVITY,
        DEDUPE_FINDINGS_ACTIVITY,
        EMBED_TEXTS_ACTIVITY,
        FINDING_TRIAGE_BATCH_SIZE,
        FINDINGS_START_TO_CLOSE,
        FINGERPRINT_FINDINGS_ACTIVITY,
        FLAKINESS_START_TO_CLOSE,
        RESOLVE_MODEL_SPECS_ACTIVITY,
        TRIAGE_FINDINGS_WORKFLOW,
        UPSERT_FINDINGS_ACTIVITY,
        ApplyFlakinessPolicyInput,
        ApplyFlakinessPolicyResult,
        BuildReproBundleInput,
        BuildReproBundleResult,
        DedupeFindingsInput,
        DedupeFindingsResult,
        EmbedTextsInput,
        EmbedTextsOutput,
        FindingCandidate,
        FingerprintFindingsInput,
        FingerprintFindingsResult,
        ResolveModelSpecsResult,
        TriageFindingsInput,
        TriageFindingsResult,
        UpsertDecision,
        UpsertFindingsInput,
        UpsertFindingsResult,
    )
    from tessa_worker.activities.findings_models import (
        RESOLVE_FINDINGS,
        ResolveFindingsInput,
        ResolveFindingsResult,
    )
    from tessa_worker.workflows.calls import (
        call_activity,
        call_activity_without_argument,
        failure_text,
    )

EMBED_TIMEOUT_MARGIN = timedelta(seconds=10)


def batches_of(candidates: list[FindingCandidate]) -> list[list[FindingCandidate]]:
    return [
        candidates[start : start + FINDING_TRIAGE_BATCH_SIZE]
        for start in range(0, len(candidates), FINDING_TRIAGE_BATCH_SIZE)
    ]


@workflow.defn(name=TRIAGE_FINDINGS_WORKFLOW)
class TriageFindingsWorkflow:
    def __init__(self) -> None:
        self.mode = DedupeMode.embedding
        self.created = 0
        self.updated = 0
        self.occurrences_added = 0
        self.known_gap_hits = 0
        self.repro_ids: list[UUID] = []

    @workflow.run
    async def run(self, request: TriageFindingsInput) -> TriageFindingsResult:
        fingerprinted = await call_activity(
            FINGERPRINT_FINDINGS_ACTIVITY,
            FingerprintFindingsInput(run_id=request.run_id),
            FingerprintFindingsResult,
            FINDINGS_START_TO_CLOSE,
        )
        spec = await self.embed_spec(fingerprinted.candidates)
        for batch in batches_of(fingerprinted.candidates):
            await self.triage_batch(request.run_id, batch, spec)
        await self.build_repros()
        await self.resolve_verified(request.run_id)
        await self.apply_flakiness_policy(request.run_id)
        return TriageFindingsResult(
            created=self.created,
            updated=self.updated,
            occurrences_added=self.occurrences_added,
            known_gap_hits=self.known_gap_hits,
            dedupe_mode=self.mode,
        )

    async def embed_spec(self, candidates: list[FindingCandidate]) -> EmbedCallSpec | None:
        if not candidates:
            return None
        try:
            specs = await call_activity_without_argument(
                RESOLVE_MODEL_SPECS_ACTIVITY, ResolveModelSpecsResult
            )
        except ActivityError as error:
            self.fall_back_to_exact("the embedding spec could not be resolved", error)
            return None
        return specs.embed

    def fall_back_to_exact(self, reason: str, error: ActivityError) -> None:
        self.mode = DedupeMode.exact_only
        workflow.logger.warning(
            "finding_dedupe_exact_only", extra={"reason": reason, "cause": failure_text(error)}
        )

    async def triage_batch(
        self, run_id: UUID, batch: list[FindingCandidate], spec: EmbedCallSpec | None
    ) -> None:
        prepared, batch_mode = await self.embedded(run_id, batch, spec)
        deduped = await call_activity(
            DEDUPE_FINDINGS_ACTIVITY,
            DedupeFindingsInput(run_id=run_id, candidates=prepared, dedupe_mode=batch_mode),
            DedupeFindingsResult,
            FINDINGS_START_TO_CLOSE,
        )
        matches = {match.fingerprint: match for match in deduped.matches}
        upserted = await call_activity(
            UPSERT_FINDINGS_ACTIVITY,
            UpsertFindingsInput(
                run_id=run_id,
                decisions=[
                    UpsertDecision(candidate=candidate, match=matches[candidate.fingerprint])
                    for candidate in prepared
                ],
            ),
            UpsertFindingsResult,
            FINDINGS_START_TO_CLOSE,
        )
        self.accumulate(upserted)

    async def embedded(
        self, run_id: UUID, batch: list[FindingCandidate], spec: EmbedCallSpec | None
    ) -> tuple[list[FindingCandidate], DedupeMode]:
        if self.mode is DedupeMode.exact_only or spec is None:
            return batch, DedupeMode.exact_only
        try:
            output = await workflow.execute_activity(
                EMBED_TEXTS_ACTIVITY,
                EmbedTextsInput(
                    run_id=run_id, texts=[item.embedding_text for item in batch], spec=spec
                ),
                result_type=EmbedTextsOutput,
                start_to_close_timeout=timedelta(seconds=spec.start_to_close_timeout_seconds)
                + EMBED_TIMEOUT_MARGIN,
                retry_policy=RetryPolicy(maximum_attempts=spec.max_attempts),
            )
        except ActivityError as error:
            self.fall_back_to_exact("embeddings failed", error)
            return batch, DedupeMode.exact_only
        vectors = output.vectors
        return (
            [
                candidate.model_copy(update={"embedding": vector})
                for candidate, vector in zip(batch, vectors, strict=True)
            ],
            DedupeMode.embedding,
        )

    def accumulate(self, upserted: UpsertFindingsResult) -> None:
        self.created += upserted.created
        self.updated += upserted.updated
        self.occurrences_added += upserted.occurrences_added
        self.known_gap_hits += upserted.known_gap_hits
        for finding_id in upserted.created_finding_ids:
            if finding_id not in self.repro_ids:
                self.repro_ids.append(finding_id)

    async def build_repros(self) -> None:
        for finding_id in self.repro_ids:
            try:
                await call_activity(
                    BUILD_REPRO_BUNDLE_ACTIVITY,
                    BuildReproBundleInput(finding_id=finding_id),
                    BuildReproBundleResult,
                    FINDINGS_START_TO_CLOSE,
                )
            except ActivityError as error:
                workflow.logger.warning(
                    "repro_not_built",
                    extra={"finding_id": str(finding_id), "cause": failure_text(error)},
                )

    async def resolve_verified(self, run_id: UUID) -> None:
        try:
            await call_activity(
                RESOLVE_FINDINGS,
                ResolveFindingsInput(run_id=run_id),
                ResolveFindingsResult,
                FINDINGS_START_TO_CLOSE,
            )
        except ActivityError as error:
            workflow.logger.warning("findings_not_resolved", extra={"cause": failure_text(error)})

    async def apply_flakiness_policy(self, run_id: UUID) -> None:
        try:
            await call_activity(
                APPLY_FLAKINESS_POLICY_ACTIVITY,
                ApplyFlakinessPolicyInput(run_id=run_id),
                ApplyFlakinessPolicyResult,
                FLAKINESS_START_TO_CLOSE,
            )
        except ActivityError as error:
            workflow.logger.warning(
                "flakiness_policy_not_applied", extra={"cause": failure_text(error)}
            )


__all__ = ["TriageFindingsWorkflow"]
