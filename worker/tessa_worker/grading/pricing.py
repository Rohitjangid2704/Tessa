from dataclasses import dataclass
from decimal import ROUND_UP, Decimal
from enum import StrEnum
from functools import cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

PRICE_TABLE_PATH = Path(__file__).with_name("price_table.json")
USD_QUANTUM = Decimal("0.000001")


class ModelPrice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    input_per_million_usd: Decimal = Field(ge=0)
    cached_input_per_million_usd: Decimal = Field(ge=0)
    cache_write_per_million_usd: Decimal | None = Field(default=None, ge=0)
    output_per_million_usd: Decimal = Field(ge=0)


class PriceTable(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: str = Field(min_length=1)
    currency: str
    unit_tokens: int = Field(gt=0)
    models: dict[str, ModelPrice]


class ChargeBasis(StrEnum):
    metered = "metered"
    unknown_model = "unknown_model"
    usage_missing = "usage_missing"
    stub = "stub"


@dataclass(frozen=True, slots=True)
class TokenUsage:
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass(frozen=True, slots=True)
class Charge:
    cost_usd: float
    basis: ChargeBasis
    price_table_version: str


def load_price_table(path: Path = PRICE_TABLE_PATH) -> PriceTable:
    return PriceTable.model_validate_json(path.read_text(encoding="utf-8"))


@cache
def default_price_table() -> PriceTable:
    return load_price_table()


def round_up_usd(amount: Decimal) -> float:
    return float(amount.quantize(USD_QUANTUM, rounding=ROUND_UP))


def metered_cost(table: PriceTable, price: ModelPrice, usage: TokenUsage) -> Decimal:
    plain_input = max(0, usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens)
    cache_write_rate = (
        price.input_per_million_usd
        if price.cache_write_per_million_usd is None
        else price.cache_write_per_million_usd
    )
    total = (
        plain_input * price.input_per_million_usd
        + usage.cached_input_tokens * price.cached_input_per_million_usd
        + usage.cache_write_tokens * cache_write_rate
        + usage.output_tokens * price.output_per_million_usd
    )
    return total / table.unit_tokens


def charge_for(
    model: str, usage: TokenUsage | None, max_usd: float, table: PriceTable | None = None
) -> Charge:
    price_table = table or default_price_table()
    price = price_table.models.get(model)
    if price is None:
        return Charge(max_usd, ChargeBasis.unknown_model, price_table.version)
    if usage is None:
        return Charge(max_usd, ChargeBasis.usage_missing, price_table.version)
    return Charge(
        round_up_usd(metered_cost(price_table, price, usage)),
        ChargeBasis.metered,
        price_table.version,
    )


def stub_charge(table: PriceTable | None = None) -> Charge:
    return Charge(0.0, ChargeBasis.stub, (table or default_price_table()).version)
