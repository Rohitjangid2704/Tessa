from typing import ClassVar

from pydantic_settings import SettingsConfigDict

from tessa_api.schemas.common import Probability
from tessa_api.settings import HttpUrl, PositiveInt, StrictSettings, TcpPort


class WorkerSettings(StrictSettings):
    model_config = SettingsConfigDict(env_file=".env")

    key_secret_fields: ClassVar[tuple[str, ...]] = ("service_key", "vault_key")
    distinct_secret_fields: ClassVar[tuple[str, ...]] = ("service_key", "vault_key")

    api_internal_url: HttpUrl
    laya_url: HttpUrl
    laya_timeout_seconds: PositiveInt
    worker_max_concurrent_activities: PositiveInt
    step_max_payload_bytes: PositiveInt
    browser_max_contexts: PositiveInt
    browser_headless: bool
    scenario_timeout_seconds: PositiveInt
    oracle_statement_timeout_ms: PositiveInt
    seed_script_timeout_seconds: PositiveInt
    finding_dedupe_threshold: Probability
    invariant_latency_ms: PositiveInt
    metrics_port: TcpPort
    fuzz_allow_writes: bool
    dry_run_repeats: PositiveInt
    fuzz_max_examples: PositiveInt
    fuzz_timeout_seconds: PositiveInt
    verify_replays: PositiveInt
    mutation_baseline_max_age_hours: PositiveInt
    ws_adapter_max_messages: PositiveInt


def load_settings() -> WorkerSettings:
    return WorkerSettings()
