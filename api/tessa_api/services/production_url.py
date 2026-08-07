import re
from urllib.parse import SplitResult, urlsplit

from tessa_api.settings import Settings

HTTP_SCHEMES = frozenset({"http", "https"})


def matches_production_pattern(settings: Settings, url: str) -> bool:
    return any(re.search(pattern, url) for pattern in settings.production_url_patterns)


def has_valid_port(parts: SplitResult) -> bool:
    try:
        return parts.port is None or parts.port > 0
    except ValueError:
        return False


def is_plain_http_address(url: str) -> bool:
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return (
        parts.scheme in HTTP_SCHEMES
        and bool(parts.hostname)
        and "@" not in parts.netloc
        and not parts.query
        and not parts.fragment
        and has_valid_port(parts)
    )
