import uuid

from tessa_api.schemas.enums import SyntheticFamily
from tessa_api.services.synthetic_scenarios import SyntheticScenarioRequest

EXPLORATION_KEY_PREFIX = "explore"
VERIFICATION_KEY_PREFIX = "verify"
EXPLORATION_TITLE = "Exploration as {role}"
START_PAGE_STEP = {
    "adapter": "browser",
    "label": "Open the application",
    "action": "goto",
    "url": "/",
}


def exploration_scenario_key(role: str) -> str:
    return f"{EXPLORATION_KEY_PREFIX}-{role}"


def verification_scenario_key(candidate_id: uuid.UUID) -> str:
    return f"{VERIFICATION_KEY_PREFIX}-{candidate_id}"


def exploration_scenario_request(
    run_id: uuid.UUID, role: str, interface_id: str
) -> SyntheticScenarioRequest:
    return SyntheticScenarioRequest(
        run_id=run_id,
        family=SyntheticFamily.exploration,
        key=exploration_scenario_key(role),
        title=EXPLORATION_TITLE.format(role=role),
        role=role,
        interface_id=interface_id,
        attempts=1,
        document={"steps": [dict(START_PAGE_STEP)]},
    )


def verification_scenario_request(
    run_id: uuid.UUID, candidate_id: uuid.UUID, role: str, interface_id: str, attempts: int
) -> SyntheticScenarioRequest:
    return SyntheticScenarioRequest(
        run_id=run_id,
        family=SyntheticFamily.exploration,
        key=verification_scenario_key(candidate_id),
        title=f"Replay of exploration candidate {str(candidate_id)[:8]} as {role}",
        role=role,
        interface_id=interface_id,
        attempts=attempts,
        document={"steps": [dict(START_PAGE_STEP)]},
    )
