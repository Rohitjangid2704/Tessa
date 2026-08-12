from tessa_api.schemas.common import RunCounters


def empty_counters() -> RunCounters:
    return RunCounters(
        scenarios_total=0,
        scenarios_done=0,
        pass_=0,
        fail=0,
        flaky=0,
        uncertain=0,
        skipped=0,
        steps_recorded=0,
    )
