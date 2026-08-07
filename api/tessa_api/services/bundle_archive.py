import re
import zipfile
import zlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import BinaryIO

from tessa_api.errors import ApiError
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.settings import Settings

ZIP_CONTENT_TYPES = frozenset({"application/zip", "application/x-zip-compressed"})
BUNDLE_ROOT_FOLDER = "tessa"
READ_CHUNK_BYTES = 64 * 1024
RATIO_CHECK_MIN_BYTES = 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_PATH_LENGTH = 512
MAX_SEGMENT_LENGTH = 255
UNIX_FILE_TYPE_MASK = 0o170000
UNIX_SYMLINK_TYPE = 0o120000
ENCRYPTED_FLAG = 0x1
DRIVE_LETTER_PATTERN = re.compile(r"^[A-Za-z]:")
FORBIDDEN_SEGMENT_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_NAMES = frozenset(
    {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{n}" for n in range(1, 10)),
        *(f"lpt{n}" for n in range(1, 10)),
    }
)
SILENTLY_IGNORED_SEGMENTS = frozenset({"__macosx"})
SILENTLY_IGNORED_FILE_NAMES = frozenset({".ds_store", "thumbs.db", "desktop.ini"})


@dataclass(frozen=True)
class ArchiveLimits:
    max_zip_bytes: int
    max_uncompressed_bytes: int
    max_files: int
    max_file_bytes: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ArchiveLimits":
        return cls(
            max_zip_bytes=settings.bundle_max_zip_bytes,
            max_uncompressed_bytes=settings.bundle_max_uncompressed_bytes,
            max_files=settings.bundle_max_files,
            max_file_bytes=settings.bundle_max_file_bytes,
        )


@dataclass
class ExtractedArchive:
    files: dict[str, bytes] = field(default_factory=dict)
    warnings: list[BundleValidationError] = field(default_factory=list)


def too_large(code: str, message: str, path: str | None = None) -> ApiError:
    loc: list[str | int] = ["file"] if path is None else ["file", path]
    return ApiError(
        413, "payload_too_large", message, [ErrorDetail(loc=loc, code=code, message=message)]
    )


def rejected(code: str, message: str, path: str | None = None) -> ApiError:
    loc: list[str | int] = ["file"] if path is None else ["file", path]
    return ApiError(
        422, "validation_failed", message, [ErrorDetail(loc=loc, code=code, message=message)]
    )


def has_forbidden_characters(segment: str) -> bool:
    return any(
        character in FORBIDDEN_SEGMENT_CHARACTERS or ord(character) < 32 for character in segment
    )


def normalise_entry_name(raw_name: str) -> str:
    name = raw_name.replace("\\", "/")
    if name.startswith("/"):
        raise rejected("unsafe_path", f"Absolute path {raw_name!r} is not allowed", raw_name)
    if DRIVE_LETTER_PATTERN.match(name):
        raise rejected("unsafe_path", f"Drive letter path {raw_name!r} is not allowed", raw_name)
    segments: list[str] = []
    for segment in name.split("/"):
        if segment in {"", "."}:
            continue
        if segment == "..":
            raise rejected(
                "unsafe_path", f"Path {raw_name!r} climbs out of the bundle with '..'", raw_name
            )
        if has_forbidden_characters(segment):
            raise rejected(
                "unsafe_path", f"Path {raw_name!r} has characters that are not allowed", raw_name
            )
        if segment.endswith((".", " ")) or segment.split(".")[0].lower() in WINDOWS_RESERVED_NAMES:
            raise rejected(
                "unsafe_path", f"Path {raw_name!r} has a name that is not portable", raw_name
            )
        if len(segment) > MAX_SEGMENT_LENGTH:
            raise rejected(
                "unsafe_path", f"Path {raw_name!r} has a segment that is too long", raw_name
            )
        segments.append(segment)
    normalised = "/".join(segments)
    if len(normalised) > MAX_PATH_LENGTH:
        raise rejected("unsafe_path", f"Path {raw_name!r} is too long", raw_name)
    return normalised


def is_ignored_silently(normalised: str) -> bool:
    segments = normalised.split("/")
    if any(segment.lower() in SILENTLY_IGNORED_SEGMENTS for segment in segments):
        return True
    return segments[-1].lower() in SILENTLY_IGNORED_FILE_NAMES


def check_entry_header(info: zipfile.ZipInfo) -> None:
    if info.flag_bits & ENCRYPTED_FLAG:
        raise rejected("encrypted_entry", f"Entry {info.filename!r} is encrypted", info.filename)
    unix_mode = info.external_attr >> 16
    if unix_mode & UNIX_FILE_TYPE_MASK == UNIX_SYMLINK_TYPE:
        raise rejected(
            "symlink_entry", f"Entry {info.filename!r} is a symbolic link", info.filename
        )


class ExpandedBudget:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0

    def consume(self, amount: int) -> None:
        self.used += amount
        if self.used > self.limit:
            raise too_large(
                "expanded_too_large",
                f"The archive expands to more than {self.limit} bytes",
            )


def read_entry(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    path: str,
    limits: ArchiveLimits,
    budget: ExpandedBudget,
) -> bytes:
    if info.file_size > limits.max_file_bytes:
        raise too_large(
            "entry_too_large",
            f"{path} is larger than {limits.max_file_bytes} bytes",
            path,
        )
    chunks: list[bytes] = []
    total = 0
    try:
        with archive.open(info) as stream:
            while chunk := stream.read(READ_CHUNK_BYTES):
                total += len(chunk)
                if total > limits.max_file_bytes:
                    raise too_large(
                        "entry_too_large",
                        f"{path} is larger than {limits.max_file_bytes} bytes",
                        path,
                    )
                budget.consume(len(chunk))
                chunks.append(chunk)
    except (zipfile.BadZipFile, zlib.error, EOFError) as error:
        raise rejected(
            "invalid_archive", f"Entry {path!r} could not be read: {error}", path
        ) from error
    except (NotImplementedError, RuntimeError) as error:
        raise rejected(
            "unsupported_compression", f"Entry {path!r} uses an unsupported method", path
        ) from error
    if total >= RATIO_CHECK_MIN_BYTES and total > MAX_COMPRESSION_RATIO * max(
        info.compress_size, 1
    ):
        raise too_large(
            "compression_ratio_exceeded",
            f"{path} expands more than {MAX_COMPRESSION_RATIO} to 1",
            path,
        )
    return b"".join(chunks)


def to_normalised_text(content: bytes) -> bytes | None:
    if b"\x00" in content:
        return None
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    return text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def ignored_file_warning(path: str, reason: str) -> BundleValidationError:
    return BundleValidationError(
        code="file_ignored", message=f"Ignored {path}: {reason}", severity="warning", file=path
    )


def strip_bundle_root(paths: Sequence[str]) -> bool:
    prefix = f"{BUNDLE_ROOT_FOLDER}/"
    return bool(paths) and all(path.startswith(prefix) for path in paths)


def archive_size(source: BinaryIO) -> int:
    source.seek(0, 2)
    size = source.tell()
    source.seek(0)
    return size


def extract_archive(source: BinaryIO, limits: ArchiveLimits) -> ExtractedArchive:
    size = archive_size(source)
    if size > limits.max_zip_bytes:
        raise too_large("archive_too_large", f"The zip is larger than {limits.max_zip_bytes} bytes")
    try:
        archive = zipfile.ZipFile(source)
    except zipfile.BadZipFile as error:
        raise rejected("invalid_archive", "The upload is not a readable zip archive") from error
    with archive:
        infos = archive.infolist()
        if len(infos) > limits.max_files:
            raise too_large(
                "too_many_entries", f"The archive has more than {limits.max_files} entries"
            )
        entries: list[tuple[str, zipfile.ZipInfo]] = []
        for info in infos:
            if info.is_dir() or info.filename.replace("\\", "/").endswith("/"):
                continue
            check_entry_header(info)
            normalised = normalise_entry_name(info.filename)
            if not normalised or is_ignored_silently(normalised):
                continue
            entries.append((normalised, info))
        if strip_bundle_root([path for path, _ in entries]):
            prefix_length = len(BUNDLE_ROOT_FOLDER) + 1
            entries = [(path[prefix_length:], info) for path, info in entries]
        extracted = ExtractedArchive()
        seen: dict[str, str] = {}
        budget = ExpandedBudget(limits.max_uncompressed_bytes)
        for path, info in entries:
            key = path.casefold()
            if key in seen:
                raise rejected(
                    "duplicate_entry",
                    f"Entries {seen[key]!r} and {path!r} collide after normalisation",
                    path,
                )
            seen[key] = path
            content = read_entry(archive, info, path, limits, budget)
            text = to_normalised_text(content)
            if text is None:
                extracted.warnings.append(
                    ignored_file_warning(path, "binary or not valid UTF-8, only text is stored")
                )
                continue
            extracted.files[path] = text
    return extracted
