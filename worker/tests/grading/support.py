import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import select, update

from tessa_api.db.models import BundleRow, JudgeResultRow, RunRow, ScenarioRow, StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import AdapterKind, Effort, JudgeFamily, JudgeOrder, ModelRole
from tessa_api.schemas.grading import EvidenceBlock, JudgeStepInput, ModelCallSpec
from tessa_api.schemas.oracles import GoldPoint
from tessa_worker.grading.evidence import EvidenceSource, build_evidence
from tessa_worker.grading.judge_anthropic import AnthropicJudge
from tessa_worker.grading.judge_models import JudgeProvider
from tessa_worker.grading.judge_openai import OpenAIJudge
from tests.fakes.openai import FakeProvider
from tests.runs.support import seed_run

FAKE_MANIFEST = (
    Path(__file__).resolve().parent.parent / "fake_target" / "tessa" / "manifest.yaml"
)
FEATURE_ID = "maintenance.read.open_issues"
PROBE_INVARIANT_ID = "no_claim_before_confirmation"
CODE_INVARIANT_ID = "no_internal_ids"

ASK = "Which maintenance issues are still open?"
ANSWER = "3 maintenance issues are open across 2 rooms, most of them in room 20003."
GOLD_KEY = "open_count"
GOLD_RENDERED = "3 maintenance issues are open"
SECRET_VALUE = "sk-Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A"
SECRET_ASSIGNMENT = "api_key = Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A"

JUDGE_MODEL = "gpt-6.1-sol"
TIEBREAK_MODEL = "claude-sonnet-5-5"


def model_spec(
    role: ModelRole = ModelRole.judge,
    model: str = JUDGE_MODEL,
    effort: Effort = Effort.low,
    max_usd: float = 0.05,
    max_input_tokens: int = 6000,
    max_output_tokens: int = 800,
    timeout_seconds: int = 60,
    max_attempts: int = 2,
) -> ModelCallSpec:
    return ModelCallSpec(
        role=role,
        model=model,
        effort=effort,
        max_usd=max_usd,
        max_input_tokens=max_input_tokens,
        max_output_tokens=max_output_tokens,
        start_to_close_timeout_seconds=timeout_seconds,
        max_attempts=max_attempts,
    )


def tiebreak_spec(**changes: Any) -> ModelCallSpec:
    options: dict[str, Any] = {"role": ModelRole.judge_tiebreak, "model": TIEBREAK_MODEL}
    options.update(changes)
    return model_spec(**options)


def gold_point(key: str = GOLD_KEY, rendered: str = GOLD_RENDERED, value: Any = 3) -> GoldPoint:
    return GoldPoint(key=key, value=value, oracle_result_id=uuid.uuid4(), rendered=rendered)


def evidence_block(
    answer: str | None = ANSWER,
    ask: str | None = ASK,
    gold_points: Sequence[GoldPoint] | None = None,
    must_not_claim: Sequence[str] = (),
) -> EvidenceBlock:
    gold = [gold_point()] if gold_points is None else gold_points
    return build_evidence(
        EvidenceSource(ask=ask, answer=answer, gold_points=gold, must_not_claim=must_not_claim)
    )


def judge_input(
    step_id: uuid.UUID,
    evidence: EvidenceBlock | None = None,
    spec: ModelCallSpec | None = None,
    order: JudgeOrder = JudgeOrder.a_b,
    paired_with: uuid.UUID | None = None,
) -> JudgeStepInput:
    return JudgeStepInput(
        step_id=step_id,
        evidence=evidence or evidence_block(),
        order=order,
        spec=spec or model_spec(),
        paired_with=paired_with,
    )


class FakeProviders:
    def __init__(
        self, provider: FakeProvider, openai_key: bool = True, anthropic_key: bool = True
    ) -> None:
        self.provider = provider
        self.openai_key = openai_key
        self.anthropic_key = anthropic_key

    @asynccontextmanager
    async def open(
        self, family: JudgeFamily, timeout_seconds: float
    ) -> AsyncIterator[JudgeProvider | None]:
        if family is JudgeFamily.openai and self.openai_key:
            yield OpenAIJudge(self.provider.openai_client(timeout_seconds))
        elif family is JudgeFamily.anthropic and self.anthropic_key:
            yield AnthropicJudge(self.provider.anthropic_client(timeout_seconds))
        else:
            yield None


@dataclass(frozen=True)
class SeededStep:
    run_id: uuid.UUID
    step_id: uuid.UUID
    run_scenario_id: uuid.UUID
    scenario_id: uuid.UUID
    bundle_id: uuid.UUID


def manifest_with_feature_invariants(*invariant_ids: str) -> dict[str, Any]:
    manifest: dict[str, Any] = yaml.safe_load(FAKE_MANIFEST.read_text(encoding="utf-8"))
    for feature in manifest["features"]:
        if feature["id"] == FEATURE_ID:
            feature["invariants"] = list(invariant_ids)
    return manifest


async def seed_step(
    session_factory: SessionFactory,
    answer: str | None = ANSWER,
    ask: str | None = ASK,
    gold_points: Sequence[GoldPoint] = (),
    budget_max_usd: float = 5.0,
    spent_usd: float = 0.0,
    manifest: dict[str, Any] | None = None,
) -> SeededStep:
    seeded = await seed_run(session_factory, scenario_count=1)
    now = datetime.now(UTC).replace(tzinfo=None)
    step = StepRow(
        run_scenario_id=seeded.run_scenario_ids[0],
        run_id=seeded.run_id,
        attempt=0,
        index=0,
        adapter=AdapterKind.sse,
        label="ask",
        request={"kind": "sse", "method": "POST", "url": "/message", "headers": {}, "body": None},
        ask=ask,
        answer=answer,
        tier0={"passed": True, "failures": []},
        latency_ms=10,
        gold_points=[gold.model_dump(mode="json") for gold in gold_points],
        started_at=now,
        finished_at=now,
    )
    async with session_factory() as session:
        session.add(step)
        await session.execute(
            update(RunRow)
            .where(RunRow.id == seeded.run_id)
            .values(
                budget={"max_usd": budget_max_usd, "max_minutes": 30},
                spent_usd=Decimal(str(spent_usd)),
            )
        )
        await session.execute(
            update(ScenarioRow)
            .where(ScenarioRow.id == seeded.scenario_ids[0])
            .values(feature_id=FEATURE_ID)
        )
        if manifest is not None:
            await session.execute(
                update(BundleRow).where(BundleRow.id == seeded.bundle_id).values(manifest=manifest)
            )
        await session.commit()
        step_id = step.id
    return SeededStep(
        run_id=seeded.run_id,
        step_id=step_id,
        run_scenario_id=seeded.run_scenario_ids[0],
        scenario_id=seeded.scenario_ids[0],
        bundle_id=seeded.bundle_id,
    )


async def judge_rows(session_factory: SessionFactory, step_id: uuid.UUID) -> list[JudgeResultRow]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(JudgeResultRow)
            .where(JudgeResultRow.step_id == step_id)
            .order_by(JudgeResultRow.created_at, JudgeResultRow.id)
        )
        return list(rows)


async def stored_evidence_of(session_factory: SessionFactory, step_id: uuid.UUID) -> Any:
    async with session_factory() as session:
        return await session.scalar(select(StepRow.evidence).where(StepRow.id == step_id))
