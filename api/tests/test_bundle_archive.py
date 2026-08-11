import io

import pytest

from tessa_api.errors import ApiError
from tessa_api.services.bundle_archive import (
    ArchiveLimits,
    ExtractedArchive,
    extract_archive,
    normalise_entry_name,
)
from tests.support import settings_with
from tests.zip_builder import ZipEntry, build_zip, zip_entries

LIMITS = ArchiveLimits(
    max_zip_bytes=1024 * 1024,
    max_uncompressed_bytes=4 * 1024 * 1024,
    max_files=50,
    max_file_bytes=2 * 1024 * 1024,
)
MANIFEST = "schema: x\ntarget_token: tgt_x\n"


def extract(data: bytes, limits: ArchiveLimits = LIMITS) -> ExtractedArchive:
    return extract_archive(io.BytesIO(data), limits)


def rejection(data: bytes, limits: ArchiveLimits = LIMITS) -> ApiError:
    with pytest.raises(ApiError) as caught:
        extract(data, limits)
    return caught.value


def test_plain_archive_is_extracted() -> None:
    result = extract(build_zip({"manifest.yaml": MANIFEST, "seeds/reset.sql": "select 1;\n"}))
    assert set(result.files) == {"manifest.yaml", "seeds/reset.sql"}
    assert result.files["manifest.yaml"] == MANIFEST.encode()
    assert result.warnings == []


def test_single_tessa_prefix_is_stripped() -> None:
    result = extract(
        build_zip({"manifest.yaml": MANIFEST, "env.template": ""}, prefix="tessa/")
    )
    assert set(result.files) == {"manifest.yaml", "env.template"}


def test_prefix_is_kept_when_some_entries_are_outside_it() -> None:
    result = extract(build_zip({"tessa/manifest.yaml": MANIFEST, "README.md": "hi"}))
    assert set(result.files) == {"tessa/manifest.yaml", "README.md"}


def test_only_one_prefix_level_is_stripped() -> None:
    result = extract(build_zip({"tessa/tessa/manifest.yaml": MANIFEST}))
    assert set(result.files) == {"tessa/manifest.yaml"}


def test_backslash_paths_from_windows_powershell_are_normalised() -> None:
    data = build_zip(
        {"manifest.yaml": MANIFEST, "seeds/reset.sql": "select 1;", "oracle/a.sql": "select 2"},
        prefix="tessa/",
        separator="\\",
    )
    assert b"tessa\\seeds\\reset.sql" in data
    result = extract(data)
    assert set(result.files) == {"manifest.yaml", "seeds/reset.sql", "oracle/a.sql"}


def test_crlf_and_bom_are_normalised_to_lf() -> None:
    raw = b"\xef\xbb\xbfa: 1\r\nb: 2\r\nc: 3\rd: 4\n"
    result = extract(build_zip({"manifest.yaml": raw}))
    assert result.files["manifest.yaml"] == b"a: 1\nb: 2\nc: 3\nd: 4\n"


@pytest.mark.parametrize(
    "name",
    [
        "../evil.txt",
        "tessa/../../evil.txt",
        "a/../../evil.txt",
        "..\\evil.txt",
        "tessa\\..\\..\\evil.txt",
    ],
)
def test_parent_directory_entries_are_rejected(name: str) -> None:
    error = rejection(zip_entries([ZipEntry(name, b"x")]))
    assert error.status_code == 422
    assert error.details[0].code == "unsafe_path"


@pytest.mark.parametrize("name", ["/etc/passwd", "\\windows\\system32", "C:\\evil.txt", "c:/evil"])
def test_absolute_and_drive_letter_entries_are_rejected(name: str) -> None:
    error = rejection(zip_entries([ZipEntry(name, b"x")]))
    assert error.details[0].code == "unsafe_path"


@pytest.mark.parametrize("name", ["a/con.txt", "nul", "dir /file", "name.", "a/b:c", "a/b?c"])
def test_non_portable_names_are_rejected(name: str) -> None:
    error = rejection(zip_entries([ZipEntry(name, b"x")]))
    assert error.details[0].code == "unsafe_path"


def test_symlink_entries_are_rejected() -> None:
    error = rejection(zip_entries([ZipEntry("link", b"/etc/passwd", symlink=True)]))
    assert error.details[0].code == "symlink_entry"


def test_encrypted_entries_are_rejected() -> None:
    error = rejection(zip_entries([ZipEntry("secret.txt", b"x", encrypted=True)]))
    assert error.details[0].code == "encrypted_entry"


def test_entries_colliding_after_normalisation_are_rejected() -> None:
    data = zip_entries([ZipEntry("seeds/reset.sql", b"a"), ZipEntry("seeds\\reset.sql", b"b")])
    error = rejection(data)
    assert error.details[0].code == "duplicate_entry"


def test_entries_differing_only_in_case_are_rejected() -> None:
    error = rejection(zip_entries([ZipEntry("README.md", b"a"), ZipEntry("readme.md", b"b")]))
    assert error.details[0].code == "duplicate_entry"


def test_duplicate_through_prefix_stripping_is_rejected() -> None:
    error = rejection(
        zip_entries([ZipEntry("tessa/a.txt", b"a"), ZipEntry("tessa//a.txt", b"b")])
    )
    assert error.details[0].code == "duplicate_entry"


def test_directory_entries_and_system_files_are_skipped() -> None:
    data = zip_entries(
        [
            ZipEntry("seeds/", b""),
            ZipEntry("__MACOSX/._manifest.yaml", b"junk"),
            ZipEntry(".DS_Store", b"junk"),
            ZipEntry("manifest.yaml", b"a: 1"),
        ]
    )
    result = extract(data)
    assert set(result.files) == {"manifest.yaml"}
    assert result.warnings == []


def test_binary_and_non_utf8_entries_are_dropped_with_a_warning() -> None:
    data = zip_entries(
        [
            ZipEntry("logo.png", b"\x89PNG\r\n\x1a\n\x00\x00"),
            ZipEntry("latin1.txt", "caf\xe9".encode("latin-1")),
            ZipEntry("manifest.yaml", b"a: 1"),
        ]
    )
    result = extract(data)
    assert set(result.files) == {"manifest.yaml"}
    assert sorted(warning.file for warning in result.warnings) == ["latin1.txt", "logo.png"]
    assert {warning.code for warning in result.warnings} == {"file_ignored"}
    assert {warning.severity for warning in result.warnings} == {"warning"}


def test_zip_larger_than_limit_is_413() -> None:
    data = build_zip({"big.txt": "x" * 4000})
    tight = ArchiveLimits(
        100, LIMITS.max_uncompressed_bytes, LIMITS.max_files, LIMITS.max_file_bytes
    )
    error = rejection(data, tight)
    assert error.status_code == 413
    assert error.code == "payload_too_large"
    assert error.details[0].code == "archive_too_large"


def test_too_many_entries_is_413() -> None:
    data = build_zip({f"f{index}.txt": "x" for index in range(6)})
    tight = ArchiveLimits(
        LIMITS.max_zip_bytes, LIMITS.max_uncompressed_bytes, 5, LIMITS.max_file_bytes
    )
    error = rejection(data, tight)
    assert error.status_code == 413
    assert error.details[0].code == "too_many_entries"


def test_entry_larger_than_limit_is_413() -> None:
    data = build_zip({"big.txt": "a1b2" * 400})
    tight = ArchiveLimits(LIMITS.max_zip_bytes, LIMITS.max_uncompressed_bytes, 50, 1000)
    error = rejection(data, tight)
    assert error.status_code == 413
    assert error.details[0].code == "entry_too_large"
    assert error.details[0].loc == ["file", "big.txt"]


def test_total_expanded_size_is_enforced_on_bytes_read() -> None:
    files = {f"f{index}.txt": f"{index:04d}" * 600 for index in range(4)}
    data = build_zip(files)
    tight = ArchiveLimits(LIMITS.max_zip_bytes, 5000, 50, LIMITS.max_file_bytes)
    error = rejection(data, tight)
    assert error.status_code == 413
    assert error.details[0].code == "expanded_too_large"


def test_compression_ratio_bomb_is_413() -> None:
    data = build_zip({"zeros.txt": "0" * (3 * 512 * 1024)})
    assert len(data) < 20 * 1024
    error = rejection(data)
    assert error.status_code == 413
    assert error.details[0].code == "compression_ratio_exceeded"


def test_small_highly_compressible_file_is_allowed() -> None:
    result = extract(build_zip({"pad.txt": "0" * 200_000}))
    assert len(result.files["pad.txt"]) == 200_000


def test_not_a_zip_is_rejected() -> None:
    error = rejection(b"this is not a zip at all")
    assert error.status_code == 422
    assert error.details[0].code == "invalid_archive"


def test_corrupt_entry_is_rejected() -> None:
    data = bytearray(build_zip({"manifest.yaml": "a1b2c3d4" * 500}))
    start = data.index(b"manifest.yaml") + len("manifest.yaml") + 4
    data[start : start + 8] = b"\xff" * 8
    error = rejection(bytes(data))
    assert error.status_code == 422
    assert error.details[0].code == "invalid_archive"


def test_empty_archive_extracts_to_nothing() -> None:
    result = extract(zip_entries([]))
    assert result.files == {}


def test_normalise_entry_name_collapses_noise() -> None:
    assert normalise_entry_name("./a//b/./c.txt") == "a/b/c.txt"
    assert normalise_entry_name("a\\b\\c.txt") == "a/b/c.txt"
    assert normalise_entry_name("a/") == "a"


def test_limits_come_from_settings() -> None:
    settings = settings_with()
    limits = ArchiveLimits.from_settings(settings)
    assert limits.max_zip_bytes == settings.bundle_max_zip_bytes
    assert limits.max_files == settings.bundle_max_files
