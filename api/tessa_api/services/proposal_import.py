from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from tessa_api.schemas.bundles import BundleValidationError, ProposalCheck
from tessa_api.schemas.enums import Confidence
from tessa_api.schemas.proposals import PROPOSAL_FILE, PROPOSAL_MAX_YAML_BYTES, ProposalDoc
from tessa_api.services.bundle_validator import ParseBudget, Reporter
from tessa_api.services.manifest_loader import PointerMap, load_yaml_document

MAX_BUNDLE_WARNING_ERRORS = 10


@dataclass(slots=True)
class ProposalFileCheck:
    doc: ProposalDoc | None
    errors: list[BundleValidationError]
    warnings: list[BundleValidationError]
    low_confidence_keys: frozenset[str] = frozenset()

    @property
    def usable(self) -> bool:
        return self.doc is not None and not self.errors

    @property
    def item_count(self) -> int:
        return len(self.doc.items) if self.doc is not None else 0

    def as_check(self) -> ProposalCheck:
        return ProposalCheck(items=self.item_count, errors=self.errors, warnings=self.warnings)


@dataclass(frozen=True, slots=True)
class ManifestNames:
    feature_ids: frozenset[str]
    interface_ids: frozenset[str]
    areas: frozenset[str]
    target_token: str | None


@dataclass(slots=True)
class CheckState:
    reporter: Reporter
    pointers: PointerMap
    low_confidence: set[str] = field(default_factory=set)


def mappings_of(value: object) -> list[Mapping[str, Any]]:
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, list) else []


def manifest_names(manifest: Mapping[str, Any] | None) -> ManifestNames | None:
    if manifest is None:
        return None
    features = mappings_of(manifest.get("features"))
    interfaces = mappings_of(manifest.get("interfaces"))
    token = manifest.get("target_token")
    return ManifestNames(
        feature_ids=frozenset(str(item["id"]) for item in features if "id" in item),
        interface_ids=frozenset(str(item["id"]) for item in interfaces if "id" in item),
        areas=frozenset(str(item["area"]) for item in features if "area" in item),
        target_token=token if isinstance(token, str) else None,
    )


def report_schema_errors(error: ValidationError, state: CheckState) -> None:
    for item in error.errors():
        state.reporter.add_at(
            "error",
            str(item["type"]),
            str(item["msg"]),
            PROPOSAL_FILE,
            state.pointers,
            tuple(item["loc"]),
        )


def check_unique_keys(doc: ProposalDoc, state: CheckState) -> None:
    seen: dict[str, int] = {}
    for index, item in enumerate(doc.items):
        if item.key in seen:
            state.reporter.add_at(
                "error",
                "duplicate_proposal_key",
                f"The key {item.key!r} is already used by item {seen[item.key]}",
                PROPOSAL_FILE,
                state.pointers,
                ("items", index, "key"),
            )
        else:
            seen[item.key] = index


def check_target_token(doc: ProposalDoc, tokens: Sequence[str], state: CheckState) -> None:
    if tokens and doc.target_token not in tokens:
        state.reporter.add_at(
            "error",
            "proposal_target_mismatch",
            "The target_token of the proposal belongs to a different target",
            PROPOSAL_FILE,
            state.pointers,
            ("target_token",),
        )


def check_names(doc: ProposalDoc, names: ManifestNames, state: CheckState) -> None:
    for index, item in enumerate(doc.items):
        if item.area not in names.areas:
            state.reporter.add_at(
                "warning",
                "proposal_area_unknown",
                f"The area {item.area!r} is not an area of the bundle catalog",
                PROPOSAL_FILE,
                state.pointers,
                ("items", index, "area"),
            )
        for position, feature_id in enumerate(item.feature_ids):
            if feature_id not in names.feature_ids:
                state.low_confidence.add(item.key)
                state.reporter.add_at(
                    "warning",
                    "proposal_feature_unknown",
                    f"The feature {feature_id!r} is not in the bundle; the item is kept with "
                    "low confidence",
                    PROPOSAL_FILE,
                    state.pointers,
                    ("items", index, "feature_ids", position),
                )
        if item.interface_id is not None and item.interface_id not in names.interface_ids:
            state.reporter.add_at(
                "warning",
                "proposal_interface_unknown",
                f"The interface {item.interface_id!r} is not an interface of the bundle",
                PROPOSAL_FILE,
                state.pointers,
                ("items", index, "interface_id"),
            )


def too_large_check(size: int) -> ProposalFileCheck:
    error = BundleValidationError(
        code="proposal_too_large",
        message=f"{PROPOSAL_FILE} is {size} bytes, the limit is {PROPOSAL_MAX_YAML_BYTES}",
        severity="error",
        file=PROPOSAL_FILE,
        pointer=None,
        line=None,
        column=None,
    )
    return ProposalFileCheck(doc=None, errors=[error], warnings=[])


def check_proposal_text(
    text: str, manifest: Mapping[str, Any] | None, tokens: Sequence[str] = ()
) -> ProposalFileCheck:
    size = len(text.encode("utf-8"))
    if size > PROPOSAL_MAX_YAML_BYTES:
        return too_large_check(size)
    document = load_yaml_document(text, PROPOSAL_FILE)
    reporter = Reporter(ParseBudget(PROPOSAL_MAX_YAML_BYTES, PROPOSAL_MAX_YAML_BYTES))
    reporter.errors.extend(document.errors)
    state = CheckState(reporter=reporter, pointers=document.pointers)
    doc: ProposalDoc | None = None
    if document.data is not None:
        try:
            doc = ProposalDoc.model_validate(document.data)
        except ValidationError as error:
            report_schema_errors(error, state)
    if doc is not None:
        check_unique_keys(doc, state)
        check_target_token(doc, tokens, state)
        names = manifest_names(manifest)
        if names is not None:
            check_names(doc, names, state)
    return ProposalFileCheck(
        doc=doc if not reporter.errors else None,
        errors=reporter.errors,
        warnings=reporter.warnings,
        low_confidence_keys=frozenset(state.low_confidence),
    )


def decode_proposal(content: bytes) -> str:
    return content.decode("utf-8-sig", errors="replace")


def error_as_warning(problem: BundleValidationError) -> BundleValidationError:
    return problem.model_copy(update={"severity": "warning"})


def bundle_warnings(check: ProposalFileCheck) -> list[BundleValidationError]:
    warnings = list(check.warnings)
    if not check.errors:
        return warnings
    first = check.errors[0]
    summary = BundleValidationError(
        code="proposal_not_imported",
        message=f"The proposal was not imported: {len(check.errors)} error(s), first: "
        f"{first.message}",
        severity="warning",
        file=PROPOSAL_FILE,
        pointer=None,
        line=None,
        column=None,
    )
    detailed = [error_as_warning(error) for error in check.errors[:MAX_BUNDLE_WARNING_ERRORS]]
    return [summary, *detailed, *warnings]


def effective_confidence(key: str, declared: Confidence, low: frozenset[str]) -> Confidence:
    return Confidence.low if key in low else declared
