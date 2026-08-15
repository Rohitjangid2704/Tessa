import uuid

from tessa_api.schemas.enums import ModelCallRole
from tessa_api.schemas.grading import ModelCallSpec
from tessa_api.schemas.model_calls import ModelCallReservation
from tessa_worker.activities.model_call_contracts import ModelCallRecorder


async def reserve_budget(
    recorder: ModelCallRecorder,
    run_id: uuid.UUID,
    step_id: uuid.UUID,
    activity_name: str,
    spec: ModelCallSpec,
    model: str,
) -> None:
    await recorder.reserve(
        ModelCallReservation(
            run_id=run_id,
            role=ModelCallRole(spec.role.value),
            activity=activity_name,
            max_usd=spec.max_usd,
            model=model,
            step_id=step_id,
            effort=spec.effort,
        )
    )
