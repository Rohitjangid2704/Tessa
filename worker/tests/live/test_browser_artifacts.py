import json
import zipfile
from pathlib import Path
from urllib.parse import quote

import pytest

from tessa_worker.adapters.browser_artifacts import (
    is_text_entry,
    redact_trace_archive,
    redacted_entry,
)
from tessa_worker.adapters.redact import Redactor

SECRET = "pa55/word&token=1"
REDACTOR = Redactor({"STAFF_PASSWORD": SECRET})
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + SECRET.encode() + b"\x00\xff\xfe"


def build_archive(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)


def read_archive(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        return {name: archive.read(name) for name in archive.namelist()}


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("trace.trace", True),
        ("trace.network", True),
        ("trace.stacks", True),
        ("resources/abc123.html", True),
        ("resources/style.CSS", True),
        ("resources/app.js", True),
        ("screencast/page@1-1700.jpeg", False),
        ("resources/abc.png", False),
        ("resources/font.woff2", False),
        ("resources/0123456789abcdef", False),
    ],
)
def test_only_text_entries_are_rewritten(name: str, expected: bool) -> None:
    assert is_text_entry(name) is expected


def test_a_secret_in_a_text_entry_becomes_its_placeholder() -> None:
    content = f'{{"params": {{"value": "{json.dumps(SECRET)[1:-1]}"}}}}'.encode()
    assert redacted_entry("trace.trace", content, REDACTOR) == (
        b'{"params": {"value": "${STAFF_PASSWORD}"}}'
    )


def test_a_secret_in_a_binary_entry_is_left_as_is() -> None:
    assert redacted_entry("shot.png", PNG_BYTES, REDACTOR) == PNG_BYTES


def test_text_that_is_not_utf8_is_left_as_is() -> None:
    content = b"\xff\xfe" + SECRET.encode()
    assert redacted_entry("resources/odd.html", content, REDACTOR) == content


def test_the_archive_is_rewritten_in_place_with_every_secret_variant_removed(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "t0.zip"
    entries = {
        "trace.trace": f'{{"value": {json.dumps(SECRET)}}}\n'.encode(),
        "trace.network": f"POST /login?p={quote(SECRET, safe='')}\n".encode(),
        "resources/page.html": f'<input value="{SECRET}">'.encode(),
        "screencast/frame.jpeg": PNG_BYTES,
        "resources/clean.css": b"body { color: red }",
    }
    build_archive(archive, entries)
    changed = redact_trace_archive(archive, REDACTOR)
    rewritten = read_archive(archive)
    assert changed == 3
    assert set(rewritten) == set(entries)
    for name in ("trace.trace", "trace.network", "resources/page.html"):
        assert SECRET.encode() not in rewritten[name]
        assert b"${STAFF_PASSWORD}" in rewritten[name]
    assert rewritten["screencast/frame.jpeg"] == PNG_BYTES
    assert rewritten["resources/clean.css"] == b"body { color: red }"
    assert list(tmp_path.glob("*.redacting")) == []


def test_an_archive_without_secrets_is_not_touched(tmp_path: Path) -> None:
    archive = tmp_path / "t1.zip"
    build_archive(archive, {"trace.trace": b"nothing here"})
    before = archive.read_bytes()
    assert redact_trace_archive(archive, Redactor()) == 0
    assert archive.read_bytes() == before
    assert redact_trace_archive(archive, REDACTOR) == 0


def test_a_broken_archive_raises_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    archive = tmp_path / "t2.zip"
    archive.write_bytes(b"not a zip")
    with pytest.raises(zipfile.BadZipFile):
        redact_trace_archive(archive, REDACTOR)
    assert list(tmp_path.glob("*.redacting")) == []
