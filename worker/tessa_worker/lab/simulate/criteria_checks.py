import re
from collections.abc import Sequence

from tessa_api.schemas.enums import VerdictTier
from tessa_api.schemas.scenario import ToolMatch, ToolRef
from tessa_api.schemas.steps import StepTool
from tessa_api.services.goal_criteria import TextCriterion, ToolCriterion
from tessa_worker.checks.chat_checks import tool_matches
from tessa_worker.lab.simulate.outcomes import CheckOutcome, failed, passed

TEXT_HOLDS = "text_holds"
TEXT_MISSING = "text_missing"
TEXT_FORBIDDEN = "text_forbidden"
TOOL_HOLDS = "tool_holds"
TOOL_MISSING = "tool_missing"
TOOL_FORBIDDEN = "tool_forbidden"
SHOWN_CHARS = 80


def shown(value: str) -> str:
    return value if len(value) <= SHOWN_CHARS else value[: SHOWN_CHARS - 1] + "…"


def reply_matches(criterion: TextCriterion, reply: str) -> bool:
    if criterion.matcher == "regex":
        flags = re.IGNORECASE if criterion.ignore_case else 0
        return re.search(criterion.value, reply, flags) is not None
    return criterion.value.casefold() in reply.casefold()


def text_outcome(criterion: TextCriterion, replies: Sequence[str]) -> CheckOutcome:
    found = any(reply_matches(criterion, reply) for reply in replies)
    wanted = shown(criterion.value)
    if criterion.negated:
        if found:
            return failed(
                VerdictTier.code, f"a reply of the target contains {wanted!r}", TEXT_FORBIDDEN
            )
        return passed(VerdictTier.code, f"no reply contains {wanted!r}", TEXT_HOLDS, 1.0)
    if found:
        return passed(VerdictTier.code, f"a reply contains {wanted!r}", TEXT_HOLDS, 1.0)
    return failed(VerdictTier.code, f"no reply of the target contains {wanted!r}", TEXT_MISSING)


def tool_reference(criterion: ToolCriterion) -> ToolRef:
    if criterion.args:
        return ToolMatch(name=criterion.name, args=criterion.args)
    return criterion.name


def tool_outcome(criterion: ToolCriterion, tools: Sequence[StepTool]) -> CheckOutcome:
    reference = tool_reference(criterion)
    called = any(tool_matches(tool, reference) for tool in tools)
    if criterion.negated:
        if called:
            return failed(VerdictTier.code, f"the tool {criterion.name} was called", TOOL_FORBIDDEN)
        return passed(VerdictTier.code, f"{criterion.name} was never called", TOOL_HOLDS, 1.0)
    if called:
        return passed(VerdictTier.code, f"{criterion.name} was called", TOOL_HOLDS, 1.0)
    return failed(
        VerdictTier.code, f"the tool {criterion.name} was never called as required", TOOL_MISSING
    )
