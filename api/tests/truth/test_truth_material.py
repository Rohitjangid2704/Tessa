import re

import pytest
import yaml

from tessa_api.db.models import SeedRow
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import OracleLanguage, SeedHashSource
from tessa_api.services.truth_import import (
    SeedMaterial,
    material_digest,
    oracle_materials,
    seed_changed,
    seed_material,
)
from tests.bundle_fixtures import Files, gracie_like, minimal_valid
from tests.truth.support import (
    EXPECTED_HASH,
    gracie_files,
    with_expected_hash,
    with_python_oracle,
    with_reset_script_edit,
)

TOKEN = "tgt_" + "a" * 22
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def manifest_of(files: Files) -> BundleManifest:
    return BundleManifest.model_validate(yaml.safe_load(files["manifest.yaml"].decode("utf-8")))


def stored(material: SeedMaterial, source: SeedHashSource = SeedHashSource.first_reset) -> SeedRow:
    return SeedRow(
        version=1,
        declared_hash=material.declared_hash,
        hash_source=source,
        reset_script_path=material.reset_script_path,
        hash_command=material.hash_command,
        material_sha256=material.material_sha256,
    )


def material_of(files: Files) -> SeedMaterial:
    material = seed_material(manifest_of(files), files)
    assert material is not None
    return material


def test_the_digest_is_a_sha256_that_depends_on_every_part_of_the_seed() -> None:
    base = material_digest("seeds/reset.sql", b"DELETE FROM a", "bash seeds/hash.sh", "DSN", {})
    assert SHA256.match(base)
    assert base == material_digest(
        "seeds/reset.sql", b"DELETE FROM a", "bash seeds/hash.sh", "DSN", {}
    )
    variants = [
        material_digest("seeds/other.sql", b"DELETE FROM a", "bash seeds/hash.sh", "DSN", {}),
        material_digest("seeds/reset.sql", b"DELETE FROM b", "bash seeds/hash.sh", "DSN", {}),
        material_digest("seeds/reset.sql", b"DELETE FROM a", "bash seeds/hash2.sh", "DSN", {}),
        material_digest("seeds/reset.sql", b"DELETE FROM a", "bash seeds/hash.sh", "OTHER", {}),
        material_digest(
            "seeds/reset.sql", b"DELETE FROM a", "bash seeds/hash.sh", "DSN", {"seeds/x.sql": b"1"}
        ),
    ]
    assert len({base, *variants}) == len(variants) + 1


def test_parts_cannot_be_shifted_into_each_other() -> None:
    first = material_digest("a", b"bc", None, None, {})
    second = material_digest("ab", b"c", None, None, {})
    assert first != second


def test_the_seed_material_of_the_gracie_bundle() -> None:
    material = material_of(gracie_like(TOKEN))
    assert material.reset_script_path == "seeds/reset.sql"
    assert material.hash_command == "bash seeds/hash.sh"
    assert material.declared_hash is None
    assert SHA256.match(material.material_sha256)


def test_a_bundle_without_a_seeds_section_has_no_seed_material() -> None:
    files = minimal_valid(TOKEN)
    assert seed_material(manifest_of(files), files) is None


def test_an_unchanged_seed_is_not_a_change_whatever_the_first_reset_pinned() -> None:
    material = material_of(gracie_like(TOKEN))
    pinned = stored(material)
    pinned.declared_hash = "pinned0123456789"
    assert seed_changed(pinned, material) is False


def test_changed_material_or_a_changed_declaration_is_a_change() -> None:
    original = material_of(gracie_like(TOKEN))
    edited = material_of(gracie_files(TOKEN, with_reset_script_edit))
    declared = material_of(gracie_files(TOKEN, with_expected_hash()))
    assert seed_changed(stored(original), edited) is True
    assert seed_changed(stored(original), declared) is True
    assert seed_changed(stored(declared, SeedHashSource.bundle), declared) is False
    assert seed_changed(stored(declared, SeedHashSource.bundle), original) is True
    assert declared.declared_hash == EXPECTED_HASH


@pytest.mark.parametrize(
    ("language", "read_only"), [(OracleLanguage.sql, True), (OracleLanguage.python, False)]
)
def test_only_a_sql_oracle_can_be_proven_read_only(
    language: OracleLanguage, read_only: bool
) -> None:
    files = gracie_files(TOKEN, with_python_oracle)
    materials = {item.name: item for item in oracle_materials(manifest_of(files), files)}
    chosen = next(item for item in materials.values() if item.language is language)
    assert chosen.read_only_verified is read_only


def test_a_sidecar_that_does_not_parse_is_left_out() -> None:
    files = gracie_like(TOKEN)
    files["oracle/broken.yaml"] = b"name: [unclosed"
    files["oracle/broken.sql"] = b"SELECT 1"
    names = [item.name for item in oracle_materials(manifest_of(files), files)]
    assert names == ["open_maintenance"]


def test_a_sidecar_whose_name_differs_from_its_file_is_left_out() -> None:
    files = gracie_like(TOKEN)
    files["oracle/other.yaml"] = files["oracle/open_maintenance.yaml"]
    files["oracle/other.sql"] = files["oracle/open_maintenance.sql"]
    names = [item.name for item in oracle_materials(manifest_of(files), files)]
    assert names == ["open_maintenance"]


def test_an_unproven_oracle_without_a_database_truth_source_is_not_read_only() -> None:
    files = gracie_like(TOKEN)
    manifest = manifest_of(files)
    manifest.truth_sources.clear()
    names = {item.name: item for item in oracle_materials(manifest, files)}
    assert names["open_maintenance"].read_only_verified is False
    assert names["open_maintenance"].truth_source == "primary_db"
