import logging
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import DedupeMode
from tessa_api.schemas.temporal import (
    BUILD_REPRO_BUNDLE_ACTIVITY,
    DEDUPE_FINDINGS_ACTIVITY,
    FINDINGS_START_TO_CLOSE,
    FINGERPRINT_FINDINGS_ACTIVITY,
    UPSERT_FINDINGS_ACTIVITY,
    BuildReproBundleInput,
    BuildReproBundleResult,
    DedupeFindingsInput,
    DedupeFindingsResult,
    DedupeMatch,
    FindingCandidate,
    FingerprintFindingsInput,
    FingerprintFindingsResult,
    UpsertFindingsInput,
    UpsertFindingsResult,
)
from tessa_api.services.findings.candidates import RunNotFoundError, build_run_candidates
from tessa_api.services.findings.events import updated_event
from tessa_api.services.findings.neighbours import (
    Neighbour,
    exact_matches,
    nearest_neighbour,
)
from tessa_api.services.findings.repro import (
    FindingMissingError,
    ReproUnavailableError,
    store_repro,
)
from tessa_api.services.findings.resolution import resolve_findings_after_run
from tessa_api.services.findings.upsert import UpsertTargetMissingError, upsert_decisions
from tessa_api.services.probe_bank import ProbeBankError, load_probe_bank
from tessa_api.services.probe_specs import ProbeSpec, listed_specs
from tessa_api.services.seed_resolution import parse_stored_manifest
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.findings_models import (
    RESOLVE_FINDINGS,
    ResolveFindingsInput,
    ResolveFindingsResult,
)
from tessa_worker.activities.tier0 import permanent
from tessa_worker.event_client import EventClient
from tessa_worker.findings.duplicates import (
    close_pair_match,
    duplicate_request,
    exact_match,
    new_match,
)
from tessa_worker.grading.laya_client import ChoiceRequest, LayaClient
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.findings")

LAYA_DEADLINE_MARGIN_SECONDS = 10.0


@dataclass(frozen=True, slots=True)
class ClosePair:
    index: int
    candidate: FindingCandidate
    neighbour: Neighbour


@dataclass(frozen=True, slots=True)
class MatchPlan:
    settled: Mapping[int, DedupeMatch]
    close_pairs: Sequence[ClosePair]


def missing_run(run_id: uuid.UUID) -> ApplicationError:
    return permanent(f"run {run_id} does not exist or has no target")


class FindingActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        laya_http: httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.laya_http = laya_http

    @activity.defn(name=FINGERPRINT_FINDINGS_ACTIVITY)
    async def fingerprint_findings(
        self, request: FingerprintFindingsInput
    ) -> FingerprintFindingsResult:
        async with self.session_factory() as session:
            specs = await self.probe_specs_of(session, request.run_id)
            try:
                candidates = await build_run_candidates(session, request.run_id, specs)
            except RunNotFoundError as error:
                raise permanent(str(error)) from None
        return FingerprintFindingsResult(candidates=candidates)

    @activity.defn(name=DEDUPE_FINDINGS_ACTIVITY)
    async def dedupe_findings(self, request: DedupeFindingsInput) -> DedupeFindingsResult:
        started = time.monotonic()
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            if run is None or run.target_id is None:
                raise missing_run(request.run_id)
            settings = await effective_settings(session, self.settings)
            plan = await self.plan_matches(session, run.target_id, request)
        decided = await self.decide_close_pairs(plan.close_pairs, settings, started)
        matches = {**plan.settled, **decided}
        return DedupeFindingsResult(
            matches=[matches[index] for index in range(len(request.candidates))]
        )

    @activity.defn(name=UPSERT_FINDINGS_ACTIVITY)
    async def upsert_findings(self, request: UpsertFindingsInput) -> UpsertFindingsResult:
        async with self.session_factory() as session:
            try:
                outcome = await upsert_decisions(session, request.run_id, request.decisions)
            except UpsertTargetMissingError as error:
                raise permanent(str(error)) from None
            await session.commit()
        await self.events.deliver_all(outcome.events)
        return UpsertFindingsResult(
            created=len(outcome.created_ids),
            updated=len(outcome.updated_ids),
            occurrences_added=outcome.occurrences_added,
            known_gap_hits=outcome.known_gap_hits,
            created_finding_ids=list(outcome.needs_repro),
        )

    @activity.defn(name=BUILD_REPRO_BUNDLE_ACTIVITY)
    async def build_repro_bundle(self, request: BuildReproBundleInput) -> BuildReproBundleResult:
        async with self.session_factory() as session:
            try:
                size = await store_repro(session, request.finding_id, request.occurrence_id)
            except FindingMissingError as error:
                raise permanent(str(error)) from None
            except ReproUnavailableError as error:
                logger.info("repro_unavailable", extra={"reason": str(error)})
                return BuildReproBundleResult(
                    finding_id=request.finding_id, stored=False, size_bytes=0
                )
            await session.commit()
        return BuildReproBundleResult(finding_id=request.finding_id, stored=True, size_bytes=size)

    @activity.defn(name=RESOLVE_FINDINGS)
    async def resolve_findings(self, request: ResolveFindingsInput) -> ResolveFindingsResult:
        async with self.session_factory() as session:
            resolutions = await resolve_findings_after_run(session, request.run_id)
            await session.commit()
        await self.events.deliver_all(
            [updated_event(item.finding_id, item.changes) for item in resolutions]
        )
        return ResolveFindingsResult(resolved_finding_ids=[item.finding_id for item in resolutions])

    async def probe_specs_of(
        self, session: AsyncSession, run_id: uuid.UUID
    ) -> dict[str, ProbeSpec]:
        run = await session.get(RunRow, run_id)
        bundle = (
            None
            if run is None or run.bundle_id is None
            else await session.get(BundleRow, run.bundle_id)
        )
        manifest = None if bundle is None else parse_stored_manifest(bundle)
        try:
            bank = load_probe_bank(self.settings.probes_dir)
        except ProbeBankError as error:
            logger.warning(
                "probe_bank_unavailable_for_findings", extra={"reason": str(error)[:200]}
            )
            return {}
        return {spec.id: spec for spec in listed_specs(bank, manifest)}

    async def plan_matches(
        self, session: AsyncSession, target_id: uuid.UUID, request: DedupeFindingsInput
    ) -> MatchPlan:
        existing = await exact_matches(
            session, target_id, [candidate.fingerprint for candidate in request.candidates]
        )
        settled: dict[int, DedupeMatch] = {}
        close_pairs: list[ClosePair] = []
        for index, candidate in enumerate(request.candidates):
            known = existing.get(candidate.fingerprint)
            if known is not None:
                settled[index] = exact_match(candidate, known)
                continue
            neighbour = await self.neighbour_of(session, target_id, candidate, request.dedupe_mode)
            if neighbour is None:
                settled[index] = new_match(candidate)
            else:
                close_pairs.append(ClosePair(index, candidate, neighbour))
        return MatchPlan(settled=settled, close_pairs=close_pairs)

    async def neighbour_of(
        self,
        session: AsyncSession,
        target_id: uuid.UUID,
        candidate: FindingCandidate,
        mode: DedupeMode,
    ) -> Neighbour | None:
        if mode is not DedupeMode.embedding or candidate.embedding is None:
            return None
        return await nearest_neighbour(
            session,
            target_id,
            candidate.finding_class,
            candidate.embedding,
            self.settings.finding_dedupe_threshold,
        )

    async def decide_close_pairs(
        self, pairs: Sequence[ClosePair], settings: WorkerSettings, started: float
    ) -> dict[int, DedupeMatch]:
        if not pairs:
            return {}
        requests: list[ChoiceRequest] = [
            duplicate_request(
                f"duplicate-{pair.index}",
                pair.candidate,
                pair.neighbour,
                settings.probe_confidence_threshold,
            )
            for pair in pairs
        ]
        deadline = started + FINDINGS_START_TO_CLOSE.total_seconds() - LAYA_DEADLINE_MARGIN_SECONDS
        client = LayaClient(self.laya_http, settings.laya_url, float(settings.laya_timeout_seconds))
        decisions = await client.choose(requests, deadline)
        return {
            pair.index: close_pair_match(pair.candidate, pair.neighbour, decision)
            for pair, decision in zip(pairs, decisions, strict=True)
        }
