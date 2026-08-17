import os
from pathlib import Path

import pytest

from tessa_api.services.vault import vault_from_settings
from tessa_api.settings import Settings
from tessa_worker.settings import WorkerSettings

WORKER_ROOT = Path(__file__).resolve().parent.parent
API_ENV_EXAMPLE = WORKER_ROOT.parent / "api" / ".env.example"
WORKER_ENV_EXAMPLE = WORKER_ROOT / ".env.example"


@pytest.fixture(autouse=True)
def clean_tessa_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.upper().startswith("TESSA_"):
            monkeypatch.delenv(name)


def test_a_value_encrypted_by_the_api_is_decrypted_by_the_worker() -> None:
    api_vault = vault_from_settings(Settings(_env_file=API_ENV_EXAMPLE))
    worker_vault = vault_from_settings(WorkerSettings(_env_file=WORKER_ENV_EXAMPLE))
    ciphertext = api_vault.encrypt("postgresql://reader:Sup3r-Secret@db:5432/app")
    assert worker_vault.decrypt(ciphertext).get_secret_value().endswith("Sup3r-Secret@db:5432/app")
