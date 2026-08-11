import copy
import random
from typing import Any

import pytest

from tessa_api.schemas.enums import BundleChange
from tessa_api.services.bundle_differ import (
    NO_BASE_SUMMARY,
    BundleSnapshot,
    canonical_hash,
    diff_bundles,
    normalise_feature,
)
from tests.bundle_examples import example_manifest

KINDS = ["read", "write", "flow", "auth", "admin", "stream", "job"]
CONFIDENCES = ["low", "medium", "high"]
ALPHABET = ["alpha", "beta", "gamma", "delta", "epsilon"]


def snapshot(
    manifest: dict[str, Any] | None, files: list[dict[str, Any]] | None = None
) -> BundleSnapshot:
    return BundleSnapshot(manifest=manifest, files=files or [])


def random_feature(generator: random.Random, identifier: str) -> dict[str, Any]:
    return {
        "id": identifier,
        "area": generator.choice(ALPHABET),
        "kind": generator.choice(KINDS),
        "description": " ".join(generator.sample(ALPHABET, 3)),
        "interfaces": generator.sample(ALPHABET, generator.randint(0, 3)),
        "roles": generator.sample(ALPHABET, generator.randint(0, 3)),
        "flag": generator.choice(["none", "beta"]),
        "preconditions": generator.sample(ALPHABET, generator.randint(0, 2)),
        "examples": [
            {"ask": generator.choice(ALPHABET), "expected": generator.choice(ALPHABET)}
            for _ in range(generator.randint(0, 2))
        ],
        "invariants": generator.sample(ALPHABET, generator.randint(0, 2)),
        "cleanup": generator.choice(["none", "delete the row"]),
        "confidence": generator.choice(CONFIDENCES),
    }


def random_manifest(generator: random.Random) -> dict[str, Any]:
    identifiers = generator.sample([f"f{index}" for index in range(12)], generator.randint(0, 10))
    return {
        "schema": "http://x/schemas/bundle.v1.json",
        "target_token": "tgt_x",
        "features": [random_feature(generator, identifier) for identifier in identifiers],
        "roles": [{"id": "a", "level": generator.randint(0, 3)}],
        "environment": [{"name": generator.choice(["A", "B"])}],
    }


def mutate(generator: random.Random, manifest: dict[str, Any]) -> dict[str, Any]:
    changed = copy.deepcopy(manifest)
    features: list[dict[str, Any]] = changed["features"]
    for feature in list(features):
        roll = generator.random()
        if roll < 0.2:
            features.remove(feature)
        elif roll < 0.5:
            feature["description"] = feature["description"] + " edited"
    if generator.random() < 0.5:
        features.append(random_feature(generator, f"new{generator.randint(0, 5)}"))
    return changed


def feature_changes(manifest_a: dict[str, Any], manifest_b: dict[str, Any]) -> dict[str, Any]:
    result = diff_bundles(snapshot(manifest_b), snapshot(manifest_a))
    return {
        change: sorted(item.feature_id for item in result.features if item.change is change)
        for change in BundleChange
    }


@pytest.mark.parametrize("seed", range(40))
def test_self_diff_is_empty(seed: int) -> None:
    manifest = random_manifest(random.Random(seed))
    result = diff_bundles(snapshot(manifest), snapshot(copy.deepcopy(manifest)), 1)
    assert result.features == []
    assert result.sections == []
    assert (result.features_added, result.features_removed, result.features_changed) == (0, 0, 0)
    assert result.summary == "No differences from version 1."


@pytest.mark.parametrize("seed", range(60))
def test_added_and_removed_are_symmetric(seed: int) -> None:
    generator = random.Random(1000 + seed)
    manifest_a = random_manifest(generator)
    manifest_b = mutate(generator, manifest_a)
    forward = feature_changes(manifest_a, manifest_b)
    backward = feature_changes(manifest_b, manifest_a)
    assert forward[BundleChange.added] == backward[BundleChange.removed]
    assert forward[BundleChange.removed] == backward[BundleChange.added]
    assert forward[BundleChange.changed] == backward[BundleChange.changed]


@pytest.mark.parametrize("seed", range(30))
def test_changed_fields_swap_before_and_after_when_reversed(seed: int) -> None:
    generator = random.Random(5000 + seed)
    manifest_a = random_manifest(generator)
    manifest_b = mutate(generator, manifest_a)
    forward = {
        item.feature_id: item
        for item in diff_bundles(snapshot(manifest_b), snapshot(manifest_a)).features
        if item.change is BundleChange.changed
    }
    backward = {
        item.feature_id: item
        for item in diff_bundles(snapshot(manifest_a), snapshot(manifest_b)).features
        if item.change is BundleChange.changed
    }
    assert forward.keys() == backward.keys()
    for identifier, item in forward.items():
        assert item.fields_changed == backward[identifier].fields_changed
        assert item.before == backward[identifier].after
        assert item.after == backward[identifier].before


def test_counts_match_the_listed_changes() -> None:
    generator = random.Random(7)
    manifest_a = random_manifest(generator)
    manifest_b = mutate(generator, manifest_a)
    result = diff_bundles(snapshot(manifest_b), snapshot(manifest_a))
    assert result.features_added == sum(
        1 for i in result.features if i.change is BundleChange.added
    )
    assert result.features_removed == sum(
        1 for i in result.features if i.change is BundleChange.removed
    )
    assert result.features_changed == sum(
        1 for i in result.features if i.change is BundleChange.changed
    )
    summary = result.to_summary(None, 3)
    assert summary.features_added == result.features_added
    assert summary.against_version == 3


def test_added_removed_and_changed_features_carry_before_and_after() -> None:
    base = example_manifest("gracie")
    current = copy.deepcopy(base)
    current["features"][0]["description"] = "A different description"
    current["features"][0]["roles"] = ["staff"]
    removed = current["features"].pop(1)
    current["features"].append(
        {"id": "rooms.read.list", "area": "Rooms", "kind": "read", "description": "Rooms"}
    )
    result = diff_bundles(snapshot(current), snapshot(base), 4)
    by_id = {item.feature_id: item for item in result.features}
    changed = by_id["smart_log.read.open_maintenance"]
    assert changed.change is BundleChange.changed
    assert changed.fields_changed == ["description", "roles"]
    assert changed.before is not None
    assert changed.after is not None
    assert changed.before["description"] != changed.after["description"]
    assert by_id[removed["id"]].change is BundleChange.removed
    assert by_id[removed["id"]].before is not None
    assert by_id[removed["id"]].after is None
    added = by_id["rooms.read.list"]
    assert added.change is BundleChange.added
    assert added.before is None
    assert added.after is not None
    assert added.after["flag"] == "none"
    assert result.features_added == 1
    assert result.features_removed == 1
    assert result.features_changed == 1
    assert [item.feature_id for item in result.features] == sorted(by_id)
    assert result.summary.startswith(
        "Compared with version 4: 1 feature added, 1 feature removed, 1 feature changed."
    )


def test_set_like_fields_ignore_order_and_defaults_are_filled() -> None:
    base = example_manifest("gracie")
    current = copy.deepcopy(base)
    current["features"][0]["interfaces"] = list(reversed(current["features"][0]["interfaces"]))
    current["features"][0]["flag"] = "none"
    current["features"][0].pop("cleanup", None)
    assert diff_bundles(snapshot(current), snapshot(base)).features == []


def test_sections_are_compared_by_canonical_hash() -> None:
    base = example_manifest("gracie")
    current = copy.deepcopy(base)
    current["environment"].append({"name": "NEW_ONE", "kind": "string"})
    current.pop("flags")
    current["limitations"] = ["new limitation"]
    current["target_token"] = "tgt_other"
    result = diff_bundles(snapshot(current), snapshot(base))
    sections = {item.section: item.change for item in result.sections}
    assert sections == {
        "environment": BundleChange.changed,
        "flags": BundleChange.removed,
        "limitations": BundleChange.changed,
    }
    assert "target_token" not in sections


def test_key_order_does_not_change_a_section_hash() -> None:
    assert canonical_hash({"a": 1, "b": [1, 2]}) == canonical_hash({"b": [1, 2], "a": 1})
    assert canonical_hash({"a": 1}) != canonical_hash({"a": 2})


def test_file_groups_are_diffed_as_sections() -> None:
    manifest = example_manifest("minimal")
    base_files = [
        {"path": "manifest.yaml", "sha256": "m1"},
        {"path": "oracle/a.sql", "sha256": "1"},
        {"path": "oracle/a.yaml", "sha256": "2"},
        {"path": "env.template", "sha256": "3"},
    ]
    current_files = [
        {"path": "manifest.yaml", "sha256": "m2"},
        {"path": "oracle/a.sql", "sha256": "changed"},
        {"path": "oracle/a.yaml", "sha256": "2"},
        {"path": "flows/x.yaml", "sha256": "4"},
    ]
    result = diff_bundles(snapshot(manifest, current_files), snapshot(manifest, base_files))
    sections = {item.section: item.change for item in result.sections}
    assert sections == {
        "files:oracle": BundleChange.changed,
        "files:flows": BundleChange.added,
        "files:env.template": BundleChange.removed,
    }


def test_no_base_gives_an_empty_diff_with_a_message() -> None:
    result = diff_bundles(snapshot(example_manifest("gracie")), None)
    assert result.features == []
    assert result.sections == []
    assert result.summary == NO_BASE_SUMMARY


def test_unreadable_manifests_are_tolerated() -> None:
    base = example_manifest("gracie")
    garbage = {"features": ["nope", {"no_id": True}, 5, {"id": 7}]}
    result = diff_bundles(snapshot(garbage), snapshot(base))
    assert result.features_removed == len(base["features"])
    assert diff_bundles(snapshot(None), snapshot(base)).features_removed == len(base["features"])
    assert diff_bundles(snapshot(base), snapshot(None)).features_added == len(base["features"])


def test_normalised_feature_has_the_catalog_fields() -> None:
    normalised = normalise_feature({"id": "x", "area": "A", "kind": "read", "description": "d"})
    assert normalised["flag"] == "none"
    assert normalised["cleanup"] == "none"
    assert normalised["confidence"] == "medium"
    assert normalised["interface_ids"] == []
    assert normalised["examples"] == []
    assert "id" not in normalised
