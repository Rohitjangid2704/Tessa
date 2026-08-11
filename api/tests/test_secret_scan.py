import pytest

from tessa_api.errors import ApiError
from tessa_api.services.secret_scan import (
    MAX_REPORTED_HITS,
    REDACTION,
    reject_secrets,
    scan_files,
    scan_text,
)

AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
OPENAI_KEY = "sk-" + "proj-abcdefghijklmnopqrstuvwx1234"
GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
SLACK_TOKEN = "xoxb-" + "123456789012-abcdefghij"
JWT = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcdEFGH12345678"
DSN_PASSWORD = "s3cr3t-Passw0rd"
REAL_LOOKING_VALUE = "9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"


def patterns(line: str) -> list[str]:
    return [hit.pattern for hit in scan_text("f.txt", line)]


@pytest.mark.parametrize(
    ("line", "pattern"),
    [
        (f"aws_access_key_id = {AWS_KEY}", "aws_access_key"),
        (f"OPENAI_API_KEY={OPENAI_KEY}", "api_secret_key"),
        (f"token: {GITHUB_TOKEN}", "github_token"),
        (f"hook = {SLACK_TOKEN}", "slack_token"),
        ("-----BEGIN RSA PRIVATE KEY-----", "private_key"),
        ("-----BEGIN PRIVATE KEY-----", "private_key"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----", "private_key"),
        (f"DATABASE_URL=postgres://reader:{DSN_PASSWORD}@db.internal:5432/gracie", "dsn_password"),
        (f"redis://:{DSN_PASSWORD}@cache:6379/0", "dsn_password"),
        (f"Authorization: Bearer {REAL_LOOKING_VALUE}", "bearer_token"),
        (f"curl -H 'Authorization: Bearer {REAL_LOOKING_VALUE}' http://x", "bearer_token"),
        (f"cookie: {JWT}", "jwt"),
        ("ADMIN_PASSWORD=Tr0ub4dor&3xyz", "high_entropy_assignment"),
        (f"api_token: {REAL_LOOKING_VALUE}", "high_entropy_assignment"),
        (f'"client_secret": "{REAL_LOOKING_VALUE}"', "high_entropy_assignment"),
        ("apiKey = 'Zx81QpLm20aBc99dEf'", "high_entropy_assignment"),
        (f"STRIPE_SECRET_KEY={REAL_LOOKING_VALUE}", "high_entropy_assignment"),
    ],
)
def test_real_looking_secrets_are_found(line: str, pattern: str) -> None:
    assert pattern in patterns(line)


@pytest.mark.parametrize(
    "line",
    [
        "ADMIN_TOKEN=${ADMIN_TOKEN}",
        "token_source: POST /auth/login with ${ADMIN_EMAIL} and ${ADMIN_PASSWORD}",
        "ADMIN_TOKEN=<admin-api-token>  # API token of the admin role",
        "STAFF_PASSWORD=<staff-password>",
        "ADMIN_PASSWORD=changeme",
        "ADMIN_PASSWORD=",
        "password: your-password-here",
        "api_key: example-key-1234567890",
        "DATABASE_URL=postgres://reader:${DB_PASSWORD}@db.internal/gracie",
        "DATABASE_URL=postgres://reader:<password>@db.internal/gracie",
        "Authorization: Bearer ${ADMIN_TOKEN}",
        "Authorization: Bearer <token>",
        "Authorization: Bearer token-from-login-response",
        "psql \"${TRUTH_DB_DSN}\" -At -c 'select 1'",
        "primary_key: smart_log_event_id",
        "idempotency_key: Idempotency-Key",
        "ssl_key: ./certs/server-key-2024.pem",
        "credential_env: STAFF_PASSWORD",
        "kind: password",
        "secret: true",
        "GRACIE_BASE_URL=http://localhost:3001",
        "origin = http://localhost:8080",
        "request_id: 0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
        "monkey: bananas123456",
        "AUTH_TOKEN_HEADER: X-Auth-Token-Value",
        "token: required",
        "keyboard_shortcut: ctrl+k",
    ],
)
def test_placeholders_and_harmless_text_pass(line: str) -> None:
    assert patterns(line) == []


def test_excerpt_is_redacted_and_keeps_context() -> None:
    hits = scan_text("env.template", f"DATABASE_URL=postgres://reader:{DSN_PASSWORD}@db/gracie")
    assert len(hits) == 1
    assert DSN_PASSWORD not in hits[0].excerpt
    assert hits[0].excerpt == f"DATABASE_URL=postgres://reader:{REDACTION}@db/gracie"


@pytest.mark.parametrize(
    "secret", [AWS_KEY, OPENAI_KEY, GITHUB_TOKEN, SLACK_TOKEN, JWT, REAL_LOOKING_VALUE]
)
def test_no_hit_excerpt_leaks_the_secret(secret: str) -> None:
    for line in (f"x = {secret}", f"SOME_TOKEN={secret}", f"Authorization: Bearer {secret}"):
        for hit in scan_text("f", line):
            assert secret not in hit.excerpt


def test_excerpt_is_truncated() -> None:
    line = f"{'a ' * 400} password: {REAL_LOOKING_VALUE}"
    hit = scan_text("f", line)[0]
    assert len(hit.excerpt) < 200


def test_hits_carry_one_based_line_numbers_and_paths() -> None:
    text = f"line one\nline two\nPASSWORD={REAL_LOOKING_VALUE}\n"
    hits = scan_files({"seeds/reset.sh": text.encode(), "README.md": b"clean\n"})
    assert [(hit.path, hit.line) for hit in hits] == [("seeds/reset.sh", 3)]


def test_rejection_error_follows_the_contract() -> None:
    files = {
        "env.template": f"AWS_KEY={AWS_KEY}\n".encode(),
        "manifest.yaml": b"schema: x\n",
    }
    with pytest.raises(ApiError) as caught:
        reject_secrets(files)
    error = caught.value
    assert error.status_code == 422
    assert error.code == "bundle_contains_secret"
    detail = error.details[0]
    assert detail.loc == ["file", "env.template", 1]
    assert detail.code == "aws_access_key"
    assert AWS_KEY not in detail.message
    assert REDACTION in detail.message
    assert AWS_KEY not in error.message


def test_clean_files_are_accepted() -> None:
    reject_secrets({"a.txt": b"nothing to see\n", "b.yaml": b"token: ${ADMIN_TOKEN}\n"})


def test_number_of_reported_hits_is_bounded() -> None:
    text = "\n".join(f"KEY_{index}_SECRET={REAL_LOOKING_VALUE}" for index in range(200))
    with pytest.raises(ApiError) as caught:
        reject_secrets({"env.template": text.encode()})
    assert len(caught.value.details) == MAX_REPORTED_HITS


def test_one_line_with_two_patterns_reports_both() -> None:
    line = f"x: {AWS_KEY} Bearer {REAL_LOOKING_VALUE}"
    assert sorted(patterns(line)) == ["aws_access_key", "bearer_token"]


def test_a_known_token_assigned_to_a_secret_name_is_reported_once() -> None:
    assert patterns(f"ADMIN_TOKEN={GITHUB_TOKEN}") == ["github_token"]
    assert patterns(f"password: {OPENAI_KEY}") == ["api_secret_key"]
