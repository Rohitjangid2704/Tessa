import logging
import uuid

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import ModelCallRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.enums import ModelCallStatus
from tessa_api.schemas.model_calls import ModelCallRecord, ModelCallReservation
from tessa_api.schemas.temporal import (
    RECORD_MODEL_CALL_ACTIVITY,
    RecordModelCallInput,
    RecordModelCallResult,
)
from tessa_api.services.budget import (
    BudgetBlockedError,
    UnknownRunError,
    charge_run,
    ensure_affordable,
    to_money,
)
from tessa_worker.activities.model_call_contracts import ModelCallRecorder
from tessa_worker.grading.errors import GradingErrorType, permanent_error
from tessa_worker.metrics import WORKER_METRICS, WorkerMetrics

logger = logging.getLogger("tessa_worker.model_call")

MODEL_CALL_NAMESPACE = uuid.UUID("0c6f3b0e-5a52-4f2e-9d41-7b8e2c1a6f35")
UNKNOWN_MODEL = "unknown"


def deterministic_call_id(*parts: object) -> uuid.UUID:
    return uuid.uuid5(MODEL_CALL_NAMESPACE, ":".join(str(part) for part in parts))


def blocked_record(reservation: ModelCallReservation) -> ModelCallRecord:
    return ModelCallRecord(
        id=new_id(),
        run_id=reservation.run_id,
        step_id=reservation.step_id,
        role=reservation.role,
        activity=reservation.activity,
        model=reservation.model or UNKNOWN_MODEL,
        effort=reservation.effort,
        input_tokens=0,
        output_tokens=0,
        cost_usd=0.0,
        latency_ms=0,
        status=ModelCallStatus.budget_blocked,
    )


def budget_exceeded_error(
    error: BudgetBlockedError, reservation: ModelCallReservation
) -> ApplicationError:
    return permanent_error(
        GradingErrorType.budget_exceeded,
        f"run {error.run_id} has {error.remaining_usd} USD left, the {reservation.role.value} "
        f"call may cost {error.requested_usd} USD",
    )


async def insert_model_call(session: AsyncSession, call: ModelCallRecord) -> bool:
    statement = (
        insert(ModelCallRow)
        .values(
            id=call.id,
            run_id=call.run_id,
            step_id=call.step_id,
            role=call.role,
            activity=call.activity,
            model=call.model,
            effort=call.effort,
            input_tokens=call.input_tokens,
            output_tokens=call.output_tokens,
            cost_usd=to_money(call.cost_usd),
            latency_ms=call.latency_ms,
            status=call.status,
        )
        .on_conflict_do_nothing(index_elements=[ModelCallRow.id])
        .returning(ModelCallRow.id)
    )
    return (await session.execute(statement)).scalar_one_or_none() is not None


class DatabaseModelCallRecorder:
    def __init__(
        self, session_factory: SessionFactory, metrics: WorkerMetrics = WORKER_METRICS
    ) -> None:
        self.session_factory = session_factory
        self.metrics = metrics

    async def reserve(self, reservation: ModelCallReservation) -> None:
        if reservation.run_id is None:
            return
        try:
            async with self.session_factory() as session:
                await ensure_affordable(session, reservation.run_id, reservation.max_usd)
        except UnknownRunError as error:
            raise permanent_error(GradingErrorType.run_not_found, str(error)) from None
        except BudgetBlockedError as error:
            await self.record(blocked_record(reservation))
            raise budget_exceeded_error(error, reservation) from None

    async def record(self, call: ModelCallRecord) -> None:
        async with self.session_factory() as session:
            inserted = await insert_model_call(session, call)
            if inserted and call.run_id is not None and call.cost_usd > 0:
                await charge_run(session, call.run_id, to_money(call.cost_usd))
            await session.commit()
        if inserted:
            self.metrics.count_model_call(call.role, call.status, call.cost_usd)
            logger.info(
                "model_call_recorded",
                extra={
                    "model_call_id": str(call.id),
                    "role": call.role.value,
                    "model_call_activity": call.activity,
                    "model": call.model,
                    "status": call.status.value,
                    "cost_usd": call.cost_usd,
                    "latency_ms": call.latency_ms,
                },
            )


class ModelCallActivities:
    def __init__(self, recorder: ModelCallRecorder) -> None:
        self.recorder = recorder

    @activity.defn(name=RECORD_MODEL_CALL_ACTIVITY)
    async def record_model_call(self, request: RecordModelCallInput) -> RecordModelCallResult:
        await self.recorder.record(request)
        return RecordModelCallResult(id=request.id)
