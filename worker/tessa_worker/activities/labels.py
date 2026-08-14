from pydantic import ValidationError
from temporalio import activity

from tessa_api.db.models import JudgeResultRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import LabelValue
from tessa_api.schemas.temporal import (
    STORE_WEAK_LABEL_ACTIVITY,
    StoreWeakLabelInput,
    StoreWeakLabelResult,
)
from tessa_api.services.grading_rules import label_value_of
from tessa_api.services.labels import store_weak_label
from tessa_worker.activities.tier0 import permanent


def weak_label_value(row: JudgeResultRow) -> LabelValue:
    try:
        status = Verdict.model_validate(row.verdict).status
    except ValidationError:
        return LabelValue.uncertain
    return label_value_of(status) or LabelValue.uncertain


class LabelActivities:
    def __init__(self, session_factory: SessionFactory) -> None:
        self.session_factory = session_factory

    @activity.defn(name=STORE_WEAK_LABEL_ACTIVITY)
    async def store_weak_label(self, request: StoreWeakLabelInput) -> StoreWeakLabelResult:
        async with self.session_factory() as session:
            row = await session.get(JudgeResultRow, request.judge_result_id)
            if row is None:
                raise permanent(f"judge result {request.judge_result_id} does not exist")
            label_id = await store_weak_label(session, row.id, weak_label_value(row))
            await session.commit()
        return StoreWeakLabelResult(label_id=label_id)
