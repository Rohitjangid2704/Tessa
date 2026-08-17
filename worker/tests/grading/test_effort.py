from typing import get_args

import pytest

from tessa_api.schemas.enums import Effort
from tessa_worker.grading.effort import PROVIDER_EFFORT, ProviderEffort, provider_effort

PROVIDER_VALUES = set(get_args(ProviderEffort))


def test_every_contract_effort_has_a_provider_value() -> None:
    assert set(PROVIDER_EFFORT) == set(Effort)


def test_provider_values_are_the_ones_the_models_accept() -> None:
    assert {"low", "medium", "high", "xhigh", "max"} == PROVIDER_VALUES
    assert set(PROVIDER_EFFORT.values()) <= PROVIDER_VALUES


def test_neither_none_nor_minimal_is_ever_sent() -> None:
    sent = {provider_effort(effort) for effort in Effort}
    assert "minimal" not in sent
    assert "none" not in sent


@pytest.mark.parametrize(
    ("effort", "expected"),
    [
        (Effort.minimal, "low"),
        (Effort.low, "low"),
        (Effort.medium, "medium"),
        (Effort.high, "high"),
    ],
)
def test_the_mapping_is_monotonic_and_pinned(effort: Effort, expected: str) -> None:
    assert provider_effort(effort) == expected
