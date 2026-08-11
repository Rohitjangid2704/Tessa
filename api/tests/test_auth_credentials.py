import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from tessa_api.auth.users import create_user, ensure_bootstrap_admin
from tessa_api.db.models import User
from tessa_api.errors import ApiError
from tessa_api.main import create_app
from tessa_api.schemas.enums import UserRole
from tessa_api.services.rate_limit import LoginRateLimiter
from tessa_api.settings import Settings
from tests.support import TEST_PASSWORD, MakeUser, settings_with

VERIFY_PATH = "/api/v1/auth/credentials/verify"


def service_headers(settings: Settings) -> dict[str, str]:
    return {"X-Service-Key": settings.service_key.get_secret_value()}


def credentials(email: str, password: str = TEST_PASSWORD) -> dict[str, str]:
    return {"email": email, "password": password}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.mark.integration
async def test_correct_credentials_return_the_user(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user(UserRole.admin)
    response = await client.post(
        VERIFY_PATH, json=credentials(user.email), headers=service_headers(settings)
    )
    assert response.status_code == 200
    assert response.json() == {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "role": "admin",
    }


@pytest.mark.integration
async def test_email_is_case_insensitive(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user(email="Mixed.Case@tessa.test")
    response = await client.post(
        VERIFY_PATH,
        json=credentials("MIXED.case@TESSA.test"),
        headers=service_headers(settings),
    )
    assert response.status_code == 200
    assert response.json()["id"] == str(user.id)


@pytest.mark.integration
async def test_successful_login_records_last_login(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings, db_app: FastAPI
) -> None:
    user = await make_user()
    assert user.last_login_at is None
    await client.post(VERIFY_PATH, json=credentials(user.email), headers=service_headers(settings))
    async with db_app.state.session_factory() as session:
        stored = await session.get(User, user.id)
        assert stored is not None
        assert stored.last_login_at is not None


@pytest.mark.integration
async def test_password_is_stored_as_argon2id(db_app: FastAPI, make_user: MakeUser) -> None:
    user = await make_user()
    assert user.password_hash is not None
    assert user.password_hash.startswith("$argon2id$")
    assert TEST_PASSWORD not in user.password_hash


@pytest.mark.integration
async def test_wrong_password_unknown_email_and_inactive_user_look_identical(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    inactive = await make_user(is_active=False)
    attempts = [
        credentials(user.email, "wrong-password"),
        credentials("nobody@tessa.test"),
        credentials(inactive.email),
    ]
    bodies = []
    for attempt in attempts:
        response = await client.post(VERIFY_PATH, json=attempt, headers=service_headers(settings))
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_credentials"
        bodies.append(response.json()["error"]["message"])
    assert len(set(bodies)) == 1


@pytest.mark.integration
async def test_service_key_is_required(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    missing = await client.post(VERIFY_PATH, json=credentials(user.email))
    wrong = await client.post(
        VERIFY_PATH, json=credentials(user.email), headers={"X-Service-Key": "nope-nope-nope"}
    )
    bearer_is_not_enough = await client.post(
        VERIFY_PATH,
        json=credentials(user.email),
        headers={"Authorization": f"Bearer {settings.service_key.get_secret_value()}"},
    )
    for response in (missing, wrong, bearer_is_not_enough):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.integration
async def test_service_key_check_runs_before_credential_check(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    user = await make_user()
    for _ in range(8):
        response = await client.post(VERIFY_PATH, json=credentials(user.email, "wrong"))
        assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.integration
async def test_login_rate_limit_after_five_failures(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    headers = service_headers(settings)
    for _ in range(5):
        response = await client.post(
            VERIFY_PATH, json=credentials(user.email, "wrong-password"), headers=headers
        )
        assert response.status_code == 401
    blocked = await client.post(VERIFY_PATH, json=credentials(user.email), headers=headers)
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    assert 1 <= int(blocked.headers["retry-after"]) <= 60
    other = await make_user()
    allowed = await client.post(VERIFY_PATH, json=credentials(other.email), headers=headers)
    assert allowed.status_code == 200


@pytest.mark.integration
async def test_success_resets_the_failure_counter(
    client: httpx.AsyncClient, make_user: MakeUser, settings: Settings
) -> None:
    user = await make_user()
    headers = service_headers(settings)
    for _ in range(4):
        await client.post(VERIFY_PATH, json=credentials(user.email, "wrong"), headers=headers)
    ok = await client.post(VERIFY_PATH, json=credentials(user.email), headers=headers)
    assert ok.status_code == 200
    for _ in range(4):
        response = await client.post(
            VERIFY_PATH, json=credentials(user.email, "wrong"), headers=headers
        )
        assert response.status_code == 401


def test_limiter_window_expires() -> None:
    clock = FakeClock()
    limiter = LoginRateLimiter(max_failures=3, window_seconds=60, clock=clock)
    for _ in range(3):
        limiter.record_failure("a@b.c", "1.2.3.4")
    with pytest.raises(ApiError) as caught:
        limiter.check("a@b.c", "1.2.3.4")
    assert caught.value.status_code == 429
    assert caught.value.headers["Retry-After"] == "60"
    clock.now += 61
    limiter.check("a@b.c", "1.2.3.4")


def test_limiter_is_per_email_and_ip_and_case_insensitive() -> None:
    limiter = LoginRateLimiter(max_failures=2, window_seconds=60, clock=FakeClock())
    limiter.record_failure("A@b.c", "1.1.1.1")
    limiter.record_failure("a@B.c", "1.1.1.1")
    limiter.check("a@b.c", "2.2.2.2")
    limiter.check("other@b.c", "1.1.1.1")
    with pytest.raises(ApiError, match="Too many"):
        limiter.check("a@b.c", "1.1.1.1")


def test_limiter_prunes_idle_entries() -> None:
    clock = FakeClock()
    limiter = LoginRateLimiter(max_failures=5, window_seconds=60, clock=clock)
    for index in range(1100):
        limiter.record_failure(f"user{index}@b.c", "1.1.1.1")
    clock.now += 120
    limiter.record_failure("late@b.c", "1.1.1.1")
    assert len(limiter.failures) == 1


def bootstrap_settings() -> Settings:
    return settings_with(
        bootstrap_admin_email="root@tessa.test",
        bootstrap_admin_password="dev-only-root-password-1",
    )


@pytest.mark.integration
async def test_bootstrap_admin_is_created_when_users_is_empty(database: None) -> None:
    configured = bootstrap_settings()
    app = create_app(configured)
    async with app.router.lifespan_context(app), app.state.session_factory() as session:
        users = list(await session.scalars(select(User)))
    assert [(u.email, u.role, u.is_active) for u in users] == [
        ("root@tessa.test", UserRole.admin, True)
    ]
    second = create_app(configured)
    async with second.router.lifespan_context(second), second.state.session_factory() as session:
        assert len(list(await session.scalars(select(User)))) == 1


@pytest.mark.integration
async def test_bootstrap_admin_is_skipped_when_users_exist(database: None) -> None:
    configured = bootstrap_settings()
    app = create_app(configured)
    async with app.state.session_factory() as session:
        await create_user(session, "first@tessa.test", "First", TEST_PASSWORD, UserRole.member)
    assert await ensure_bootstrap_admin(app.state.session_factory, configured) is False
    async with app.state.session_factory() as session:
        emails = list(await session.scalars(select(User.email)))
    assert emails == ["first@tessa.test"]
    await app.state.engine.dispose()


@pytest.mark.integration
async def test_bootstrap_admin_can_log_in(database: None) -> None:
    configured = bootstrap_settings()
    app = create_app(configured)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            response = await http.post(
                VERIFY_PATH,
                json=credentials("root@tessa.test", "dev-only-root-password-1"),
                headers=service_headers(configured),
            )
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


async def test_database_outage_is_a_503_not_a_500() -> None:
    broken = settings_with(
        database_url="postgresql+asyncpg://tessa:x@127.0.0.1:1/tessa_test"
    )
    app = create_app(broken)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            response = await http.post(
                VERIFY_PATH,
                json=credentials("a@b.c"),
                headers=service_headers(broken),
            )
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "dependency_unavailable"
    assert error["details"][0]["code"] == "db"
    assert error["details"][0]["loc"] == ["dependency"]
