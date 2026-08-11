import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, TypeAdapter, ValidationError

from tessa_api.schemas.enums import ProbeAnswerType, SettingSource
from tessa_api.schemas.grading import (
    EvidenceBlock,
    GradePolicy,
    JudgeResult,
    JudgeStepInput,
    JudgeStepOutput,
    ModelCallSpec,
    ModelUsage,
    ProbeBatchResult,
)
from tessa_api.schemas.labels import Label, LabelCreate, LabelStats, LabelTask
from tessa_api.schemas.oracles import (
    DbCheck,
    GoldPoint,
    OracleApprovalSet,
    OracleResult,
    OracleRunCreate,
    OracleTemplate,
)
from tessa_api.schemas.probes import (
    Probe,
    ProbeBankFile,
    ProbeDefinition,
    ProbePage,
    ProbeResult,
)
from tessa_api.schemas.runs import RunCreate
from tessa_api.schemas.seeds import Seed, SeedResetCreate, SeedVerifyCreate
from tessa_api.schemas.settings import (
    SecretSet,
    SecretStatus,
    ServiceTestResult,
    SettingsPatch,
    SettingsRead,
)
from tessa_api.schemas.steps import Step
from tessa_api.schemas.streams import (
    ScenarioVerdictEvent,
    StepGradedEvent,
    stream_event_adapter,
)
from tessa_api.services.schema_registry import build_schema_document, find_definition
from tests.test_step_models import step_document

EXAMPLES: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "stage_three_four" / "wire_examples.json").read_text(
        encoding="utf-8"
    )
)

MODEL_BY_EXAMPLE: dict[str, type[BaseModel]] = {
    "Seed": Seed,
    "SeedUnverified": Seed,
    "SeedResetCreate": SeedResetCreate,
    "OracleTemplate": OracleTemplate,
    "OracleResult": OracleResult,
    "OracleResultPending": OracleResult,
    "OracleApprovalSet": OracleApprovalSet,
    "GoldPoint": GoldPoint,
    "DbCheck": DbCheck,
    "Probe": Probe,
    "ProbeResult": ProbeResult,
    "ProbeResultError": ProbeResult,
    "JudgeResult": JudgeResult,
    "EvidenceBlock": EvidenceBlock,
    "Label": Label,
    "LabelWeak": Label,
    "LabelTask": LabelTask,
    "LabelStats": LabelStats,
    "SettingsRead": SettingsRead,
    "ServiceTestResult": ServiceTestResult,
}
EVENT_EXAMPLES = ["SeedProgressEvent", "StepGradedEvent", "ScenarioVerdictEvent"]

STEP_ID = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4"
TARGET_ID = "0198f6f2-7b00-7a00-9d00-000000000006"

PROBE_FILE: dict[str, Any] = {
    "schema_version": 1,
    "probes": [
        {
            "id": "no_save_claim_before_confirm",
            "pack": "llm_app",
            "question": "Does the answer say the change was saved?",
            "answer_type": "yes_no",
            "applies_to": {"feature_kinds": ["write"], "adapters": ["sse", "browser"]},
            "input": {"fields": [{"name": "answer", "max_chars": 600}]},
            "threshold": 0.8,
            "invariant_id": "no_save_claim_before_confirm",
            "version": "1",
        },
        {
            "id": "answer_tone",
            "pack": "generic",
            "question": "Which tone does the answer have?",
            "answer_type": "choice",
            "choices": ["polite", "neutral", "rude"],
            "input": {
                "fields": [{"name": "ask", "max_chars": 300}, {"name": "answer", "max_chars": 600}]
            },
            "invariant_id": "tone",
            "version": "2",
        },
    ],
}


@pytest.mark.parametrize("name", sorted(MODEL_BY_EXAMPLE))
def test_a_wire_example_round_trips_through_its_model_unchanged(name: str) -> None:
    model = MODEL_BY_EXAMPLE[name]
    parsed = model.model_validate(EXAMPLES[name])
    assert parsed.model_dump(mode="json") == EXAMPLES[name]
    assert model.model_validate_json(parsed.model_dump_json()) == parsed


@pytest.mark.parametrize("name", EVENT_EXAMPLES)
def test_a_stage_three_or_four_event_round_trips_through_the_stream_union(name: str) -> None:
    parsed = stream_event_adapter.validate_python(EXAMPLES[name])
    assert json.loads(stream_event_adapter.dump_json(parsed, by_alias=True)) == EXAMPLES[name]


def test_the_seed_progress_payload_rejects_unknown_phases_and_statuses() -> None:
    broken_phase = {**EXAMPLES["SeedProgressEvent"]["payload"], "phase": "wipe"}
    broken_status = {**EXAMPLES["SeedProgressEvent"]["payload"], "status": "done"}
    for payload in (broken_phase, broken_status):
        with pytest.raises(ValidationError):
            stream_event_adapter.validate_python(
                {**EXAMPLES["SeedProgressEvent"], "payload": payload}
            )


def test_the_step_graded_payload_needs_a_verdict_and_names_the_escalation_tier() -> None:
    payload = EXAMPLES["StepGradedEvent"]["payload"]
    for broken in ({**payload, "escalated_to": "oracle"}, {**payload, "verdict": None}):
        with pytest.raises(ValidationError):
            stream_event_adapter.validate_python({**EXAMPLES["StepGradedEvent"], "payload": broken})
    code_only = {**payload, "escalated_to": None}
    parsed = stream_event_adapter.validate_python(
        {**EXAMPLES["StepGradedEvent"], "payload": code_only}
    )
    assert isinstance(parsed, StepGradedEvent)
    assert parsed.payload.escalated_to is None


def test_scenario_verdicts_carry_the_tier_and_a_confidence_between_zero_and_one() -> None:
    parsed = stream_event_adapter.validate_python(EXAMPLES["ScenarioVerdictEvent"])
    assert isinstance(parsed, ScenarioVerdictEvent)
    verdict = parsed.payload.verdict
    assert (verdict.tier.value, verdict.confidence) == ("laya", 0.93)
    too_confident = json.loads(json.dumps(EXAMPLES["ScenarioVerdictEvent"]))
    too_confident["payload"]["verdict"]["confidence"] = 1.2
    with pytest.raises(ValidationError):
        stream_event_adapter.validate_python(too_confident)


def test_a_step_carries_gold_points_db_checks_probes_judge_and_evidence() -> None:
    document = step_document(
        gold_points=[EXAMPLES["GoldPoint"]],
        db_checks=[EXAMPLES["DbCheck"]],
        probes=[EXAMPLES["ProbeResult"], EXAMPLES["ProbeResultError"]],
        judge=EXAMPLES["JudgeResult"],
        evidence=EXAMPLES["EvidenceBlock"],
    )
    step = Step.model_validate(document)
    assert [point.key for point in step.gold_points] == ["open_count"]
    assert step.db_checks[0].status.value == "fail"
    assert [result.status.value for result in step.probes] == ["decided", "error"]
    assert step.judge is not None
    assert step.judge.family.value == "openai"
    assert step.evidence is not None
    dumped = step.model_dump(mode="json")
    for key in ("gold_points", "db_checks", "probes", "judge", "evidence"):
        assert dumped[key] == document[key]
    assert Step.model_validate_json(step.model_dump_json()) == step


@pytest.mark.parametrize("missing", ["gold_points", "db_checks", "probes", "judge", "evidence"])
def test_the_stage_three_and_four_step_keys_are_always_present(missing: str) -> None:
    document = step_document()
    del document[missing]
    with pytest.raises(ValidationError):
        Step.model_validate(document)


def test_the_evidence_block_is_an_allow_list() -> None:
    with pytest.raises(ValidationError):
        EvidenceBlock.model_validate({**EXAMPLES["EvidenceBlock"], "bundle_text": "manifest body"})
    nested = json.loads(json.dumps(EXAMPLES["EvidenceBlock"]))
    nested["gold_points"][0]["oracle_result_id"] = "0198f6f2-7b00-7a00-9d00-0000000000b2"
    with pytest.raises(ValidationError):
        EvidenceBlock.model_validate(nested)


def test_a_model_activity_output_carries_the_usage_triple_at_its_top_level() -> None:
    output = JudgeStepOutput.model_validate(
        {
            "verdict": EXAMPLES["JudgeResult"]["verdict"],
            "rationale": "The count differs from the oracle.",
            "evidence": EXAMPLES["JudgeResult"]["evidence"],
            "judge_result_id": EXAMPLES["JudgeResult"]["id"],
            "cost_usd": 0.004321,
            "input_tokens": 1800,
            "output_tokens": 210,
        }
    )
    assert isinstance(output, ModelUsage)
    assert output.swapped_agrees is None
    assert {"cost_usd", "input_tokens", "output_tokens"} <= set(output.model_dump())


def test_the_judge_input_names_its_order_and_the_call_spec() -> None:
    spec = {
        "role": "judge",
        "model": "gpt-6.1-sol",
        "effort": "low",
        "max_usd": 0.05,
        "max_input_tokens": 6000,
        "max_output_tokens": 800,
        "start_to_close_timeout_seconds": 60,
        "max_attempts": 2,
    }
    document = {
        "step_id": STEP_ID,
        "evidence": EXAMPLES["EvidenceBlock"],
        "order": "a_b",
        "spec": spec,
    }
    parsed = JudgeStepInput.model_validate(document)
    assert parsed.paired_with is None
    assert parsed.spec == ModelCallSpec.model_validate(spec)
    with pytest.raises(ValidationError):
        JudgeStepInput.model_validate({**document, "order": "c_d"})
    with pytest.raises(ValidationError):
        ModelCallSpec.model_validate({**spec, "role": "arbiter"})


def test_the_grade_policy_bounds_are_probabilities() -> None:
    GradePolicy(probe_confidence=0.75, judge_escalate_below=0.6, tiebreak_enabled=False)
    with pytest.raises(ValidationError):
        GradePolicy(probe_confidence=1.1, judge_escalate_below=0.6, tiebreak_enabled=False)


def test_a_probe_batch_result_is_a_list_of_probe_results() -> None:
    batch = ProbeBatchResult.model_validate(
        {"results": [EXAMPLES["ProbeResult"], EXAMPLES["ProbeResultError"]]}
    )
    assert [result.confidence for result in batch.results] == [0.91, 0.0]


def test_a_probe_result_confidence_and_threshold_stay_between_zero_and_one() -> None:
    for broken in (
        {"confidence": 1.5},
        {"threshold": -0.1},
        {"status": "maybe"},
        {"engine": "gpt"},
    ):
        with pytest.raises(ValidationError):
            ProbeResult.model_validate({**EXAMPLES["ProbeResult"], **broken})


def test_run_create_declares_reset_seed_off_by_default() -> None:
    plan_id = "0198f6f2-7b00-7a00-9d00-000000000003"
    assert RunCreate.model_validate({"plan_id": plan_id}).reset_seed is False
    assert RunCreate.model_validate({"plan_id": plan_id, "reset_seed": True}).reset_seed is True
    with pytest.raises(ValidationError):
        RunCreate.model_validate({"plan_id": plan_id, "reset_seed": "sometimes"})


def test_seed_requests_default_the_seed_and_type_the_confirmation() -> None:
    assert SeedVerifyCreate.model_validate({}).seed_id is None
    assert SeedResetCreate.model_validate({"confirm_target_name": "x"}).seed_id is None
    with pytest.raises(ValidationError):
        SeedResetCreate.model_validate({})
    with pytest.raises(ValidationError):
        SeedResetCreate.model_validate({"confirm_target_name": "x" * 121})


def test_an_oracle_run_takes_free_form_json_params_and_an_approval_names_its_result() -> None:
    assert OracleRunCreate.model_validate({"params": {"a": [1, {"b": None}]}}).params["a"] == [
        1,
        {"b": None},
    ]
    with pytest.raises(ValidationError):
        OracleRunCreate.model_validate({})
    with pytest.raises(ValidationError):
        OracleApprovalSet.model_validate({"approved": True})


def test_label_requests_bound_the_note_and_name_the_subject_kind() -> None:
    document = {"subject_type": "step", "subject_id": STEP_ID, "value": "pass"}
    assert LabelCreate.model_validate(document).note is None
    LabelCreate.model_validate({**document, "note": "n" * 1000})
    for broken in ({"note": "n" * 1001}, {"subject_type": "run"}, {"value": "maybe"}):
        with pytest.raises(ValidationError):
            LabelCreate.model_validate({**document, **broken})


def test_label_stats_have_a_key_for_every_subject_type_in_the_example() -> None:
    stats = LabelStats.model_validate(EXAMPLES["LabelStats"])
    assert {key.value for key in stats.by_subject_type} == {
        "probe_result",
        "judge_result",
        "invariant_result",
        "step",
    }


def test_settings_read_lists_both_judge_roles_and_keeps_later_stage_groups_null() -> None:
    parsed = SettingsRead.model_validate(EXAMPLES["SettingsRead"])
    assert {role.value for role in parsed.models} == {
        "judge",
        "judge_tiebreak",
    }
    assert parsed.models[next(role for role in parsed.models if role.value == "judge")].source is (
        SettingSource.db
    )
    assert parsed.notifications is None
    assert parsed.policies is None


def test_a_secret_status_never_carries_a_value() -> None:
    assert "value" not in SecretStatus.model_fields
    assert not {"value", "secret", "key"} & set(SecretStatus.model_fields)


def test_a_secret_is_write_only_and_is_masked_when_dumped() -> None:
    secret = SecretSet.model_validate({"value": "sk-live-abcdef"})
    assert "sk-live-abcdef" not in repr(secret)
    assert "sk-live-abcdef" not in secret.model_dump_json()
    assert secret.value.get_secret_value() == "sk-live-abcdef"
    for broken in ({"value": ""}, {"value": "k" * 4097}, {}):
        with pytest.raises(ValidationError):
            SecretSet.model_validate(broken)


def test_a_settings_patch_may_be_empty_and_merges_per_leaf() -> None:
    assert SettingsPatch.model_validate({}).model_fields_set == set()
    patch = SettingsPatch.model_validate(
        {
            "models": {"judge": {"effort": "high"}},
            "thresholds": {"probe_confidence": 0.8},
            "budgets": {"default_max_usd": 3},
        }
    )
    assert patch.models is not None
    [(role, role_patch)] = patch.models.items()
    assert role.value == "judge"
    assert role_patch.model_fields_set == {"effort"}
    assert patch.thresholds is not None
    assert patch.thresholds.model_fields_set == {"probe_confidence"}


def test_a_leaf_set_to_null_is_kept_so_the_override_can_be_deleted() -> None:
    patch = SettingsPatch.model_validate(
        {"thresholds": {"label_audit_rate": None}, "endpoints": {"laya_url": None}}
    )
    assert patch.thresholds is not None
    assert patch.thresholds.label_audit_rate is None
    assert patch.thresholds.model_fields_set == {"label_audit_rate"}
    assert patch.endpoints is not None
    assert patch.endpoints.model_fields_set == {"laya_url"}


@pytest.mark.parametrize(
    "document",
    [
        {"unknown_group": {}},
        {"thresholds": {"probe_confidence": 0.8, "surprise": 1}},
        {"models": {"judge": {"effort": "high", "source": "db"}}},
        {"models": {"arbiter": {"effort": "high"}}},
        {"models": {"judge": {"effort": "extreme"}}},
        {"models": {"judge": None}},
        {"secrets": {"openai_api_key": {"has_value": True}}},
        {"overrides": ["thresholds.probe_confidence"]},
        {"thresholds": None},
        {"models": None},
        {"thresholds": {"probe_confidence": 1.5}},
        {"thresholds": {"label_audit_rate": -0.1}},
        {"budgets": {"default_max_usd": 0}},
        {"budgets": {"default_max_minutes": 0}},
        {"budgets": {"max_concurrency": 0}},
        {"models": {"judge": {"timeout_seconds": 0}}},
        {"models": {"judge": {"model": ""}}},
        {"endpoints": {"laya_url": ""}},
    ],
)
def test_a_settings_patch_rejects_what_the_contract_forbids(document: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        SettingsPatch.model_validate(document)


def test_the_probe_bank_file_accepts_a_valid_document_and_round_trips() -> None:
    bank = ProbeBankFile.model_validate(PROBE_FILE)
    assert [probe.answer_type for probe in bank.probes] == [
        ProbeAnswerType.yes_no,
        ProbeAnswerType.choice,
    ]
    assert bank.probes[0].applies_to.adapters[0].value == "sse"
    assert bank.probes[1].threshold is None
    dumped = bank.model_dump(mode="json")
    assert ProbeBankFile.model_validate(dumped) == bank


def probe_with(**overrides: Any) -> dict[str, Any]:
    return {**PROBE_FILE, "probes": [{**PROBE_FILE["probes"][0], **overrides}]}


@pytest.mark.parametrize(
    "document",
    [
        probe_with(answer_type="free_text"),
        probe_with(answer_type="yes_no", choices=["yes", "no"]),
        probe_with(answer_type="choice", choices=["only"]),
        probe_with(answer_type="choice", choices=["a", "a"]),
        probe_with(pack="target"),
        probe_with(pack="custom"),
        probe_with(question=""),
        probe_with(question="q" * 401),
        probe_with(threshold=1.2),
        probe_with(id="has space"),
        probe_with(version=""),
        probe_with(invariant_id=""),
        probe_with(input={"fields": []}),
        probe_with(input={"fields": [{"name": "bundle_manifest", "max_chars": 100}]}),
        probe_with(input={"fields": [{"name": "answer", "max_chars": 2001}]}),
        probe_with(input={"fields": [{"name": "answer", "max_chars": 0}]}),
        probe_with(
            input={
                "fields": [{"name": "answer", "max_chars": 10}, {"name": "answer", "max_chars": 20}]
            }
        ),
        probe_with(unexpected="key"),
        probe_with(applies_to={"feature_kinds": ["telepathy"]}),
        {"schema_version": 2, "probes": PROBE_FILE["probes"]},
        {"schema_version": 1, "probes": []},
        {"probes": PROBE_FILE["probes"]},
        {"schema_version": 1, "probes": [PROBE_FILE["probes"][0], PROBE_FILE["probes"][0]]},
    ],
)
def test_the_probe_bank_file_rejects_what_the_bank_must_never_hold(
    document: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        ProbeBankFile.model_validate(document)


def test_a_probe_definition_is_its_own_valid_model() -> None:
    definition = ProbeDefinition.model_validate(PROBE_FILE["probes"][0])
    assert definition.choices == []
    assert [spec.max_chars for spec in definition.input.fields] == [600]


def test_probe_v1_json_is_registered_and_validates_the_same_documents() -> None:
    definition = find_definition("probe", 1)
    assert definition is not None
    assert definition.stage == 4
    assert definition.file_name == "probe.v1.json"
    document = build_schema_document(definition)
    Draft202012Validator.check_schema(document)
    assert document["title"] == "Tessa probe bank"
    validator = Draft202012Validator(document)
    validator.validate(PROBE_FILE)
    assert not validator.is_valid(probe_with(pack="target"))
    assert not validator.is_valid(probe_with(unexpected="key"))
    assert not validator.is_valid({"schema_version": 1, "probes": []})
    assert not validator.is_valid(
        probe_with(input={"fields": [{"name": "bundle_manifest", "max_chars": 100}]})
    )


def test_the_probe_listing_model_is_a_page_of_probes() -> None:
    page = ProbePage.model_validate({"items": [EXAMPLES["Probe"]], "next_cursor": None, "total": 1})
    assert page.items[0].threshold == 0.8
    assert TypeAdapter(ProbePage).dump_python(page, mode="json")["total"] == 1
