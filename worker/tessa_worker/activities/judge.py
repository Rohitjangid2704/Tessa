from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeFamily
from tessa_api.schemas.grading import EvidenceBlock, JudgeStepInput, JudgeStepOutput
from tessa_api.schemas.temporal import JUDGE_STEP_ACTIVITY, JUDGE_TIEBREAK_ACTIVITY
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.judge_models import BuildStepEvidenceInput
from tessa_worker.activities.model_call import DatabaseModelCallRecorder
from tessa_worker.activities.model_call_contracts import ModelCallRecorder
from tessa_worker.activities.names import BUILD_STEP_EVIDENCE
from tessa_worker.grading.evidence_loader import build_and_store_evidence
from tessa_worker.grading.judge_providers import (
    JudgeProviders,
    KeyedJudgeProviders,
    ProviderKeys,
)
from tessa_worker.grading.judge_runner import JudgeDependencies, JudgeRunner
from tessa_worker.settings import WorkerSettings
from tessa_worker.testing.stub_models import (
    StubModelRegistry,
    default_stub_registry,
    ensure_stub_models_allowed,
)


class JudgeActivities:
    def __init__(self, dependencies: JudgeDependencies) -> None:
        self.dependencies = dependencies
        self.runner = JudgeRunner(dependencies)

    @activity.defn(name=BUILD_STEP_EVIDENCE)
    async def build_step_evidence(self, request: BuildStepEvidenceInput) -> EvidenceBlock:
        async with self.dependencies.session_factory() as session:
            return await build_and_store_evidence(session, request.step_id)

    @activity.defn(name=JUDGE_STEP_ACTIVITY)
    async def judge_step(self, request: JudgeStepInput) -> JudgeStepOutput:
        return await self.runner.run(request, JudgeFamily.openai)

    @activity.defn(name=JUDGE_TIEBREAK_ACTIVITY)
    async def judge_tiebreak(self, request: JudgeStepInput) -> JudgeStepOutput:
        return await self.runner.run(request, JudgeFamily.anthropic)


def default_judge_activities(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    providers: JudgeProviders | None = None,
    stubs: StubModelRegistry | None = None,
    recorder: ModelCallRecorder | None = None,
) -> JudgeActivities:
    ensure_stub_models_allowed(settings)
    keyed = KeyedJudgeProviders(
        ProviderKeys(session_factory, vault_from_settings(settings), settings)
    )
    return JudgeActivities(
        JudgeDependencies(
            settings=settings,
            session_factory=session_factory,
            providers=providers or keyed,
            stubs=stubs or default_stub_registry(),
            recorder=recorder or DatabaseModelCallRecorder(session_factory),
        )
    )
