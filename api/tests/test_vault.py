import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from tessa_api.services.vault import Vault, VaultError, vault_from_settings
from tessa_api.settings import Settings
from tests.support import API_ROOT, ENV_EXAMPLE_PATH
from tests.test_settings import production_overrides, write_env

PLAINTEXT = "postgresql://qa_reader:S3cr3t-Pa55@db.internal:5432/app"


@pytest.fixture
def vault() -> Vault:
    return Vault(SecretStr(Fernet.generate_key().decode()))


def test_round_trip_returns_a_secret_string(vault: Vault) -> None:
    decrypted = vault.decrypt(vault.encrypt(PLAINTEXT))
    assert isinstance(decrypted, SecretStr)
    assert decrypted.get_secret_value() == PLAINTEXT
    assert PLAINTEXT not in repr(decrypted)
    assert PLAINTEXT not in str(decrypted)


def test_ciphertext_is_bytes_without_the_plaintext(vault: Vault) -> None:
    ciphertext = vault.encrypt(PLAINTEXT)
    assert isinstance(ciphertext, bytes)
    assert PLAINTEXT.encode() not in ciphertext
    assert b"S3cr3t" not in ciphertext
    assert b"qa_reader" not in ciphertext


def test_two_encryptions_of_one_value_differ(vault: Vault) -> None:
    assert vault.encrypt(PLAINTEXT) != vault.encrypt(PLAINTEXT)


def test_non_ascii_values_survive(vault: Vault) -> None:
    value = "pässwörd-日本語"
    assert vault.decrypt(vault.encrypt(value)).get_secret_value() == value


def test_decrypting_with_another_key_fails_without_leaking(vault: Vault) -> None:
    other = Vault(SecretStr(Fernet.generate_key().decode()))
    with pytest.raises(VaultError) as caught:
        other.decrypt(vault.encrypt(PLAINTEXT))
    assert PLAINTEXT not in str(caught.value)


def test_garbage_ciphertext_fails_as_a_vault_error(vault: Vault) -> None:
    with pytest.raises(VaultError):
        vault.decrypt(b"not a fernet token")


def test_a_key_that_is_not_fernet_is_refused_without_echoing_it() -> None:
    with pytest.raises(VaultError) as caught:
        Vault(SecretStr("dev-only-too-short"))
    assert "dev-only-too-short" not in str(caught.value)


def test_repr_hides_the_key() -> None:
    key = Fernet.generate_key().decode()
    vault = Vault(SecretStr(key))
    assert key not in repr(vault)
    assert key not in str(vault)


def test_vault_is_built_from_settings(settings: Settings) -> None:
    vault = vault_from_settings(settings)
    assert vault.decrypt(vault.encrypt("x")).get_secret_value() == "x"


def test_the_dev_placeholder_key_works_and_is_rejected_in_prod(tmp_path: Path) -> None:
    dev = Settings(_env_file=ENV_EXAMPLE_PATH)
    assert (
        vault_from_settings(dev).decrypt(vault_from_settings(dev).encrypt("x")).get_secret_value()
        == "x"
    )
    path = write_env(tmp_path, replace={"TESSA_ENV": "prod"})
    with pytest.raises(ValueError, match="vault_key still holds a dev-only- placeholder in prod"):
        Settings(_env_file=path)


def test_gen_secrets_prints_four_fresh_values_that_pass_the_prod_checks(tmp_path: Path) -> None:
    first = run_gen_secrets()
    second = run_gen_secrets()
    assert [line.partition("=")[0] for line in first] == [
        "TESSA_VAULT_KEY",
        "TESSA_API_JWT_SECRET",
        "TESSA_SIGNING_KEY",
        "TESSA_SERVICE_KEY",
    ]
    assert set(first).isdisjoint(second)
    generated = dict(line.split("=", 1) for line in first)
    assert len(set(generated.values())) == 4
    overrides = {**production_overrides(), **generated}
    loaded = Settings(_env_file=write_env(tmp_path, replace=overrides))
    assert loaded.env == "prod"
    assert vault_from_settings(loaded).decrypt(vault_from_settings(loaded).encrypt("x"))


def run_gen_secrets() -> list[str]:
    result = subprocess.run(
        [sys.executable, "scripts/gen_secrets.py"],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()
