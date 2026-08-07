import hashlib
import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from tessa_api.schemas.bundles import BundleDiffFeature, BundleDiffSection, BundleDiffSummary
from tessa_api.schemas.enums import BundleChange
from tessa_api.schemas.proposals import PROPOSAL_FILE

IDENTITY_SECTIONS = frozenset({"schema", "target_token", "source"})
MANIFEST_FILE = "manifest.yaml"
UNDIFFED_FILES = frozenset({MANIFEST_FILE, PROPOSAL_FILE})
FILES_SECTION_PREFIX = "files:"
SET_FIELDS = ("interface_ids", "roles", "preconditions", "invariants")
TEXT_DEFAULTS = {"flag": "none", "cleanup": "none", "confidence": "medium"}
PLAIN_FIELDS = ("area", "kind", "description", "writes_to", "confirmation", "expect_db")
CATALOG_FIELDS = tuple(
    sorted(
        {
            *SET_FIELDS,
            *TEXT_DEFAULTS,
            *PLAIN_FIELDS,
            "examples",
        }
    )
)
NO_BASE_SUMMARY = "There is no earlier valid version to compare with."


@dataclass(frozen=True)
class BundleSnapshot:
    manifest: Mapping[str, Any] | None
    files: Sequence[Mapping[str, Any]] = field(default_factory=tuple)


@dataclass(frozen=True)
class DiffResult:
    features: list[BundleDiffFeature]
    sections: list[BundleDiffSection]
    summary: str
    features_added: int
    features_removed: int
    features_changed: int

    def to_summary(
        self, against_bundle_id: uuid.UUID | None = None, against_version: int | None = None
    ) -> BundleDiffSummary:
        return BundleDiffSummary(
            against_bundle_id=against_bundle_id,
            against_version=against_version,
            features_added=self.features_added,
            features_removed=self.features_removed,
            features_changed=self.features_changed,
        )


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def string_set(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item) for item in value})


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def normalise_feature(raw: Mapping[str, Any]) -> dict[str, Any]:
    normalised: dict[str, Any] = {
        "area": raw.get("area"),
        "kind": raw.get("kind"),
        "description": raw.get("description"),
        "interface_ids": string_set(raw.get("interfaces")),
        "roles": string_set(raw.get("roles")),
        "preconditions": string_list(raw.get("preconditions")),
        "invariants": string_set(raw.get("invariants")),
        "examples": raw.get("examples") if isinstance(raw.get("examples"), list) else [],
        "writes_to": raw.get("writes_to"),
        "confirmation": raw.get("confirmation"),
        "expect_db": raw.get("expect_db"),
    }
    for name, default in TEXT_DEFAULTS.items():
        value = raw.get(name)
        normalised[name] = value if value not in (None, "") else default
    canonical: dict[str, Any] = json.loads(canonical_json(normalised))
    return canonical


def feature_map(manifest: Mapping[str, Any] | None) -> dict[str, dict[str, Any]]:
    if manifest is None:
        return {}
    features: dict[str, dict[str, Any]] = {}
    items = manifest.get("features")
    for item in items if isinstance(items, list) else []:
        if isinstance(item, Mapping) and isinstance(item.get("id"), str):
            features.setdefault(item["id"], normalise_feature(item))
    return features


def section_hashes(snapshot: BundleSnapshot) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for name, value in (snapshot.manifest or {}).items():
        if name not in IDENTITY_SECTIONS:
            hashes[str(name)] = canonical_hash(value)
    groups: dict[str, list[tuple[str, str]]] = {}
    for entry in snapshot.files:
        path = str(entry.get("path"))
        if path in UNDIFFED_FILES:
            continue
        group = path.split("/", 1)[0]
        groups.setdefault(group, []).append((path, str(entry.get("sha256"))))
    for group, pairs in groups.items():
        hashes[f"{FILES_SECTION_PREFIX}{group}"] = canonical_hash(sorted(pairs))
    return hashes


def diff_features(
    current: Mapping[str, dict[str, Any]], base: Mapping[str, dict[str, Any]]
) -> list[BundleDiffFeature]:
    changes: list[BundleDiffFeature] = []
    for feature_id in sorted(set(current) | set(base)):
        after = current.get(feature_id)
        before = base.get(feature_id)
        if before is None:
            changes.append(
                BundleDiffFeature(
                    feature_id=feature_id,
                    change=BundleChange.added,
                    fields_changed=[],
                    before=None,
                    after=after,
                )
            )
        elif after is None:
            changes.append(
                BundleDiffFeature(
                    feature_id=feature_id,
                    change=BundleChange.removed,
                    fields_changed=[],
                    before=before,
                    after=None,
                )
            )
        else:
            fields = [name for name in CATALOG_FIELDS if before.get(name) != after.get(name)]
            if fields:
                changes.append(
                    BundleDiffFeature(
                        feature_id=feature_id,
                        change=BundleChange.changed,
                        fields_changed=fields,
                        before=before,
                        after=after,
                    )
                )
    return changes


def diff_sections(current: Mapping[str, str], base: Mapping[str, str]) -> list[BundleDiffSection]:
    sections: list[BundleDiffSection] = []
    for name in sorted(set(current) | set(base)):
        if name not in base:
            sections.append(BundleDiffSection(section=name, change=BundleChange.added))
        elif name not in current:
            sections.append(BundleDiffSection(section=name, change=BundleChange.removed))
        elif current[name] != base[name]:
            sections.append(BundleDiffSection(section=name, change=BundleChange.changed))
    return sections


def plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def describe_diff(
    features: Sequence[BundleDiffFeature],
    sections: Sequence[BundleDiffSection],
    against_version: int | None,
) -> str:
    base_label = f"version {against_version}" if against_version is not None else "the base"
    if not features and not sections:
        return f"No differences from {base_label}."
    counts = dict.fromkeys(BundleChange, 0)
    for feature in features:
        counts[feature.change] += 1
    parts = [
        f"{plural(counts[BundleChange.added], 'feature')} added",
        f"{plural(counts[BundleChange.removed], 'feature')} removed",
        f"{plural(counts[BundleChange.changed], 'feature')} changed",
    ]
    text = f"Compared with {base_label}: {', '.join(parts)}."
    if sections:
        listing = ", ".join(f"{section.section} {section.change.value}" for section in sections)
        text += f" Sections: {listing}."
    return text


def diff_bundles(
    current: BundleSnapshot, base: BundleSnapshot | None, against_version: int | None = None
) -> DiffResult:
    if base is None:
        return DiffResult([], [], NO_BASE_SUMMARY, 0, 0, 0)
    features = diff_features(feature_map(current.manifest), feature_map(base.manifest))
    sections = diff_sections(section_hashes(current), section_hashes(base))
    return DiffResult(
        features=features,
        sections=sections,
        summary=describe_diff(features, sections, against_version),
        features_added=sum(1 for item in features if item.change is BundleChange.added),
        features_removed=sum(1 for item in features if item.change is BundleChange.removed),
        features_changed=sum(1 for item in features if item.change is BundleChange.changed),
    )
