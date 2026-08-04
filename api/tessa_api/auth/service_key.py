import hmac

from tessa_api.settings import StrictSettings


def service_key_matches(provided: str | None, settings: StrictSettings) -> bool:
    if not provided:
        return False
    expected = settings.service_key.get_secret_value()
    return hmac.compare_digest(provided.encode(), expected.encode())
