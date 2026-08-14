from typing import Protocol

from tessa_api.schemas.model_calls import ModelCallRecord, ModelCallReservation


class ModelCallRecorder(Protocol):
    async def reserve(self, reservation: ModelCallReservation) -> None: ...

    async def record(self, call: ModelCallRecord) -> None: ...
