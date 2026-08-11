import pytest

from tessa_api.services.env_template import (
    example_has_credentials,
    example_has_path,
    parse_env_template,
)
from tests.bundle_examples import example_text

TEMPLATE = """# Base URL of the QA deployment
GRACIE_BASE_URL=http://localhost:8080

# Password of the QA staff user
STAFF_PASSWORD=<staff-password>
ADMIN_TOKEN=<admin-api-token>  # API token of the admin role
EMPTY_ONE=
"""


def test_example_template_parses_with_purposes() -> None:
    parsed = parse_env_template(TEMPLATE)
    assert parsed.errors == []
    assert list(parsed.entries) == [
        "GRACIE_BASE_URL",
        "STAFF_PASSWORD",
        "ADMIN_TOKEN",
        "EMPTY_ONE",
    ]
    assert parsed.entries["GRACIE_BASE_URL"].purpose == "Base URL of the QA deployment"
    assert parsed.entries["GRACIE_BASE_URL"].example == "http://localhost:8080"
    assert parsed.entries["STAFF_PASSWORD"].purpose == "Password of the QA staff user"
    assert parsed.entries["ADMIN_TOKEN"].purpose == "API token of the admin role"
    assert parsed.entries["ADMIN_TOKEN"].example == "<admin-api-token>"
    assert [entry.line for entry in parsed.entries.values()] == [2, 5, 6, 7]
    assert [warning.code for warning in parsed.warnings] == ["env_template_purpose_missing"]
    assert parsed.warnings[0].line == 7


def test_the_gracie_example_has_no_problems() -> None:
    parsed = parse_env_template(example_text("gracie", "env.template"))
    assert parsed.errors == []
    assert parsed.warnings == []
    assert "TRUTH_DB_DSN" in parsed.names


def test_a_purpose_comment_applies_to_the_next_line_only() -> None:
    parsed = parse_env_template("# purpose of A\nA=1\nB=2\n")
    assert parsed.entries["A"].purpose == "purpose of A"
    assert parsed.entries["B"].purpose is None


def test_blank_line_ends_a_comment() -> None:
    parsed = parse_env_template("# floating\n\nA=1\n")
    assert parsed.entries["A"].purpose is None


@pytest.mark.parametrize(
    "line",
    [
        "lower=1",
        "NAME = value",
        "NAME=two words",
        "just text",
        "export NAME=value",
        "1NAME=value",
        "=value",
    ],
)
def test_invalid_lines_are_reported_with_their_line_number(line: str) -> None:
    parsed = parse_env_template(f"# ok\nGOOD=1\n{line}\n")
    assert [(error.code, error.line) for error in parsed.errors] == [
        ("env_template_invalid_line", 3)
    ]
    assert "GOOD" in parsed.entries


def test_duplicate_names_are_reported() -> None:
    parsed = parse_env_template("# a\nA=1\n# again\nA=2\n")
    assert [(error.code, error.line) for error in parsed.errors] == [("env_template_duplicate", 4)]
    assert parsed.entries["A"].example == "1"


def test_empty_template_has_no_entries() -> None:
    parsed = parse_env_template("")
    assert parsed.entries == {}
    assert parsed.errors == []


@pytest.mark.parametrize(
    ("example", "credentials"),
    [
        ("http://user:pass@host/", True),
        ("https://token@host", True),
        ("postgres://u:p@db/x", True),
        ("http://localhost:8080", False),
        ("<describe-it>", False),
        ("", False),
    ],
)
def test_credentials_in_url_examples_are_detected(example: str, credentials: bool) -> None:
    assert example_has_credentials(example) is credentials


@pytest.mark.parametrize(
    ("example", "has_path"),
    [
        ("http://localhost:8080/api", True),
        ("https://qa.example.test/v1/", True),
        ("http://localhost:8080", False),
        ("http://localhost:8080/", False),
        ("<url>", False),
    ],
)
def test_paths_in_url_examples_are_detected(example: str, has_path: bool) -> None:
    assert example_has_path(example) is has_path
