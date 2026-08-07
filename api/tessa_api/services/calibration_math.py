from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field

from tessa_api.schemas.enums import LabelValue

KAPPA_DECIMALS = 4
AGREEMENT_DECIMALS = 4


@dataclass(frozen=True, slots=True)
class ConfusionTable:
    both_pass: int
    human_pass_machine_fail: int
    human_fail_machine_pass: int
    both_fail: int

    @property
    def total(self) -> int:
        return (
            self.both_pass
            + self.human_pass_machine_fail
            + self.human_fail_machine_pass
            + self.both_fail
        )

    @property
    def agreed(self) -> int:
        return self.both_pass + self.both_fail

    @property
    def human_pass(self) -> int:
        return self.both_pass + self.human_pass_machine_fail

    @property
    def human_fail(self) -> int:
        return self.human_fail_machine_pass + self.both_fail

    @property
    def machine_pass(self) -> int:
        return self.both_pass + self.human_fail_machine_pass

    @property
    def machine_fail(self) -> int:
        return self.human_pass_machine_fail + self.both_fail


def cohen_kappa(table: ConfusionTable) -> float | None:
    total = table.total
    if total == 0:
        return None
    chance = table.human_pass * table.machine_pass + table.human_fail * table.machine_fail
    denominator = total * total - chance
    if denominator == 0:
        return None
    return round((total * table.agreed - chance) / denominator, KAPPA_DECIMALS)


def kappa_when_enough(table: ConfusionTable, min_labels: int) -> float | None:
    if table.total < min_labels:
        return None
    return cohen_kappa(table)


def raw_agreement(agreed: int, compared: int) -> float | None:
    if compared == 0:
        return None
    return round(agreed / compared, AGREEMENT_DECIMALS)


def weighted_mean_kappa(items: Iterable[tuple[int, float | None]]) -> float | None:
    weight = 0
    weighted_sum = 0.0
    for labels, kappa in items:
        if kappa is None or labels <= 0:
            continue
        weight += labels
        weighted_sum += labels * kappa
    if weight == 0:
        return None
    return round(weighted_sum / weight, KAPPA_DECIMALS)


@dataclass(slots=True)
class PairTally:
    counts: Counter[tuple[LabelValue, LabelValue]] = field(default_factory=Counter)

    def add(self, human: LabelValue, machine: LabelValue, count: int = 1) -> None:
        if count > 0:
            self.counts[(human, machine)] += count

    @property
    def compared(self) -> int:
        return sum(self.counts.values())

    @property
    def agreed(self) -> int:
        return sum(count for (human, machine), count in self.counts.items() if human is machine)

    def decided_table(self) -> ConfusionTable:
        return ConfusionTable(
            both_pass=self.counts[(LabelValue.pass_, LabelValue.pass_)],
            human_pass_machine_fail=self.counts[(LabelValue.pass_, LabelValue.fail)],
            human_fail_machine_pass=self.counts[(LabelValue.fail, LabelValue.pass_)],
            both_fail=self.counts[(LabelValue.fail, LabelValue.fail)],
        )
