import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict

from tessa_api.schemas.bundle import BundleManifest, Invariant
from tessa_api.schemas.enums import (
    AdapterKind,
    AppKind,
    FeatureKind,
    InvariantPack,
    ProbeAnswerType,
    ProbeInputField,
    ProbeSource,
)
from tessa_api.schemas.probes import (
    Probe,
    ProbeAppliesTo,
    ProbeDefinition,
    ProbeInput,
    ProbeInputFieldSpec,
)
from tessa_api.services.probe_bank import ProbeBank, compliant_answer

BUNDLE_PROBE_CHECK = "probe"
TARGET_PROBE_ID_PREFIX = "target."
TARGET_PROBE_VERSION_LENGTH = 8
TARGET_PROBE_QUESTION = "Does the answer comply with the rule, given what was asked?"
TARGET_PROBE_FIELDS = (
    (ProbeInputField.invariant_rule, 300),
    (ProbeInputField.ask, 300),
    (ProbeInputField.answer, 800),
)
DEFAULT_ON_INVARIANT_IDS = frozenset({"no_internal_ids", "external_facts_labelled"})
NONE_TEXT = "none"
CARD_TITLE_KEYS = ("title", "name", "label", "heading")
PROBE_FIELD_LABELS: Mapping[ProbeInputField, str] = {
    ProbeInputField.ask: "Asked",
    ProbeInputField.answer: "Answer",
    ProbeInputField.tool_names: "Tools used",
    ProbeInputField.card_titles: "Cards shown",
    ProbeInputField.invariant_rule: "Rule",
}


class ProbeSpec(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    pack: InvariantPack
    source: ProbeSource
    question: str
    answer_type: ProbeAnswerType
    choices: list[str]
    applies_to: ProbeAppliesTo
    input: ProbeInput
    threshold: float | None
    invariant_id: str
    version: str

    @property
    def compliant_choice(self) -> str:
        return compliant_answer(self.answer_type, self.choices)

    def effective_threshold(self, global_threshold: float) -> float:
        return global_threshold if self.threshold is None else self.threshold

    def to_probe(self, global_threshold: float) -> Probe:
        return Probe(
            id=self.id,
            pack=self.pack,
            question=self.question,
            answer_type=self.answer_type,
            threshold=self.effective_threshold(global_threshold),
            version=self.version,
            source=self.source,
        )


@dataclass(frozen=True, slots=True)
class StepTexts:
    ask: str | None
    answer: str | None
    tool_names: str
    card_titles: str


@dataclass(frozen=True, slots=True)
class ProbeContext:
    adapter: AdapterKind
    feature_kind: FeatureKind | None
    app_kind: AppKind | None
    feature_invariants: frozenset[str]
    bundle_invariants: Mapping[str, Invariant]

    def rule_of(self, invariant_id: str) -> str | None:
        invariant = self.bundle_invariants.get(invariant_id)
        return None if invariant is None else invariant.rule


def spec_from_definition(definition: ProbeDefinition) -> ProbeSpec:
    return ProbeSpec(
        id=definition.id,
        pack=definition.pack,
        source=ProbeSource(definition.pack.value),
        question=definition.question,
        answer_type=definition.answer_type,
        choices=list(definition.choices),
        applies_to=definition.applies_to,
        input=definition.input,
        threshold=definition.threshold,
        invariant_id=definition.invariant_id,
        version=definition.version,
    )


def target_probe_spec(invariant: Invariant) -> ProbeSpec:
    digest = hashlib.sha256(invariant.rule.encode()).hexdigest()[:TARGET_PROBE_VERSION_LENGTH]
    return ProbeSpec(
        id=f"{TARGET_PROBE_ID_PREFIX}{invariant.id}",
        pack=InvariantPack.target,
        source=ProbeSource.target,
        question=TARGET_PROBE_QUESTION,
        answer_type=ProbeAnswerType.yes_no,
        choices=[],
        applies_to=ProbeAppliesTo(),
        input=ProbeInput(
            fields=[
                ProbeInputFieldSpec(name=name, max_chars=chars)
                for name, chars in TARGET_PROBE_FIELDS
            ]
        ),
        threshold=None,
        invariant_id=invariant.id,
        version=digest,
    )


def parse_manifest(manifest: Mapping[str, Any] | None) -> BundleManifest | None:
    return None if manifest is None else BundleManifest.model_validate(manifest)


def target_probe_specs(manifest: BundleManifest | None) -> list[ProbeSpec]:
    if manifest is None:
        return []
    return [
        target_probe_spec(invariant)
        for invariant in manifest.invariants
        if invariant.check == BUNDLE_PROBE_CHECK
    ]


def bank_probe_specs(bank: ProbeBank) -> list[ProbeSpec]:
    return [spec_from_definition(definition) for definition in bank.probes]


def listed_specs(bank: ProbeBank, manifest: BundleManifest | None) -> list[ProbeSpec]:
    return [*bank_probe_specs(bank), *target_probe_specs(manifest)]


def probe_pool(bank: ProbeBank, manifest: BundleManifest | None) -> list[ProbeSpec]:
    bundle_ids = {invariant.id for invariant in manifest.invariants} if manifest else set()
    inherited = [spec for spec in bank_probe_specs(bank) if spec.invariant_id not in bundle_ids]
    return [*inherited, *target_probe_specs(manifest)]


def build_probe_context(
    manifest: BundleManifest | None, feature_id: str | None, adapter: AdapterKind
) -> ProbeContext:
    if manifest is None:
        return ProbeContext(adapter, None, None, frozenset(), {})
    feature = next((item for item in manifest.features if item.id == feature_id), None)
    return ProbeContext(
        adapter=adapter,
        feature_kind=None if feature is None else feature.kind,
        app_kind=manifest.app.kind,
        feature_invariants=frozenset(() if feature is None else feature.invariants),
        bundle_invariants={invariant.id: invariant for invariant in manifest.invariants},
    )


def runs_by_default(spec: ProbeSpec, context: ProbeContext) -> bool:
    if spec.source is ProbeSource.target or spec.invariant_id not in DEFAULT_ON_INVARIANT_IDS:
        return False
    return spec.pack is InvariantPack.generic or context.app_kind is AppKind.llm_assistant


def fits_step(spec: ProbeSpec, context: ProbeContext) -> bool:
    adapters = spec.applies_to.adapters
    kinds = spec.applies_to.feature_kinds
    if adapters and context.adapter not in adapters:
        return False
    return not kinds or (context.feature_kind is not None and context.feature_kind in kinds)


def selected_by_invariants(spec: ProbeSpec, context: ProbeContext) -> bool:
    return spec.invariant_id in context.feature_invariants or runs_by_default(spec, context)


def select_probes(pool: Sequence[ProbeSpec], context: ProbeContext) -> list[ProbeSpec]:
    return [
        spec for spec in pool if fits_step(spec, context) and selected_by_invariants(spec, context)
    ]


def card_title(card: Mapping[str, Any]) -> str | None:
    for key in CARD_TITLE_KEYS:
        value = card.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def joined_or_none(items: Sequence[str]) -> str:
    return ", ".join(items) if items else NONE_TEXT


def step_texts(
    ask: str | None,
    answer: str | None,
    tool_names: Sequence[str],
    cards: Sequence[Mapping[str, Any]],
) -> StepTexts:
    titles = [title for card in cards if (title := card_title(card)) is not None]
    return StepTexts(
        ask=(ask or "").strip() or None,
        answer=(answer or "").strip() or None,
        tool_names=joined_or_none([name for name in tool_names if name]),
        card_titles=joined_or_none(titles),
    )


def field_value(name: ProbeInputField, texts: StepTexts, rule: str | None) -> str | None:
    match name:
        case ProbeInputField.ask:
            return texts.ask
        case ProbeInputField.answer:
            return texts.answer
        case ProbeInputField.tool_names:
            return texts.tool_names
        case ProbeInputField.card_titles:
            return texts.card_titles
        case ProbeInputField.invariant_rule:
            return rule


def available_field_values(
    spec: ProbeSpec, texts: StepTexts, context: ProbeContext
) -> dict[str, str]:
    rule = context.rule_of(spec.invariant_id)
    values: dict[str, str] = {}
    for field in spec.input.fields:
        value = field_value(field.name, texts, rule)
        if value is not None:
            values[field.name.value] = value
    return values


def has_every_input(spec: ProbeSpec, values: Mapping[str, str]) -> bool:
    return all(field.name.value in values for field in spec.input.fields)


def field_fits(field: ProbeInputFieldSpec, values: Mapping[str, str]) -> bool:
    value = values.get(field.name.value, "")
    return bool(value.strip()) and len(value) <= field.max_chars


def fits_field_limits(spec: ProbeSpec, values: Mapping[str, str]) -> bool:
    return all(field_fits(field, values) for field in spec.input.fields)


def render_probe_state(spec: ProbeSpec, values: Mapping[str, str]) -> str:
    return "\n".join(
        f"{PROBE_FIELD_LABELS[field.name]}: {values[field.name.value]}"
        for field in spec.input.fields
    )
