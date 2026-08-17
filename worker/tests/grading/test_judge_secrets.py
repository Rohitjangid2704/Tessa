import logging

import pytest
from pydantic import SecretStr
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import AppSetting
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import JudgeFamily, SecretName
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.judge import default_judge_activities
from tessa_worker.grading.judge_anthropic import AnthropicJudge
from tessa_worker.grading.judge_openai import OpenAIJudge
from tessa_worker.grading.judge_providers import KeyedJudgeProviders, ProviderKeys
from tessa_worker.settings import WorkerSettings
from tests.fakes.openai import (
    FAKE_ANTHROPIC_KEY,
    FAKE_OPENAI_KEY,
    FakeProvider,
    anthropic_reply,
    openai_error,
    openai_reply,
    valid_answer,
)
from tests.grading.support import (
    ANSWER,
    GOLD_KEY,
    SECRET_ASSIGNMENT,
    SECRET_VALUE,
    FakeProviders,
    evidence_block,
    gold_point,
    judge_input,
    seed_step,
    tiebreak_spec,
)

pytestmark = pytest.mark.integration

DB_KEY = "sk-from-the-database-0123456789abcdefghij"
ENV_KEY = "sk-from-the-environment-0123456789abcdefghij"
SECRET_FRAGMENT = "Zq8Xw3Lk9Vb2Nm5Rt7Yp4Hc6Jd1Gf0A"
NOISY_LOGGERS = ("", "openai", "anthropic", "httpx2", "httpcore2", "tessa_worker")


@pytest.fixture
def verbose_logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    for name in NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)
    caplog.set_level(logging.DEBUG)
    return caplog


def everything_logged(caplog: pytest.LogCaptureFixture) -> str:
    parts = [record.getMessage() for record in caplog.records]
    parts += [str(record.__dict__) for record in caplog.records]
    return "\n".join(parts)


async def test_neither_the_keys_nor_the_answer_nor_a_secret_in_it_are_ever_logged(
    verbose_logs: pytest.LogCaptureFixture,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
) -> None:
    hostile = f"{ANSWER} Leaked: {SECRET_ASSIGNMENT} and {SECRET_VALUE}"
    step = await seed_step(session_factory, answer=hostile, gold_points=[gold_point()])
    fake_provider.enqueue_openai(
        openai_reply(valid_answer("pass", 0.9, gold_points_used=(GOLD_KEY,)))
    )
    fake_provider.enqueue_anthropic(anthropic_reply(valid_answer("fail", 0.8)))
    activities = default_judge_activities(
        worker_settings, session_factory, FakeProviders(fake_provider)
    )
    evidence = evidence_block(answer=hostile)
    await ActivityEnvironment().run(activities.judge_step, judge_input(step.step_id, evidence))
    await ActivityEnvironment().run(
        activities.judge_tiebreak, judge_input(step.step_id, evidence, tiebreak_spec())
    )
    logged = everything_logged(verbose_logs)
    assert "judge_call" in logged
    for forbidden in (FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, SECRET_FRAGMENT, SECRET_VALUE, ANSWER):
        assert forbidden not in logged


async def test_a_rejected_key_is_not_echoed_in_the_error_or_the_logs(
    verbose_logs: pytest.LogCaptureFixture,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    fake_provider: FakeProvider,
) -> None:
    step = await seed_step(session_factory, gold_points=[gold_point()])
    fake_provider.enqueue_openai(openai_error(401, "invalid_api_key"))
    activities = default_judge_activities(
        worker_settings, session_factory, FakeProviders(fake_provider)
    )
    with pytest.raises(ApplicationError) as caught:
        await ActivityEnvironment().run(activities.judge_step, judge_input(step.step_id))
    assert FAKE_OPENAI_KEY not in str(caught.value)
    assert FAKE_OPENAI_KEY not in everything_logged(verbose_logs)


async def test_a_key_stored_in_settings_wins_over_the_environment(
    worker_settings: WorkerSettings, session_factory: SessionFactory
) -> None:
    vault = vault_from_settings(worker_settings)
    settings = worker_settings.model_copy(update={"openai_api_key": SecretStr(ENV_KEY)})
    async with session_factory() as session:
        session.add(
            AppSetting(
                key=SecretName.openai_api_key.value,
                is_secret=True,
                encrypted_value=vault.encrypt(DB_KEY),
            )
        )
        await session.commit()
    keys = ProviderKeys(session_factory, vault, settings)
    resolved = await keys.resolve(SecretName.openai_api_key)
    assert resolved is not None
    assert resolved.get_secret_value() == DB_KEY


async def test_the_environment_key_is_the_fallback_and_an_empty_one_is_no_key(
    worker_settings: WorkerSettings, session_factory: SessionFactory, database: None
) -> None:
    vault = vault_from_settings(worker_settings)
    with_env = worker_settings.model_copy(update={"openai_api_key": SecretStr(ENV_KEY)})
    resolved = await ProviderKeys(session_factory, vault, with_env).resolve(
        SecretName.openai_api_key
    )
    assert resolved is not None
    assert resolved.get_secret_value() == ENV_KEY
    assert (
        await ProviderKeys(session_factory, vault, worker_settings).resolve(
            SecretName.anthropic_api_key
        )
        is None
    )


async def test_the_keyed_providers_build_judges_with_sdk_retries_off(
    worker_settings: WorkerSettings, session_factory: SessionFactory
) -> None:
    settings = worker_settings.model_copy(
        update={
            "openai_api_key": SecretStr(ENV_KEY),
            "anthropic_api_key": SecretStr(ENV_KEY),
        }
    )
    providers = KeyedJudgeProviders(
        ProviderKeys(session_factory, vault_from_settings(settings), settings)
    )
    async with providers.open(JudgeFamily.openai, 20.0) as openai_judge:
        assert isinstance(openai_judge, OpenAIJudge)
        assert openai_judge.client.max_retries == 0
        assert openai_judge.client.api_key == ENV_KEY
    async with providers.open(JudgeFamily.anthropic, 20.0) as anthropic_judge:
        assert isinstance(anthropic_judge, AnthropicJudge)
        assert anthropic_judge.client.max_retries == 0


async def test_without_a_configured_key_no_provider_is_opened(
    worker_settings: WorkerSettings, session_factory: SessionFactory, database: None
) -> None:
    providers = KeyedJudgeProviders(
        ProviderKeys(session_factory, vault_from_settings(worker_settings), worker_settings)
    )
    for family in JudgeFamily:
        async with providers.open(family, 20.0) as provider:
            assert provider is None
