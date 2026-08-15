from collections.abc import Mapping
from typing import Literal

from tessa_api.schemas.enums import Effort

ProviderEffort = Literal["low", "medium", "high", "xhigh", "max"]

LOWEST_PROVIDER_EFFORT: ProviderEffort = "low"

PROVIDER_EFFORT: Mapping[Effort, ProviderEffort] = {
    Effort.minimal: LOWEST_PROVIDER_EFFORT,
    Effort.low: "low",
    Effort.medium: "medium",
    Effort.high: "high",
}


def provider_effort(effort: Effort) -> ProviderEffort:
    return PROVIDER_EFFORT[effort]
