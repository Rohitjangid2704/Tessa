import logging
import re
from functools import lru_cache

from tessa_api.schemas.bundle import BundleManifest
from tessa_worker.checks.common import SAMPLE_LIMIT
from tessa_worker.checks.contracts import Tier0Context

logger = logging.getLogger("tessa_worker.checks")

INTERNAL_ID_INVARIANT = "no_internal_ids"
INTERNAL_ID_PATTERNS_KEY = "internal_id_patterns"
UUID_PATTERN = r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
NUMERIC_ID_PATTERN = r"(?i)\b(?:[a-z0-9]+_)*id\b[\"']?\s*[:=#]?\s*[\"']?\d{2,}\b"
DEFAULT_INTERNAL_ID_PATTERNS = (UUID_PATTERN, NUMERIC_ID_PATTERN)
MAX_PATTERN_LENGTH = 200


@lru_cache(maxsize=256)
def compiled(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


def find_internal_ids(text: str, patterns: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for pattern in patterns:
        for match in compiled(pattern).finditer(text):
            if match.group(0) not in found:
                found.append(match.group(0))
            if len(found) >= SAMPLE_LIMIT:
                return found
    return found


def usable_pattern(pattern: object) -> str | None:
    if not isinstance(pattern, str) or not pattern or len(pattern) > MAX_PATTERN_LENGTH:
        logger.warning("internal_id_pattern_ignored", extra={"reason": "not a usable string"})
        return None
    try:
        compiled(pattern)
    except re.error:
        logger.warning("internal_id_pattern_ignored", extra={"reason": "does not compile"})
        return None
    return pattern


def declared_patterns(manifest: BundleManifest) -> list[str]:
    patterns: list[str] = []
    for invariant in manifest.invariants:
        if invariant.id != INTERNAL_ID_INVARIANT:
            continue
        declared = (invariant.model_extra or {}).get(INTERNAL_ID_PATTERNS_KEY)
        candidates = declared if isinstance(declared, list) else [declared]
        for candidate in candidates:
            if candidate is None:
                continue
            usable = usable_pattern(candidate)
            if usable is not None and usable not in patterns:
                patterns.append(usable)
    return patterns


def build_tier0_context(manifest: BundleManifest) -> Tier0Context:
    return Tier0Context(
        internal_id_patterns=(*DEFAULT_INTERNAL_ID_PATTERNS, *declared_patterns(manifest))
    )
