import argparse
import io
import re
import zipfile
from pathlib import Path

BUNDLE_ROOT = Path(__file__).resolve().parent / "tessa"
DEFAULT_TARGET_TOKEN = "tgt_fakefakefakefakefakefa"
ARCHIVE_PREFIX = "tessa/"
FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
REGULAR_FILE_ATTRIBUTE = 0o100644 << 16
TOKEN_LINE = re.compile(r"^target_token:.*$", re.MULTILINE)
TOKEN_PATTERN = re.compile(r"^tgt_[a-z2-7]{22}$")
MANIFEST = "manifest.yaml"

BundleFiles = dict[str, bytes]


def read_bundle_files() -> BundleFiles:
    return {
        path.relative_to(BUNDLE_ROOT).as_posix(): path.read_bytes()
        for path in sorted(BUNDLE_ROOT.rglob("*"))
        if path.is_file()
    }


def retarget(files: BundleFiles, token: str) -> BundleFiles:
    if TOKEN_PATTERN.match(token) is None:
        raise ValueError("a target token is tgt_ followed by 22 characters of a-z and 2-7")
    updated = dict(files)
    manifest = updated[MANIFEST].decode("utf-8")
    updated[MANIFEST] = TOKEN_LINE.sub(f"target_token: {token}", manifest, count=1).encode("utf-8")
    return updated


def zip_files(files: BundleFiles, prefix: str = ARCHIVE_PREFIX) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in sorted(files.items()):
            info = zipfile.ZipInfo(f"{prefix}{path}", date_time=FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = REGULAR_FILE_ATTRIBUTE
            archive.writestr(info, content, compresslevel=9)
    return buffer.getvalue()


def build_bundle_zip(
    target_token: str = DEFAULT_TARGET_TOKEN, prefix: str = ARCHIVE_PREFIX
) -> bytes:
    return zip_files(retarget(read_bundle_files(), target_token), prefix)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the fake target bundle zip")
    parser.add_argument("--token", default=DEFAULT_TARGET_TOKEN)
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    arguments.out.write_bytes(build_bundle_zip(arguments.token))


if __name__ == "__main__":
    main()
