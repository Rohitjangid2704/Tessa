from collections.abc import Iterable

from tessa_api.schemas.enums import VerdictStatus

STATUS_PRECEDENCE: tuple[VerdictStatus, ...] = (
    VerdictStatus.fail,
    VerdictStatus.uncertain,
    VerdictStatus.skipped,
    VerdictStatus.pass_,
)
RANK = {status: position for position, status in enumerate(STATUS_PRECEDENCE)}


def worst_status(statuses: Iterable[VerdictStatus]) -> VerdictStatus | None:
    ranked = [status for status in statuses if status in RANK]
    return min(ranked, key=RANK.__getitem__) if ranked else None


def severity_rank(status: VerdictStatus) -> int:
    return RANK.get(status, len(STATUS_PRECEDENCE))
