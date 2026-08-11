import uuid

from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import Confidence, FeatureKind
from tessa_api.services.bundle_intake import (
    bundle_hash,
    declared_variables,
    normalise_pasted_text,
)
from tessa_api.services.bundle_views import hooks_missing
from tessa_api.services.catalog_builder import catalog_rows, escape_like
from tessa_api.services.env_template import parse_env_template
from tests.bundle_examples import example_manifest, example_text


def test_hash_ignores_file_order_but_not_paths_or_content() -> None:
    first = {"a.txt": b"1", "b/c.txt": b"2"}
    assert bundle_hash(first) == bundle_hash({"b/c.txt": b"2", "a.txt": b"1"})
    assert bundle_hash(first) != bundle_hash({"a.txt": b"1", "b/d.txt": b"2"})
    assert bundle_hash(first) != bundle_hash({"a.txt": b"1", "b/c.txt": b"3"})
    assert bundle_hash(first) != bundle_hash({"a.txt": b"1"})
    assert bundle_hash({}) == bundle_hash({})
    assert len(bundle_hash(first)) == 64


def test_hash_cannot_confuse_a_path_boundary_with_content() -> None:
    assert bundle_hash({"ab": b"c"}) != bundle_hash({"a": b"bc"})


def test_pasted_text_is_normalised_to_lf_without_a_bom() -> None:
    assert normalise_pasted_text("﻿a: 1\r\nb: 2\rc: 3\n") == b"a: 1\nb: 2\nc: 3\n"


def test_declared_variables_merge_the_manifest_and_the_template() -> None:
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    template = parse_env_template(
        example_text("gracie", "env.template") + "\nEXTRA_ONE=x  # extra\n"
    )
    declared = {variable.name: variable for variable in declared_variables(manifest, template)}
    assert len(declared) == 9
    dsn = declared["TRUTH_DB_DSN"]
    assert (dsn.kind, dsn.secret, dsn.required) == ("dsn", True, True)
    assert declared["GRACIE_BASE_URL"].interfaces == ("chat_sse", "browser", "admin_api")
    assert declared["SEED_DB_DSN"].required is False
    extra = declared["EXTRA_ONE"]
    assert extra.kind is None
    assert extra.required is False
    assert extra.purpose == "extra"


def test_declared_variables_without_a_template_use_the_manifest_only() -> None:
    manifest = BundleManifest.model_validate(example_manifest("gracie"))
    declared = declared_variables(manifest, None)
    assert len(declared) == len(manifest.environment)


def test_declared_purpose_falls_back_to_the_template() -> None:
    manifest_data = example_manifest("minimal")
    manifest_data["environment"][0]["purpose"] = ""
    manifest = BundleManifest.model_validate(manifest_data)
    template = parse_env_template("# From the template\nNOTES_BASE_URL=http://localhost:8080\n")
    assert declared_variables(manifest, template)[0].purpose == "From the template"


def test_catalog_rows_follow_the_manifest_and_skip_duplicates() -> None:
    manifest = BundleManifest.model_validate(example_manifest("gracie")).model_dump(
        mode="json", by_alias=True
    )
    manifest["features"].append(dict(manifest["features"][0]))
    bundle_id = uuid.uuid4()
    rows = catalog_rows(bundle_id, manifest)
    assert [row.feature_id for row in rows] == [
        "smart_log.read.open_maintenance",
        "smart_log.write.create_issue",
        "auth.login.staff",
        "admin.users.list",
    ]
    first = rows[0]
    assert first.bundle_id == bundle_id
    assert first.kind is FeatureKind.read
    assert first.confidence is Confidence.high
    assert first.interface_ids == ["chat_sse", "browser"]
    assert first.raw["id"] == "smart_log.read.open_maintenance"
    assert rows[1].raw["writes_to"] == "smart_log_issue"


def test_catalog_rows_of_a_manifest_without_features_are_empty() -> None:
    assert catalog_rows(uuid.uuid4(), {}) == []
    assert catalog_rows(uuid.uuid4(), {"features": "nope"}) == []


def test_like_pattern_characters_are_escaped() -> None:
    assert escape_like("50%_off\\") == "50\\%\\_off\\\\"


def test_hooks_missing_reads_the_manifest_tolerantly() -> None:
    assert hooks_missing(None) == []
    assert hooks_missing({}) == []
    assert hooks_missing({"test_hooks": {"missing": "nope"}}) == []
    hooks = hooks_missing(
        {"test_hooks": {"missing": [{"id": "pin_clock", "description": "Pin"}, {"nope": 1}, 5]}}
    )
    assert [(hook.id, hook.description) for hook in hooks] == [("pin_clock", "Pin")]
