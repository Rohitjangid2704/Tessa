from collections.abc import Sequence

from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import AttackOutcome, VerdictStatus
from tessa_worker.verdicts import fail_verdict, pass_verdict, uncertain_verdict

CONFIRM_REPLAYS = 3
CONFIRM_REPRODUCTIONS = 2

NOT_REPRODUCED = "redteam_not_reproduced"
BREACH_CONFIRMED = "redteam_breach_confirmed"
BREACH_UNCONFIRMED = "redteam_breach_unconfirmed"
ATTACK_INCONCLUSIVE = "redteam_inconclusive"
REPLAYS_REPRODUCED = "redteam_replays_reproduced"
REPLAYS_MIXED = "redteam_replays_mixed"
SKEPTIC_UNAVAILABLE = "redteam_skeptic_unavailable"


def reproduced_count(outcomes: Sequence[AttackOutcome]) -> int:
    return sum(1 for outcome in outcomes if outcome is AttackOutcome.breached)


def reproduction_is_enough(reproduced: int) -> bool:
    return reproduced >= CONFIRM_REPRODUCTIONS


def is_confirmed(skeptic: Verdict, reproduced: int) -> bool:
    return skeptic.status is VerdictStatus.fail and reproduction_is_enough(reproduced)


def not_reproduced_verdict(reproduced: int, replays: int) -> Verdict:
    return uncertain_verdict(
        NOT_REPRODUCED,
        f"the attack reproduced in {reproduced} of {replays} replays, "
        f"{CONFIRM_REPRODUCTIONS} are needed; the skeptic was not asked",
    )


def skeptic_unavailable_verdict(reason: str) -> Verdict:
    return uncertain_verdict(SKEPTIC_UNAVAILABLE, reason)


def attack_scenario_verdict(outcome: AttackOutcome, confirmed: bool, signal: str) -> Verdict:
    if outcome is AttackOutcome.blocked:
        return pass_verdict()
    if outcome is AttackOutcome.breached and confirmed:
        return fail_verdict(f"confirmed breach: {signal}", BREACH_CONFIRMED)
    if outcome is AttackOutcome.breached:
        return uncertain_verdict(BREACH_UNCONFIRMED, f"breach not confirmed: {signal}")
    return uncertain_verdict(ATTACK_INCONCLUSIVE, signal)


def replay_scenario_verdict(outcomes: Sequence[AttackOutcome]) -> Verdict:
    reproduced = reproduced_count(outcomes)
    if reproduction_is_enough(reproduced):
        return fail_verdict(
            f"the attack reproduced in {reproduced} of {len(outcomes)} replays", REPLAYS_REPRODUCED
        )
    if outcomes and all(outcome is AttackOutcome.blocked for outcome in outcomes):
        return pass_verdict()
    return uncertain_verdict(
        REPLAYS_MIXED, f"the attack reproduced in {reproduced} of {len(outcomes)} replays"
    )
