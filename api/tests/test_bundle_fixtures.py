import io
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

from tessa_api.services.bundle_archive import ArchiveLimits, extract_archive
from tests.bundle_examples import example_manifest
from tests.bundle_fixtures import (
    BUILDERS,
    DEFAULT_TARGET_TOKEN,
    FIXTURES,
    OUT_DIR,
    build_fixture,
    gracie_like,
    gracie_like_changed,
    minimal_valid,
    missing_sections,
    read_directory,
)
from tests.support import API_ROOT
from tests.test_bundle_schema import published_schema
from tests.zip_builder import build_zip

VALID_MANIFEST_FIXTURES = {
    "minimal_valid": minimal_valid,
    "gracie_like": gracie_like,
    "gracie_like_changed": gracie_like_changed,
}


def test_fixture_registry_and_builders_agree() -> None:
    assert set(FIXTURES) == set(BUILDERS)
    assert len({fixture.file_name for fixture in FIXTURES.values()}) == len(FIXTURES)
    assert {fixture.name for fixture in FIXTURES.values()} == {
        "minimal_valid",
        "gracie_like",
        "gracie_like_changed",
        "missing_sections",
        "secret_bearing",
        "zip_slip",
        "backslash_paths",
        "zip_bomb",
        "paste_only",
    }


@pytest.mark.parametrize("name", sorted(BUILDERS))
def test_fixtures_are_built_deterministically(name: str) -> None:
    assert build_fixture(name) == build_fixture(name)
    assert build_fixture(name, "tgt_" + "b" * 22) != build_fixture(name)


def test_zips_are_deterministic_down_to_the_bytes() -> None:
    files = {"manifest.yaml": "a: 1\n", "seeds/reset.sql": "select 1;\n"}
    assert build_zip(files) == build_zip(dict(reversed(files.items())))
    with zipfile.ZipFile(io.BytesIO(build_zip(files))) as archive:
        assert {info.date_time for info in archive.infolist()} == {(2026, 1, 1, 0, 0, 0)}


@pytest.mark.parametrize("name", sorted(VALID_MANIFEST_FIXTURES))
def test_valid_fixture_manifests_validate_against_the_published_json_schema(name: str) -> None:
    files = VALID_MANIFEST_FIXTURES[name](DEFAULT_TARGET_TOKEN)
    manifest = yaml.safe_load(files["manifest.yaml"])
    Draft202012Validator(published_schema()).validate(manifest)


def test_paste_only_manifest_validates_against_the_published_json_schema() -> None:
    manifest = yaml.safe_load(build_fixture("paste_only"))
    Draft202012Validator(published_schema()).validate(manifest)


def test_published_schema_agrees_with_the_example_manifests_too() -> None:
    for example in ("minimal", "gracie"):
        Draft202012Validator(published_schema()).validate(example_manifest(example))


def test_missing_sections_manifest_fails_the_published_json_schema() -> None:
    manifest = yaml.safe_load(missing_sections(DEFAULT_TARGET_TOKEN)["manifest.yaml"])
    errors = list(Draft202012Validator(published_schema()).iter_errors(manifest))
    assert errors
    assert any("interfaces" in error.message for error in errors)


def test_target_token_is_substituted_in_every_fixture() -> None:
    token = "tgt_" + "c" * 22
    assert f"target_token: {token}".encode() in gracie_like(token)["manifest.yaml"]
    assert f"target_token: {token}".encode() in missing_sections(token)["manifest.yaml"]
    assert f"target_token: {token}".encode() in build_fixture("paste_only", token)


def extract(name: str) -> dict[str, bytes]:
    limits = ArchiveLimits(25 * 1024 * 1024, 100 * 1024 * 1024, 2000, 10 * 1024 * 1024)
    return extract_archive(io.BytesIO(build_fixture(name)), limits).files


def test_prefixed_and_backslash_gracie_zips_extract_to_the_same_files() -> None:
    assert extract("gracie_like") == extract("backslash_paths")
    gracie_directory = read_directory(API_ROOT / "tests/fixtures/bundle_examples/gracie")
    assert set(extract("gracie_like")) == set(gracie_directory)


def test_gracie_like_changed_differs_from_gracie_like_in_the_manifest_only() -> None:
    original = gracie_like(DEFAULT_TARGET_TOKEN)
    changed = gracie_like_changed(DEFAULT_TARGET_TOKEN)
    differing = {path for path in original if original[path] != changed[path]}
    assert differing == {"manifest.yaml"}


def test_the_build_script_writes_every_fixture(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, "scripts/build_bundle_fixtures.py", "--out-dir", str(tmp_path)],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    written = {path.name for path in tmp_path.iterdir()}
    assert written == {fixture.file_name for fixture in FIXTURES.values()}
    for fixture in FIXTURES.values():
        assert (tmp_path / fixture.file_name).read_bytes() == build_fixture(fixture.name)
        assert fixture.file_name in result.stdout


def test_the_build_script_takes_a_target_token(tmp_path: Path) -> None:
    token = "tgt_" + "d" * 22
    result = subprocess.run(
        [
            sys.executable,
            "scripts/build_bundle_fixtures.py",
            "--out-dir",
            str(tmp_path),
            "--target-token",
            token,
        ],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert token.encode() in (tmp_path / "paste_only.manifest.yaml").read_bytes()


def test_the_build_script_rejects_a_malformed_token(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "scripts/build_bundle_fixtures.py",
            "--out-dir",
            str(tmp_path),
            "--target-token",
            "nope",
        ],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert list(tmp_path.iterdir()) == []


def test_the_out_directory_is_git_ignored() -> None:
    ignore = (API_ROOT.parent / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "api/tests/fixtures/bundles/out/" in ignore
    assert OUT_DIR.name == "out"
