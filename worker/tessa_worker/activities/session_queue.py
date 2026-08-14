import uuid
from dataclasses import dataclass

from temporalio import activity

from tessa_api.schemas.temporal import (
    GET_WORKER_TASK_QUEUE_ACTIVITY,
    GetWorkerTaskQueueResult,
    session_task_queue,
)
from tessa_worker.settings import WorkerSettings

WORKER_ID_CHARS = 16
PROCESS_WORKER_ID = uuid.uuid4().hex[:WORKER_ID_CHARS]


@dataclass(frozen=True, slots=True)
class SessionQueue:
    name: str

    @classmethod
    def for_process(cls, settings: WorkerSettings) -> "SessionQueue":
        return cls(session_task_queue(settings.temporal_task_queue, PROCESS_WORKER_ID))


class SessionQueueActivities:
    def __init__(self, queue: SessionQueue) -> None:
        self.queue = queue

    @activity.defn(name=GET_WORKER_TASK_QUEUE_ACTIVITY)
    async def get_worker_task_queue(self) -> GetWorkerTaskQueueResult:
        return GetWorkerTaskQueueResult(task_queue=self.queue.name)
