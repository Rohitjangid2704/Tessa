from collections.abc import Sequence

from tessa_worker.adapters.redact import Redactor
from tessa_worker.truth.process import TailSnapshot

OUTPUT_EXCERPT_BYTES = 4096
OUTPUT_RETAIN_BYTES = 65536
SECRET_MARGIN_FACTOR = 4
TRUNCATION_MARKER = "[earlier output omitted]\n"


def retained_bytes(redactor: Redactor) -> int:
    return max(
        OUTPUT_RETAIN_BYTES,
        OUTPUT_EXCERPT_BYTES + SECRET_MARGIN_FACTOR * redactor.max_secret_length,
    )


def output_excerpt(
    snapshots: Sequence[TailSnapshot], redactor: Redactor, limit: int = OUTPUT_EXCERPT_BYTES
) -> str:
    data = b"".join(snapshot.data for snapshot in snapshots)
    redacted = redactor.redact_text(data.decode("utf-8", errors="replace"))
    encoded = redacted.encode("utf-8")
    if len(encoded) <= limit and not any(snapshot.truncated for snapshot in snapshots):
        return redacted
    marker = TRUNCATION_MARKER.encode("utf-8")
    kept = encoded[-(limit - len(marker)) :].decode("utf-8", errors="ignore")
    return TRUNCATION_MARKER + kept
