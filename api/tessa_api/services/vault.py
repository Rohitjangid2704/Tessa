from typing import Annotated

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, Request
from pydantic import SecretStr

from tessa_api.settings import StrictSettings


class VaultError(Exception):
    pass


class Vault:
    def __init__(self, key: SecretStr) -> None:
        try:
            self._fernet = Fernet(key.get_secret_value().encode())
        except (ValueError, TypeError):
            raise VaultError("the vault key is not a valid Fernet key") from None

    def encrypt(self, plaintext: str) -> bytes:
        return self._fernet.encrypt(plaintext.encode())

    def decrypt(self, ciphertext: bytes) -> SecretStr:
        try:
            return SecretStr(self._fernet.decrypt(ciphertext).decode())
        except InvalidToken:
            raise VaultError("the stored value cannot be decrypted with the vault key") from None

    def __repr__(self) -> str:
        return "Vault(key=<redacted>)"


def vault_from_settings(settings: StrictSettings) -> Vault:
    return Vault(settings.vault_key)


def get_vault(request: Request) -> Vault:
    state = request.app.state
    vault: Vault | None = getattr(state, "vault", None)
    if vault is None:
        vault = vault_from_settings(state.settings)
        state.vault = vault
    return vault


VaultDep = Annotated[Vault, Depends(get_vault)]
