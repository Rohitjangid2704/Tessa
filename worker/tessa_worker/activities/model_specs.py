from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import ModelRole
from tessa_api.schemas.model_calls import EMBED_MAX_USD_PER_CALL, EmbedCallSpec
from tessa_api.schemas.temporal import (
    EMBED_MAX_ATTEMPTS,
    EMBED_START_TO_CLOSE,
    RESOLVE_MODEL_SPECS_ACTIVITY,
    ResolveModelSpecsResult,
)
from tessa_api.services.settings_service import effective_settings, model_call_spec
from tessa_api.settings import StrictSettings
from tessa_worker.grading.stub_markers import STUB_MODEL_ID
from tessa_worker.settings import WorkerSettings


def embed_call_spec(effective: StrictSettings) -> EmbedCallSpec:
    return EmbedCallSpec(
        model=STUB_MODEL_ID if effective.stub_models else effective.embedding_model,
        dimensions=effective.embedding_dimensions,
        max_usd=EMBED_MAX_USD_PER_CALL,
        start_to_close_timeout_seconds=int(EMBED_START_TO_CLOSE.total_seconds()),
        max_attempts=EMBED_MAX_ATTEMPTS,
    )


class ModelSpecActivities:
    def __init__(self, settings: WorkerSettings, session_factory: SessionFactory) -> None:
        self.settings = settings
        self.session_factory = session_factory

    @activity.defn(name=RESOLVE_MODEL_SPECS_ACTIVITY)
    async def resolve_model_specs(self) -> ResolveModelSpecsResult:
        async with self.session_factory() as session:
            effective = await effective_settings(session, self.settings)
        return ResolveModelSpecsResult(
            judge=model_call_spec(ModelRole.judge, effective),
            judge_tiebreak=model_call_spec(ModelRole.judge_tiebreak, effective),
            embed=embed_call_spec(effective),
        )
