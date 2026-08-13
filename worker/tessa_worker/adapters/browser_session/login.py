import re
from collections.abc import Sequence
from dataclasses import dataclass

from tessa_api.schemas.bundle_files import Flow, FlowStep
from tessa_api.schemas.scenario import ANONYMOUS_IDENTITY, BrowserStep
from tessa_api.services.smoke_generator import flow_step_document

CREDENTIAL_PLACEHOLDER = re.compile(r"^\$\{[A-Z][A-Z0-9_]*\}$")
LOGIN_SUBMIT_ACTIONS = frozenset({"click", "press"})


@dataclass(frozen=True, slots=True)
class LoginPlan:
    steps: tuple[BrowserStep, ...]
    bundle_describes_login: bool

    def missing_for(self, role: str) -> bool:
        return role != ANONYMOUS_IDENTITY and not self.steps and self.bundle_describes_login


def login_prefix(flow: Flow) -> list[FlowStep]:
    credentials_seen = False
    for position, step in enumerate(flow.steps):
        if (
            step.action == "fill"
            and step.value is not None
            and CREDENTIAL_PLACEHOLDER.match(step.value)
        ):
            credentials_seen = True
        elif credentials_seen and step.action in LOGIN_SUBMIT_ACTIONS:
            return list(flow.steps[: position + 1])
    return []


def to_browser_step(step: FlowStep) -> BrowserStep:
    return BrowserStep.model_validate(flow_step_document(step, False, None))


def plan_login(flows: Sequence[Flow], role: str) -> LoginPlan:
    describes_login = any(login_prefix(flow) for flow in flows)
    if role == ANONYMOUS_IDENTITY:
        return LoginPlan(steps=(), bundle_describes_login=describes_login)
    for flow in sorted((item for item in flows if item.role == role), key=lambda item: item.id):
        prefix = login_prefix(flow)
        if prefix:
            return LoginPlan(
                steps=tuple(to_browser_step(step) for step in prefix),
                bundle_describes_login=describes_login,
            )
    return LoginPlan(steps=(), bundle_describes_login=describes_login)
