import secrets

from cryptography.fernet import Fernet

KEY_BYTES = 48


def generate_lines() -> list[str]:
    return [
        f"TESSA_VAULT_KEY={Fernet.generate_key().decode()}",
        f"TESSA_API_JWT_SECRET={secrets.token_urlsafe(KEY_BYTES)}",
        f"TESSA_SIGNING_KEY={secrets.token_urlsafe(KEY_BYTES)}",
        f"TESSA_SERVICE_KEY={secrets.token_urlsafe(KEY_BYTES)}",
    ]


def main() -> int:
    for line in generate_lines():
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
