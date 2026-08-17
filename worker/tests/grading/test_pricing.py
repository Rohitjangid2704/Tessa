import json
import re
from decimal import Decimal
from pathlib import Path

import pytest

from tessa_worker.grading.pricing import (
    PRICE_TABLE_PATH,
    ChargeBasis,
    ModelPrice,
    PriceTable,
    TokenUsage,
    charge_for,
    default_price_table,
    load_price_table,
    stub_charge,
)
from tests.grading.support import JUDGE_MODEL, TIEBREAK_MODEL

CHEAP_MODEL = "gpt-6-luna"
WORKER_PACKAGE = Path(__file__).resolve().parents[2] / "tessa_worker"
MODEL_ID_PATTERN = re.compile(r"\b(?:gpt-\d[\w.\-]*|claude-[a-z]+-\d[\w.\-]*)")
MAX_USD = 0.05


def test_a_known_model_is_charged_from_token_usage() -> None:
    usage = TokenUsage(input_tokens=10_000, output_tokens=1_000, cached_input_tokens=2_000)
    charge = charge_for(JUDGE_MODEL, usage, MAX_USD)
    assert charge.basis is ChargeBasis.metered
    assert charge.cost_usd == pytest.approx(0.0262)


def test_cost_is_rounded_up_to_the_sixth_decimal() -> None:
    usage = TokenUsage(input_tokens=1, output_tokens=0, cached_input_tokens=1)
    assert charge_for(CHEAP_MODEL, usage, MAX_USD).cost_usd == 0.000001


def test_cache_writes_use_the_cache_write_rate_when_the_table_has_one() -> None:
    usage = TokenUsage(input_tokens=1_000_000, output_tokens=0, cache_write_tokens=1_000_000)
    assert charge_for(TIEBREAK_MODEL, usage, MAX_USD).cost_usd == 2.5
    assert charge_for(JUDGE_MODEL, usage, MAX_USD).cost_usd == 2.0


def test_an_unknown_model_is_charged_at_the_role_maximum() -> None:
    usage = TokenUsage(input_tokens=1, output_tokens=1)
    charge = charge_for("a-model-nobody-priced", usage, MAX_USD)
    assert charge.cost_usd == MAX_USD
    assert charge.basis is ChargeBasis.unknown_model


def test_missing_usage_on_a_known_model_is_charged_at_the_role_maximum() -> None:
    charge = charge_for(JUDGE_MODEL, None, MAX_USD)
    assert charge.cost_usd == MAX_USD
    assert charge.basis is ChargeBasis.usage_missing


def test_a_stub_call_costs_nothing() -> None:
    charge = stub_charge()
    assert charge.cost_usd == 0.0
    assert charge.basis is ChargeBasis.stub


def test_every_charge_records_the_price_table_version() -> None:
    version = default_price_table().version
    usage = TokenUsage(input_tokens=5, output_tokens=5)
    assert charge_for(JUDGE_MODEL, usage, MAX_USD).price_table_version == version
    assert charge_for("a-model-nobody-priced", usage, MAX_USD).price_table_version == version
    assert stub_charge().price_table_version == version


def test_the_shipped_table_is_versioned_and_valid() -> None:
    raw = json.loads(PRICE_TABLE_PATH.read_text(encoding="utf-8"))
    table = load_price_table()
    assert raw["version"] == table.version
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", table.version)
    assert table.currency == "usd"
    assert {JUDGE_MODEL, TIEBREAK_MODEL} <= set(table.models)


def test_extending_the_table_is_a_data_change(tmp_path: Path) -> None:
    table = PriceTable(
        version="2099-01-01.1",
        currency="usd",
        unit_tokens=1_000_000,
        models={
            "future-model": ModelPrice(
                input_per_million_usd=Decimal("1"),
                cached_input_per_million_usd=Decimal("0.1"),
                output_per_million_usd=Decimal("2"),
            )
        },
    )
    path = tmp_path / "table.json"
    path.write_text(table.model_dump_json(), encoding="utf-8")
    loaded = load_price_table(path)
    charge = charge_for(
        "future-model", TokenUsage(input_tokens=1_000_000, output_tokens=1_000_000), MAX_USD, loaded
    )
    assert charge.cost_usd == 3.0
    assert charge.price_table_version == "2099-01-01.1"


def test_no_model_id_is_hard_coded_in_the_grading_code() -> None:
    files = [
        *(WORKER_PACKAGE / "grading").glob("*.py"),
        *(WORKER_PACKAGE / "testing").glob("*.py"),
        *(WORKER_PACKAGE / "activities").glob("judge*.py"),
    ]
    offenders = {
        f"{path.name}: {match}"
        for path in files
        for match in MODEL_ID_PATTERN.findall(path.read_text(encoding="utf-8"))
    }
    assert offenders == set()
