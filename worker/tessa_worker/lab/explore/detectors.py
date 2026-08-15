from collections.abc import Sequence

from tessa_api.schemas.enums import CandidateSource, GoalKind
from tessa_api.schemas.explore_actions import ClickAction, NavigateAction
from tessa_api.services.findings.fingerprint import path_template
from tessa_worker.lab.contracts import (
    CandidateDraft,
    DetectionContext,
    Detector,
)
from tessa_worker.lab.explore.assertions import (
    console_assertion,
    failed_request_target,
    is_login_address,
    normalised,
    reached_assertion,
    request_failed_assertion,
    shows_denial,
)

SERVER_ERROR_FLOOR = 500
MIN_REACHED_TEXT_CHARS = 40
CONSOLE_EXCERPT_CHARS = 160


class ConsoleErrorDetector:
    name = "console_error"

    def __init__(self) -> None:
        self.reported: set[str] = set()

    def detect(self, context: DetectionContext) -> Sequence[CandidateDraft]:
        drafts: list[CandidateDraft] = []
        for error in context.after.new_console_errors:
            fragment = console_assertion(error).value
            if fragment in self.reported:
                continue
            self.reported.add(fragment)
            drafts.append(
                CandidateDraft(
                    source=CandidateSource.detector,
                    detector=self.name,
                    description=f"console error after the action: {error[:CONSOLE_EXCERPT_CHARS]}",
                    from_index=context.index,
                    to_index=context.index,
                    assertion=console_assertion(error),
                )
            )
        return drafts


class ServerErrorDetector:
    name = "server_error"

    def __init__(self) -> None:
        self.reported: set[str] = set()

    def detect(self, context: DetectionContext) -> Sequence[CandidateDraft]:
        drafts: list[CandidateDraft] = []
        for request in context.after.failed_requests:
            if request.status < SERVER_ERROR_FLOOR:
                continue
            identity = f"{request.status} {failed_request_target(request)}"
            if identity in self.reported:
                continue
            self.reported.add(identity)
            drafts.append(
                CandidateDraft(
                    source=CandidateSource.detector,
                    detector=self.name,
                    description=f"the target answered {identity}",
                    from_index=context.index,
                    to_index=context.index,
                    assertion=request_failed_assertion(request),
                )
            )
        return drafts


class BoundaryReachDetector:
    name = "boundary_reach"

    def __init__(self, baseline_url: str | None) -> None:
        self.known_paths: set[str] = set()
        if baseline_url is not None:
            self.known_paths.add(path_template(baseline_url))

    def detect(self, context: DetectionContext) -> Sequence[CandidateDraft]:
        if context.goal.kind is not GoalKind.attempt_forbidden:
            return []
        if not isinstance(context.action, NavigateAction | ClickAction):
            return []
        after = context.after
        reached = path_template(after.url)
        if reached == path_template(context.before.url) or reached in self.known_paths:
            return []
        self.known_paths.add(reached)
        if is_login_address(after.url) or shows_denial(after):
            return []
        if len(normalised(after.text)) < MIN_REACHED_TEXT_CHARS:
            return []
        return [
            CandidateDraft(
                source=CandidateSource.detector,
                detector=self.name,
                description=(
                    f"the page {reached} opened without any access denied message while the "
                    "goal was to attempt something forbidden"
                ),
                from_index=context.index,
                to_index=context.index,
                assertion=reached_assertion(after.url),
            )
        ]


def build_detectors(goal_kind: GoalKind | None, baseline_url: str | None) -> list[Detector]:
    detectors: list[Detector] = [ConsoleErrorDetector(), ServerErrorDetector()]
    if goal_kind is GoalKind.attempt_forbidden:
        detectors.append(BoundaryReachDetector(baseline_url))
    return detectors
