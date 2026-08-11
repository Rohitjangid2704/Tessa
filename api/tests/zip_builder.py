import io
import zipfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
REGULAR_FILE_ATTRIBUTE = 0o100644 << 16
SYMLINK_ATTRIBUTE = 0o120777 << 16
ENCRYPTED_FLAG = 0x1


@dataclass(frozen=True)
class ZipEntry:
    name: str
    content: bytes
    symlink: bool = False
    encrypted: bool = False
    stored: bool = False


def to_bytes(content: str | bytes) -> bytes:
    return content.encode("utf-8") if isinstance(content, str) else content


def zip_entries(entries: Iterable[ZipEntry]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for entry in entries:
            info = zipfile.ZipInfo(entry.name, date_time=FIXED_TIMESTAMP)
            info.filename = entry.name
            info.compress_type = zipfile.ZIP_STORED if entry.stored else zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = SYMLINK_ATTRIBUTE if entry.symlink else REGULAR_FILE_ATTRIBUTE
            archive.writestr(info, entry.content, compresslevel=9)
            if entry.encrypted:
                info.flag_bits |= ENCRYPTED_FLAG
    return buffer.getvalue()


def build_zip(files: Mapping[str, str | bytes], prefix: str = "", separator: str = "/") -> bytes:
    entries = [
        ZipEntry(f"{prefix}{path}".replace("/", separator), to_bytes(content))
        for path, content in sorted(files.items())
    ]
    return zip_entries(entries)
