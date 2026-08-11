import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from tests.zip_builder import ZipEntry, build_zip, zip_entries

API_ROOT = Path(__file__).resolve().parent.parent
BUNDLES_ROOT = API_ROOT / "tests" / "fixtures" / "bundles"
GRACIE_ROOT = API_ROOT / "tests" / "fixtures" / "bundle_examples" / "gracie"
OUT_DIR = BUNDLES_ROOT / "out"
DEFAULT_TARGET_TOKEN = "tgt_" + "a" * 22
MANIFEST = "manifest.yaml"
TOKEN_LINE = re.compile(r"^target_token:.*$", re.MULTILINE)
BOMB_BYTES = 9 * 1024 * 1024
ZIP_CONTENT_TYPE = "application/zip"
MANIFEST_CONTENT_TYPE = "application/x-yaml"

Files = dict[str, bytes]

LEAKED_GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
LEAKED_DB_PASSWORD = "s3cr3t-" + "Passw0rd"


@dataclass(frozen=True)
class BundleFixture:
    name: str
    file_name: str
    content_type: str
    endpoint: str
    expectation: str


def read_directory(root: Path) -> Files:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def retarget(files: Mapping[str, bytes], token: str) -> Files:
    updated = dict(files)
    manifest = updated[MANIFEST].decode("utf-8")
    updated[MANIFEST] = TOKEN_LINE.sub(f"target_token: {token}", manifest, count=1).encode("utf-8")
    return updated


def mutate_manifest(
    files: Mapping[str, bytes], mutation: Callable[[dict[str, Any]], None]
) -> Files:
    updated = dict(files)
    document = yaml.safe_load(updated[MANIFEST].decode("utf-8"))
    mutation(document)
    updated[MANIFEST] = yaml.safe_dump(document, sort_keys=False, allow_unicode=True).encode(
        "utf-8"
    )
    return updated


def edit(files: Files, path: str, old: str, new: str) -> Files:
    updated = dict(files)
    text = updated[path].decode("utf-8")
    assert old in text, f"{old!r} not found in {path}"
    updated[path] = text.replace(old, new, 1).encode("utf-8")
    return updated


def without(files: Files, path: str) -> Files:
    return {name: content for name, content in files.items() if name != path}


def minimal_valid(token: str) -> Files:
    return retarget(read_directory(BUNDLES_ROOT / "minimal_valid"), token)


def gracie_like(token: str) -> Files:
    return retarget(read_directory(GRACIE_ROOT), token)


def add_rooms_feature_and_edit_description(document: dict[str, Any]) -> None:
    features: list[dict[str, Any]] = document["features"]
    features[0]["description"] = "List maintenance issues that are still open, per room or floor"
    features.append(
        {
            "id": "rooms.read.list",
            "area": "Rooms",
            "kind": "read",
            "description": "List the rooms of the property with their status",
            "interfaces": ["chat_sse", "browser"],
            "roles": ["all"],
            "examples": [{"ask": "Which rooms are dirty?", "expected": "the dirty rooms"}],
            "confidence": "medium",
        }
    )


def gracie_like_changed(token: str) -> Files:
    return mutate_manifest(gracie_like(token), add_rooms_feature_and_edit_description)


def missing_sections(token: str) -> Files:
    return retarget(read_directory(BUNDLES_ROOT / "missing_sections"), token)


def secret_bearing(token: str) -> Files:
    files = gracie_like(token)
    template = files["env.template"].decode("utf-8")
    files["env.template"] = template.replace(
        "ADMIN_TOKEN=<admin-api-token>", f"ADMIN_TOKEN={LEAKED_GITHUB_TOKEN}"
    ).encode("utf-8")
    script = files["seeds/hash.sh"].decode("utf-8")
    files["seeds/hash.sh"] = (
        script + f"psql postgres://qa:{LEAKED_DB_PASSWORD}@db.internal/gracie -At -c 'select 1'\n"
    ).encode("utf-8")
    return files


def zip_slip_zip(token: str) -> bytes:
    manifest = minimal_valid(token)[MANIFEST]
    return zip_entries(
        [
            ZipEntry("tessa/manifest.yaml", manifest),
            ZipEntry("tessa/../../evil.txt", b"written outside the bundle\n"),
        ]
    )


def zip_bomb_zip(token: str) -> bytes:
    files = minimal_valid(token)
    files["padding.txt"] = b"0" * BOMB_BYTES
    return build_zip(files, prefix="tessa/")


def minimal_valid_zip(token: str) -> bytes:
    return build_zip(minimal_valid(token))


def gracie_like_zip(token: str) -> bytes:
    return build_zip(gracie_like(token), prefix="tessa/")


def gracie_like_changed_zip(token: str) -> bytes:
    return build_zip(gracie_like_changed(token), prefix="tessa/")


def missing_sections_zip(token: str) -> bytes:
    return build_zip(missing_sections(token))


def secret_bearing_zip(token: str) -> bytes:
    return build_zip(secret_bearing(token), prefix="tessa/")


def backslash_paths_zip(token: str) -> bytes:
    return build_zip(gracie_like(token), prefix="tessa/", separator="\\")


def paste_only_manifest(token: str) -> bytes:
    return gracie_like(token)[MANIFEST]


FIXTURES: dict[str, BundleFixture] = {
    fixture.name: fixture
    for fixture in (
        BundleFixture(
            "minimal_valid",
            "minimal_valid.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "201, valid, one feature, completeness 70 (below the bar of 80)",
        ),
        BundleFixture(
            "gracie_like",
            "gracie_like.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "201, valid, four features in four areas, completeness 100, environment reconciled",
        ),
        BundleFixture(
            "gracie_like_changed",
            "gracie_like_changed.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "201 after gracie_like: diff has one feature added (rooms.read.list) and one changed",
        ),
        BundleFixture(
            "missing_sections",
            "missing_sections.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "201, invalid (interfaces, roles, features, environment missing), no catalog",
        ),
        BundleFixture(
            "secret_bearing",
            "secret_bearing.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "422 bundle_contains_secret (a GitHub token in env.template, a DSN password in "
            "seeds/hash.sh); nothing stored",
        ),
        BundleFixture(
            "zip_slip",
            "zip_slip.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "422 validation_failed, detail code unsafe_path (entry climbs out with ..)",
        ),
        BundleFixture(
            "backslash_paths",
            "backslash_paths.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "Same content as gracie_like with tessa\\ backslash entry names (Windows "
            "PowerShell Compress-Archive): 201 valid, or 200 created=false after gracie_like",
        ),
        BundleFixture(
            "zip_bomb",
            "zip_bomb.zip",
            ZIP_CONTENT_TYPE,
            "POST /api/v1/bundles",
            "413 payload_too_large (a 9 MiB file of zeros, ratio above 100 to 1)",
        ),
        BundleFixture(
            "paste_only",
            "paste_only.manifest.yaml",
            MANIFEST_CONTENT_TYPE,
            "POST /api/v1/bundles/paste (manifest_yaml)",
            "201, valid, source manifest_paste, completeness 55 (below the bar)",
        ),
    )
}

BUILDERS: dict[str, Callable[[str], bytes]] = {
    "minimal_valid": minimal_valid_zip,
    "gracie_like": gracie_like_zip,
    "gracie_like_changed": gracie_like_changed_zip,
    "missing_sections": missing_sections_zip,
    "secret_bearing": secret_bearing_zip,
    "zip_slip": zip_slip_zip,
    "backslash_paths": backslash_paths_zip,
    "zip_bomb": zip_bomb_zip,
    "paste_only": paste_only_manifest,
}


def build_fixture(name: str, token: str = DEFAULT_TARGET_TOKEN) -> bytes:
    return BUILDERS[name](token)
