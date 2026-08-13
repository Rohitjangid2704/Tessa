import os
import tempfile
import zipfile
from pathlib import Path

from tessa_worker.adapters.redact import Redactor

TEXT_SUFFIXES = (".trace", ".network", ".stacks", ".html", ".css", ".js", ".json", ".svg", ".txt")
REWRITE_SUFFIX = ".redacting"


def is_text_entry(name: str) -> bool:
    return name.lower().endswith(TEXT_SUFFIXES)


def redacted_entry(name: str, content: bytes, redactor: Redactor) -> bytes:
    if not is_text_entry(name):
        return content
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return content
    return redactor.redact_text(text).encode("utf-8")


def redact_trace_archive(path: Path, redactor: Redactor) -> int:
    if redactor.max_secret_length == 0:
        return 0
    changed = 0
    descriptor, temporary_name = tempfile.mkstemp(
        suffix=REWRITE_SUFFIX, dir=path.parent, prefix=path.stem
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with (
            zipfile.ZipFile(path) as source,
            zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target,
        ):
            for entry in source.infolist():
                original = source.read(entry.filename)
                rewritten = redacted_entry(entry.filename, original, redactor)
                changed += rewritten != original
                target.writestr(entry.filename, rewritten)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return changed
