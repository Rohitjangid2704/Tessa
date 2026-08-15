import re
from abc import ABC, abstractmethod
from collections.abc import Sequence

from tessa_api.schemas.enums import (
    BuiltInInvariantId,
    InvariantCheck,
    InvariantPack,
    SkipReason,
)
from tessa_api.schemas.steps import HttpStepResponse
from tessa_api.services.invariants.params import (
    FORBIDDEN_DENIAL_STATUSES,
    UNAUTHENTICATED_DENIAL_STATUSES,
    denied_statuses,
)
from tessa_worker.invariants.base import EvaluatorBase
from tessa_worker.invariants.contracts import (
    InvariantContext,
    InvariantOutcome,
    InvariantStep,
    ProbeRunner,
)
from tessa_worker.invariants.steps import headline, response_status

SUCCESS_FROM = 200
SUCCESS_BELOW = 300
REDIRECT_FROM = 300
REDIRECT_BELOW = 400
SERVER_ERROR_FROM = 500
LOGIN_LOCATION = re.compile(r"login|log-in|signin|sign-in|auth|sso", re.IGNORECASE)
LOCATION_HEADER = "location"


def redirects_to_login(step: InvariantStep, status: int) -> bool:
    response = step.response
    if not REDIRECT_FROM <= status < REDIRECT_BELOW or not isinstance(response, HttpStepResponse):
        return False
    location = next(
        (value for name, value in response.headers.items() if name.casefold() == LOCATION_HEADER),
        "",
    )
    return LOGIN_LOCATION.search(location) is not None


class BoundaryEvaluator(EvaluatorBase, ABC):
    default_denials: frozenset[int]

    @abstractmethod
    def served_message(
        self, context: InvariantContext, step: InvariantStep, status: int
    ) -> str: ...

    @abstractmethod
    def denied_message(self, context: InvariantContext, count: int) -> str: ...

    async def evaluate(
        self, context: InvariantContext, probes: ProbeRunner
    ) -> Sequence[InvariantOutcome]:
        if not context.steps:
            return [self.skipped(SkipReason.precondition_failed, "the scenario recorded no step")]
        denials = denied_statuses(context.params, self.default_denials)
        problems: list[InvariantOutcome] = []
        denied = 0
        for step in context.steps:
            status = response_status(step)
            if status is None:
                problems.append(self.unanswered(step))
            elif status in denials or redirects_to_login(step, status):
                denied += 1
            elif SUCCESS_FROM <= status < SUCCESS_BELOW:
                problems.append(
                    self.failed(self.served_message(context, step, status), step_id=step.step_id)
                )
            else:
                problems.append(self.undecided(step, status))
        if problems:
            return problems
        return [self.passed(self.denied_message(context, denied))]

    def unanswered(self, step: InvariantStep) -> InvariantOutcome:
        return self.uncertain(
            f"{headline(step)} got no response, so the boundary was not exercised",
            step_id=step.step_id,
        )

    def undecided(self, step: InvariantStep, status: int) -> InvariantOutcome:
        reason = (
            "a server error" if status >= SERVER_ERROR_FROM else "neither a success nor a denial"
        )
        return self.uncertain(
            f"{headline(step)} answered with status {status}, {reason}",
            step_id=step.step_id,
        )


class AuthBoundariesEvaluator(BoundaryEvaluator):
    invariant_id = BuiltInInvariantId.auth_boundaries.value
    pack = InvariantPack.generic
    check = InvariantCheck.code
    default_denials = UNAUTHENTICATED_DENIAL_STATUSES

    def served_message(self, context: InvariantContext, step: InvariantStep, status: int) -> str:
        return f"{headline(step)} was served to a caller without credentials (status {status})"

    def denied_message(self, context: InvariantContext, count: int) -> str:
        return f"every request without credentials was denied ({count} checked)"


class RoleMonotonicityEvaluator(BoundaryEvaluator):
    invariant_id = BuiltInInvariantId.role_monotonicity.value
    pack = InvariantPack.generic
    check = InvariantCheck.code
    default_denials = FORBIDDEN_DENIAL_STATUSES

    def served_message(self, context: InvariantContext, step: InvariantStep, status: int) -> str:
        return (
            f"{headline(step)} is reserved for a higher role and was served to role "
            f"{context.role} (status {status})"
        )

    def denied_message(self, context: InvariantContext, count: int) -> str:
        return (
            f"every endpoint reserved for higher roles was denied to role {context.role} "
            f"({count} checked)"
        )


class TenantIsolationEvaluator(BoundaryEvaluator):
    invariant_id = BuiltInInvariantId.tenant_isolation.value
    pack = InvariantPack.generic
    check = InvariantCheck.code
    default_denials = FORBIDDEN_DENIAL_STATUSES

    def served_message(self, context: InvariantContext, step: InvariantStep, status: int) -> str:
        return (
            f"{headline(step)} returned data of another tenant to role {context.role} "
            f"(status {status})"
        )

    def denied_message(self, context: InvariantContext, count: int) -> str:
        return (
            f"every request for another tenant's data was denied to role {context.role} "
            f"({count} checked)"
        )
