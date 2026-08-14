import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

import httpx
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity

from tessa_api.db.models import (
    BundleRow,
    ProbeResultRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
)
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import ProbeEngine
from tessa_api.schemas.grading import ProbeBatchResult
from tessa_api.schemas.probes import ProbeResult
from tessa_api.schemas.temporal import (
    LAYA_PROBES_START_TO_CLOSE,
    RUN_LAYA_PROBES_ACTIVITY,
    RunLayaProbesInput,
)
from tessa_api.services.probe_bank import ProbeBank, ProbeBankError, load_probe_bank
from tessa_api.services.probe_specs import (
    ProbeContext,
    ProbeSpec,
    StepTexts,
    available_field_values,
    build_probe_context,
    has_every_input,
    listed_specs,
    parse_manifest,
    probe_pool,
    select_probes,
    step_texts,
)
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.tier0 import permanent, required
from tessa_worker.grading.laya_client import LayaClient, LayaDecision, ProbeRequest
from tessa_worker.settings import WorkerSettings

DEADLINE_MARGIN_SECONDS = 5.0


@dataclass(frozen=True, slots=True)
class StepMaterial:
    run_id: uuid.UUID
    texts: StepTexts
    context: ProbeContext
    manifest: BundleManifest | None


def tool_names_of(row: StepRow) -> list[str]:
    return [str(tool.get("name", "")) for tool in row.tools]


async def load_step_material(session: AsyncSession, step_id: uuid.UUID) -> StepMaterial:
    row = await required(session, StepRow, step_id, "step")
    run_scenario = await required(session, RunScenarioRow, row.run_scenario_id, "run scenario")
    scenario = await required(session, ScenarioRow, run_scenario.scenario_id, "scenario")
    run = await required(session, RunRow, row.run_id, "run")
    bundle = await required(session, BundleRow, run.bundle_id or scenario.bundle_id, "bundle")
    manifest = parse_manifest(bundle.manifest)
    return StepMaterial(
        run_id=row.run_id,
        texts=step_texts(row.ask, row.answer, tool_names_of(row), row.cards),
        context=build_probe_context(manifest, scenario.feature_id, row.adapter),
        manifest=manifest,
    )


def requested_specs(
    bank: ProbeBank, material: StepMaterial, probe_ids: Sequence[str]
) -> list[ProbeSpec]:
    by_id = {spec.id: spec for spec in listed_specs(bank, material.manifest)}
    unknown = [probe_id for probe_id in dict.fromkeys(probe_ids) if probe_id not in by_id]
    if unknown:
        raise permanent(f"unknown probes: {', '.join(unknown)}")
    return [by_id[probe_id] for probe_id in dict.fromkeys(probe_ids)]


def probe_requests(
    specs: Sequence[ProbeSpec],
    material: StepMaterial,
    global_threshold: float,
    explicit: bool,
) -> tuple[list[ProbeSpec], list[ProbeRequest]]:
    selected: list[ProbeSpec] = []
    requests: list[ProbeRequest] = []
    for spec in specs:
        values = available_field_values(spec, material.texts, material.context)
        if not explicit and not has_every_input(spec, values):
            continue
        selected.append(spec)
        threshold = spec.effective_threshold(global_threshold)
        requests.append(ProbeRequest(spec, values, threshold))
    return selected, requests


def result_row(
    run_id: uuid.UUID,
    step_id: uuid.UUID,
    spec: ProbeSpec,
    decision: LayaDecision,
    bank_version: str,
) -> ProbeResultRow:
    return ProbeResultRow(
        id=new_id(),
        step_id=step_id,
        run_id=run_id,
        probe_id=spec.id,
        pack=spec.pack,
        question=spec.question,
        answer=decision.answer,
        status=decision.status,
        confidence=min(max(decision.confidence, 0.0), 1.0),
        threshold=decision.threshold,
        latency_ms=decision.latency_ms,
        probe_bank_version=bank_version,
        engine=ProbeEngine.laya,
    )


def probe_result(row: ProbeResultRow) -> ProbeResult:
    return ProbeResult(
        id=row.id,
        probe_id=row.probe_id,
        pack=row.pack,
        question=row.question,
        answer=row.answer,
        status=row.status,
        confidence=row.confidence,
        threshold=row.threshold,
        latency_ms=row.latency_ms,
        probe_bank_version=row.probe_bank_version,
        engine=row.engine,
    )


class ProbeActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        laya_http: httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.laya_http = laya_http

    @activity.defn(name=RUN_LAYA_PROBES_ACTIVITY)
    async def run_laya_probes(self, request: RunLayaProbesInput) -> ProbeBatchResult:
        deadline = time.monotonic() + LAYA_PROBES_START_TO_CLOSE.total_seconds()
        async with self.session_factory() as session:
            settings = await effective_settings(session, self.settings)
            material = await load_step_material(session, request.step_id)
            bank = self.read_bank(settings)
        explicit = bool(request.probe_ids)
        specs = (
            requested_specs(bank, material, request.probe_ids)
            if explicit
            else select_probes(probe_pool(bank, material.manifest), material.context)
        )
        selected, requests = probe_requests(
            specs, material, settings.probe_confidence_threshold, explicit
        )
        client = LayaClient(self.laya_http, settings.laya_url, float(settings.laya_timeout_seconds))
        decisions = await client.decide(requests, deadline - DEADLINE_MARGIN_SECONDS)
        rows = [
            result_row(material.run_id, request.step_id, spec, decision, bank.version)
            for spec, decision in zip(selected, decisions, strict=True)
        ]
        await self.replace_results(request.step_id, rows)
        return ProbeBatchResult(results=[probe_result(row) for row in rows])

    def read_bank(self, settings: WorkerSettings) -> ProbeBank:
        try:
            return load_probe_bank(settings.probes_dir)
        except ProbeBankError as error:
            raise permanent(f"the probe bank is invalid: {error}") from None

    async def replace_results(self, step_id: uuid.UUID, rows: Sequence[ProbeResultRow]) -> None:
        async with self.session_factory() as session:
            await session.execute(delete(ProbeResultRow).where(ProbeResultRow.step_id == step_id))
            session.add_all(rows)
            await session.commit()
