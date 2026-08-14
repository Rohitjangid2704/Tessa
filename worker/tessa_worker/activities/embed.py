import asyncio
import hashlib
import logging
import time
import uuid

from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.schemas.enums import ModelCallRole, ModelCallStatus
from tessa_api.schemas.model_calls import (
    EMBED_MAX_TEXT_CHARS,
    ModelCallRecord,
    ModelCallReservation,
)
from tessa_api.schemas.temporal import EMBED_TEXTS_ACTIVITY, EmbedTextsInput, EmbedTextsOutput
from tessa_worker.activities.model_call import deterministic_call_id
from tessa_worker.activities.model_call_contracts import ModelCallRecorder
from tessa_worker.findings.embedding_client import EmbeddingProviders, EmbeddingReply
from tessa_worker.findings.errors import FindingsErrorType, permanent_findings_error
from tessa_worker.findings.stub_vectors import stub_vectors
from tessa_worker.grading.errors import GradingErrorType, permanent_error, retryable_error
from tessa_worker.grading.judge_models import ProviderCallError
from tessa_worker.grading.judge_runner import application_error_of
from tessa_worker.grading.pricing import (
    Charge,
    PriceTable,
    TokenUsage,
    charge_for,
    stub_charge,
)
from tessa_worker.grading.stub_markers import STUB_MODEL_ID
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.embed")

VECTOR_DIGITS = 6
CALL_TIMEOUT_MARGIN_SECONDS = 5
MIN_CALL_TIMEOUT_SECONDS = 1


def call_timeout_seconds(request: EmbedTextsInput) -> float:
    available = request.spec.start_to_close_timeout_seconds - CALL_TIMEOUT_MARGIN_SECONDS
    return float(max(MIN_CALL_TIMEOUT_SECONDS, available))


def record_id_of(request: EmbedTextsInput, attempt: int) -> uuid.UUID:
    digest = hashlib.sha256("\n".join(request.texts).encode("utf-8")).hexdigest()
    return deterministic_call_id(EMBED_TEXTS_ACTIVITY, request.run_id, digest, attempt)


def vectors_valid(reply: EmbeddingReply, request: EmbedTextsInput) -> bool:
    return len(reply.vectors) == len(request.texts) and all(
        len(vector) == request.spec.dimensions for vector in reply.vectors
    )


class EmbedActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        recorder: ModelCallRecorder,
        providers: EmbeddingProviders,
        price_table: PriceTable | None = None,
    ) -> None:
        self.settings = settings
        self.recorder = recorder
        self.providers = providers
        self.price_table = price_table

    @property
    def stub_mode(self) -> bool:
        return self.settings.stub_models

    @activity.defn(name=EMBED_TEXTS_ACTIVITY)
    async def embed_texts(self, request: EmbedTextsInput) -> EmbedTextsOutput:
        return await self.embed(request, activity.info().attempt)

    async def embed(self, request: EmbedTextsInput, attempt: int) -> EmbedTextsOutput:
        self.check_request(request)
        await self.recorder.reserve(
            ModelCallReservation(
                run_id=request.run_id,
                role=ModelCallRole.embed,
                activity=EMBED_TEXTS_ACTIVITY,
                max_usd=request.spec.max_usd,
                model=self.model_name(request),
            )
        )
        started = time.perf_counter()
        try:
            reply = await self.obtain_reply(request)
        except ApplicationError:
            await self.record(request, attempt, started, ModelCallStatus.error, None)
            raise
        charge = self.charge(request, reply)
        valid = vectors_valid(reply, request)
        status = ModelCallStatus.ok if valid else ModelCallStatus.invalid_output
        await self.record(request, attempt, started, status, (charge, reply.usage))
        if not valid:
            raise permanent_findings_error(
                FindingsErrorType.embedding_reply_invalid,
                f"the embedding reply holds {len(reply.vectors)} vectors for "
                f"{len(request.texts)} texts or a vector is not {request.spec.dimensions} wide",
            )
        return EmbedTextsOutput(
            cost_usd=charge.cost_usd,
            input_tokens=0 if reply.usage is None else reply.usage.input_tokens,
            output_tokens=0,
            vectors=[[round(value, VECTOR_DIGITS) for value in vector] for vector in reply.vectors],
        )

    def model_name(self, request: EmbedTextsInput) -> str:
        return STUB_MODEL_ID if self.stub_mode else request.spec.model

    def check_request(self, request: EmbedTextsInput) -> None:
        if any(not text.strip() or len(text) > EMBED_MAX_TEXT_CHARS for text in request.texts):
            raise permanent_findings_error(
                FindingsErrorType.embedding_input_invalid,
                f"every text needs 1 to {EMBED_MAX_TEXT_CHARS} characters",
            )
        if request.spec.dimensions != self.settings.embedding_dimensions:
            raise permanent_findings_error(
                FindingsErrorType.embedding_dimension_mismatch,
                f"the spec asks for {request.spec.dimensions} dimensions, "
                f"TESSA_EMBEDDING_DIMENSIONS is {self.settings.embedding_dimensions}",
            )
        if not self.stub_mode and request.spec.model == STUB_MODEL_ID:
            raise permanent_error(
                GradingErrorType.stub_model_mismatch,
                "the run was planned with stub models but TESSA_STUB_MODELS is off here",
            )

    async def obtain_reply(self, request: EmbedTextsInput) -> EmbeddingReply:
        spec = request.spec
        if self.stub_mode:
            return EmbeddingReply(
                vectors=stub_vectors(request.texts, spec.dimensions), usage=TokenUsage(0, 0)
            )
        timeout = call_timeout_seconds(request)
        async with self.providers.open(timeout) as provider:
            if provider is None:
                raise permanent_error(
                    GradingErrorType.provider_key_missing, "no OpenAI API key is configured"
                )
            try:
                async with asyncio.timeout(timeout):
                    return await provider.embed(spec.model, request.texts, spec.dimensions, timeout)
            except ProviderCallError as error:
                raise application_error_of(error) from None
            except TimeoutError:
                raise retryable_error(
                    GradingErrorType.provider_unavailable, "the embedding call timed out"
                ) from None

    def charge(self, request: EmbedTextsInput, reply: EmbeddingReply) -> Charge:
        if self.stub_mode:
            return stub_charge(self.price_table)
        return charge_for(request.spec.model, reply.usage, request.spec.max_usd, self.price_table)

    async def record(
        self,
        request: EmbedTextsInput,
        attempt: int,
        started: float,
        status: ModelCallStatus,
        billed: tuple[Charge, TokenUsage | None] | None,
    ) -> None:
        charge, usage = billed if billed is not None else (None, None)
        await self.recorder.record(
            ModelCallRecord(
                id=record_id_of(request, attempt),
                run_id=request.run_id,
                step_id=None,
                role=ModelCallRole.embed,
                activity=EMBED_TEXTS_ACTIVITY,
                model=self.model_name(request),
                effort=None,
                latency_ms=round((time.perf_counter() - started) * 1000),
                status=status,
                cost_usd=0.0 if charge is None else charge.cost_usd,
                input_tokens=0 if usage is None else usage.input_tokens,
                output_tokens=0,
            )
        )
        logger.info(
            "embed_call",
            extra={
                "run_id": str(request.run_id),
                "status": status.value,
                "texts": len(request.texts),
                "cost_usd": 0.0 if charge is None else charge.cost_usd,
            },
        )
