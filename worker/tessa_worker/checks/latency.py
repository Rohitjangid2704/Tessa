from tessa_api.schemas.enums import Tier0Check
from tessa_api.schemas.scenario import HttpLatencyExpect, SseLatencyExpect
from tessa_api.schemas.steps import Tier0Failure
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.common import failure


def max_latency_failures(
    record: StepRecord, latency: HttpLatencyExpect | None, subject: str
) -> list[Tier0Failure]:
    if latency is None or record.latency_ms <= latency.max_ms:
        return []
    return [
        failure(
            Tier0Check.latency,
            f"{subject} took {record.latency_ms} ms",
            latency.max_ms,
            record.latency_ms,
        )
    ]


def stream_latency_failures(
    record: StepRecord,
    latency: SseLatencyExpect | None,
    first_ms: int | None,
    subject: str,
    item: str,
) -> list[Tier0Failure]:
    if latency is None:
        return []
    failures: list[Tier0Failure] = []
    if latency.max_ms is not None and record.latency_ms > latency.max_ms:
        failures.append(
            failure(
                Tier0Check.latency,
                f"{subject} took {record.latency_ms} ms in total",
                latency.max_ms,
                record.latency_ms,
            )
        )
    if latency.max_first_byte_ms is not None:
        if first_ms is None:
            failures.append(
                failure(
                    Tier0Check.latency,
                    f"no {item} arrived, so the time to the first {item} is unknown",
                    latency.max_first_byte_ms,
                )
            )
        elif first_ms > latency.max_first_byte_ms:
            failures.append(
                failure(
                    Tier0Check.latency,
                    f"the first {item} arrived after {first_ms} ms",
                    latency.max_first_byte_ms,
                    first_ms,
                )
            )
    return failures
