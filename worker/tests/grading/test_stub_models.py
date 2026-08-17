import uuid

import pytest
from cryptography.fernet import Fernet
from pydantic import BaseModel, SecretStr, ValidationError

from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.schemas.enums import JudgeOrder, ModelRole
from tessa_api.schemas.grading import EvidenceBlock
from tessa_worker.activities.judge import default_judge_activities
from tessa_worker.grading.judge_models import parse_judge_answer
from tessa_worker.settings import WorkerSettings
from tessa_worker.testing.stub_models import (
    STUB_MODEL_ID,
    STUB_REASON_CODE,
    StubCall,
    StubModelRegistry,
    StubModelsRefusedError,
    StubRoleNotRegisteredError,
    canned_judge_answer,
    default_stub_registry,
    ensure_stub_models_allowed,
)
from tests.grading.support import (
    GOLD_KEY,
    GOLD_RENDERED,
    evidence_block,
    gold_point,
    judge_input,
    model_spec,
    tiebreak_spec,
)
from tests.support import WORKER_ENV_EXAMPLE

PROD_DATABASE_URL = "postgresql+asyncpg://tessa:a-real-password@db.internal:5432/tessa"


class EmptyPayload(BaseModel):
    pass


def call_for(
    evidence: EvidenceBlock,
    order: JudgeOrder = JudgeOrder.a_b,
    role: ModelRole = ModelRole.judge,
) -> StubCall:
    spec = model_spec() if role is ModelRole.judge else tiebreak_spec()
    request = judge_input(uuid.uuid4(), evidence, spec, order)
    return StubCall(role=role, spec=spec, payload=request)


def verdict_of(call: StubCall) -> str:
    return parse_judge_answer(canned_judge_answer(call)).verdict


def test_the_stub_model_id_and_reason_code_are_the_contract_values() -> None:
    assert STUB_MODEL_ID == "stub"
    assert STUB_REASON_CODE == "stub_model"


def test_the_default_registry_covers_every_model_role() -> None:
    assert default_stub_registry().registered_roles() == frozenset(ModelRole)
    assert frozenset(ModelRole) == {ModelRole.judge, ModelRole.judge_tiebreak}


def test_a_role_can_be_registered_once_and_replaced_explicitly() -> None:
    registry = StubModelRegistry()
    registry.register(ModelRole.judge_tiebreak, lambda call: "first")
    with pytest.raises(ValueError, match="already registered"):
        registry.register(ModelRole.judge_tiebreak, lambda call: "second")
    registry.replace(ModelRole.judge_tiebreak, lambda call: "second")
    tiebreak_call = StubCall(
        role=ModelRole.judge_tiebreak, spec=tiebreak_spec(), payload=EmptyPayload()
    )
    assert registry.reply(tiebreak_call) == "second"


def test_a_role_without_a_stub_is_an_error_not_a_silent_default() -> None:
    registry = StubModelRegistry()
    with pytest.raises(StubRoleNotRegisteredError):
        registry.reply(call_for(evidence_block()))


def test_a_role_replaced_in_one_registry_leaves_the_default_untouched() -> None:
    def empty_answer(call: StubCall) -> str:
        return "{}"

    call = call_for(evidence_block())
    registry = default_stub_registry()
    registry.replace(ModelRole.judge, empty_answer)
    assert registry.handlers[ModelRole.judge] is empty_answer
    assert registry.reply(call) == "{}"
    assert default_stub_registry().handlers[ModelRole.judge] is canned_judge_answer
    assert default_stub_registry().reply(call) == canned_judge_answer(call)


def test_the_judge_stub_only_answers_judge_input() -> None:
    wrong = StubCall(role=ModelRole.judge, spec=model_spec(), payload=EmptyPayload())
    with pytest.raises(TypeError):
        canned_judge_answer(wrong)


def test_every_stub_answer_is_schema_valid_and_deterministic() -> None:
    evidence = evidence_block()
    first = canned_judge_answer(call_for(evidence))
    second = canned_judge_answer(call_for(evidence))
    assert first == second
    parse_judge_answer(first)


def test_the_stub_answer_does_not_depend_on_the_presentation_order() -> None:
    evidence = evidence_block()
    forward = canned_judge_answer(call_for(evidence, JudgeOrder.a_b))
    backward = canned_judge_answer(call_for(evidence, JudgeOrder.b_a))
    assert forward == backward


def test_the_tiebreak_stub_answers_like_the_judge_stub() -> None:
    evidence = evidence_block()
    judge = canned_judge_answer(call_for(evidence))
    tiebreak = canned_judge_answer(call_for(evidence, role=ModelRole.judge_tiebreak))
    assert judge == tiebreak


def test_the_stub_passes_only_an_answer_that_states_every_gold_point() -> None:
    assert verdict_of(call_for(evidence_block(answer=f"Yes: {GOLD_RENDERED} today"))) == "pass"


def test_the_stub_fails_an_answer_that_misses_a_gold_point() -> None:
    assert verdict_of(call_for(evidence_block(answer="Nothing is open."))) == "fail"


def test_the_stub_fails_an_answer_that_asserts_a_forbidden_claim() -> None:
    evidence = evidence_block(
        answer=f"{GOLD_RENDERED}. It is confirmed.", must_not_claim=["It is confirmed"]
    )
    answer = parse_judge_answer(canned_judge_answer(call_for(evidence)))
    assert answer.verdict == "fail"
    assert answer.must_not_claim_found == [0]


def test_the_stub_never_passes_without_a_reference() -> None:
    assert verdict_of(call_for(evidence_block(gold_points=[]))) == "uncertain"


def test_the_stub_never_passes_an_empty_answer() -> None:
    assert verdict_of(call_for(evidence_block(answer=""))) == "uncertain"
    assert verdict_of(call_for(evidence_block(answer=None))) == "uncertain"


def test_the_stub_does_not_pass_claims_no_gold_point_supports() -> None:
    answer = f"{GOLD_RENDERED}. The manager was paid 4500 dollars."
    assert verdict_of(call_for(evidence_block(answer=answer))) == "uncertain"


def test_the_stub_lists_the_gold_points_it_relied_on() -> None:
    evidence = evidence_block(
        answer=f"{GOLD_RENDERED} and 8 rooms in total",
        gold_points=[gold_point(), gold_point(key="rooms", rendered="8 rooms in total", value=8)],
    )
    answer = parse_judge_answer(canned_judge_answer(call_for(evidence)))
    assert answer.verdict == "pass"
    assert answer.gold_points_used == [GOLD_KEY, "rooms"]


def test_the_stub_is_refused_when_the_environment_is_prod(worker_settings: WorkerSettings) -> None:
    prod = worker_settings.model_copy(update={"env": "prod", "stub_models": True})
    with pytest.raises(StubModelsRefusedError):
        ensure_stub_models_allowed(prod)


@pytest.mark.parametrize(
    ("env", "stub"), [("prod", False), ("dev", True), ("test", True), ("dev", False)]
)
def test_every_other_combination_is_allowed(
    worker_settings: WorkerSettings, env: str, stub: bool
) -> None:
    ensure_stub_models_allowed(worker_settings.model_copy(update={"env": env, "stub_models": stub}))


def test_building_the_judge_activities_refuses_stubs_in_prod(
    worker_settings: WorkerSettings,
) -> None:
    prod = worker_settings.model_copy(update={"env": "prod", "stub_models": True})
    factory = create_session_factory(create_engine(prod.database_url))
    with pytest.raises(StubModelsRefusedError):
        default_judge_activities(prod, factory)


def test_the_settings_themselves_refuse_stubs_in_prod() -> None:
    with pytest.raises(ValidationError, match="stub_models must be false"):
        WorkerSettings(
            _env_file=WORKER_ENV_EXAMPLE,
            env="prod",
            stub_models=True,
            service_key=SecretStr("a-production-service-key-0123456789abcdef"),
            vault_key=SecretStr(Fernet.generate_key().decode()),
            database_url=SecretStr(PROD_DATABASE_URL),
        )
