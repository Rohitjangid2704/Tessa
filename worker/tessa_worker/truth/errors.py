from enum import StrEnum


class SeedFailureCode(StrEnum):
    hook_missing = "hook_missing"
    env_missing = "env_missing"
    timeout = "timeout"
    script_failed = "script_failed"
    script_unsupported = "script_unsupported"
    hash_invalid = "hash_invalid"
    material_missing = "material_missing"
    spawn_failed = "spawn_failed"
    baseline_missing = "baseline_missing"
    canceled = "canceled"


class SeedFailure(Exception):
    def __init__(self, code: SeedFailureCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
