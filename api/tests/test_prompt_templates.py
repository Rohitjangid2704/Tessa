import hashlib
import importlib.util
import re
from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import delete, inspect, select, update
from sqlalchemy.exc import IntegrityError

from tessa_api.db.models import PromptTemplateRow
from tessa_api.schemas.enums import PromptTemplateName
from tessa_api.services.prompt_composer import template_variables
from tests.support import API_ROOT

PROMPTS_DIRECTORY = API_ROOT / "prompts"
MIGRATIONS_DIRECTORY = API_ROOT / "alembic" / "versions"
MIGRATION_PATH = MIGRATIONS_DIRECTORY / "0004_seed_prompt_templates.py"
SEEDING_MIGRATIONS = (
    "0004_seed_prompt_templates",
    "0011_seed_explain_template",
    "0012_seed_author_template",
    "0015_seed_mutants_hooks_templates",
    "0017_seed_discovery_v2_template",
    "0020_seed_propose_template",
)
SHIPPED_VERSIONS = {
    ("author", 1),
    ("discovery", 1),
    ("discovery", 2),
    ("explain", 1),
    ("fixup", 1),
    ("hooks", 1),
    ("mutants", 1),
    ("propose", 1),
}
CURRENT_VERSIONS = {
    "author": 1,
    "discovery": 2,
    "explain": 1,
    "fixup": 1,
    "hooks": 1,
    "mutants": 1,
    "propose": 1,
}
UNSHIPPED_DISCOVERY_VERSION = 3
LINE_FEED = chr(10)
CARRIAGE_RETURN_LINE_FEED = chr(13) + chr(10)
TEMPLATE_FILE_NAME = re.compile(r"^(?P<name>[a-z]+)\.v(?P<version>[1-9][0-9]*)\.md$")

SHIPPED_FILES = {
    path.name.split(".")[0]: path
    for path in sorted(PROMPTS_DIRECTORY.glob("*.md"))
    if path.name.endswith(".v1.md")
}


def shipped_text(name: str) -> str:
    return SHIPPED_FILES[name].read_bytes().decode("utf-8")


def shipped_version_text(name: str, version: int) -> str:
    return (PROMPTS_DIRECTORY / f"{name}.v{version}.md").read_bytes().decode("utf-8")


def load_module(path: Path) -> ModuleType:
    specification = importlib.util.spec_from_file_location(f"seed_{path.stem}", path)
    assert specification is not None
    assert specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def load_migration() -> ModuleType:
    return load_module(MIGRATION_PATH)


def templates_of(module: ModuleType) -> tuple[Any, ...]:
    shipped: tuple[Any, ...] = getattr(module, "SHIPPED_TEMPLATES", ())
    if shipped:
        return shipped
    return (module.DISCOVERY_V2,)


def seeded_templates() -> list[tuple[ModuleType, Any]]:
    seeded: list[tuple[ModuleType, Any]] = []
    for stem in SEEDING_MIGRATIONS:
        module = load_module(MIGRATIONS_DIRECTORY / f"{stem}.py")
        seeded.extend((module, template) for template in templates_of(module))
    return seeded


def template_files() -> dict[tuple[str, int], Path]:
    files: dict[tuple[str, int], Path] = {}
    for path in sorted(PROMPTS_DIRECTORY.iterdir()):
        match = TEMPLATE_FILE_NAME.match(path.name)
        assert match is not None, f"{path.name} is not named <template>.v<version>.md"
        files[(match.group("name"), int(match.group("version")))] = path
    return files


def test_every_template_file_is_named_after_a_known_template_and_a_version() -> None:
    files = template_files()
    assert set(files) == SHIPPED_VERSIONS
    assert {name for name, _ in files} == {name.value for name in PromptTemplateName}
    assert {name for name, _ in files} == set(CURRENT_VERSIONS)


@pytest.mark.parametrize("key", sorted(SHIPPED_VERSIONS))
def test_template_files_are_lf_utf8_and_end_with_a_newline(key: tuple[str, int]) -> None:
    raw = template_files()[key].read_bytes()
    assert b"\r" not in raw
    assert raw.endswith(b"\n")
    assert not raw.endswith(b"\n\n")
    raw.decode("utf-8")


def test_the_seeding_migrations_pin_the_sha256_of_every_shipped_file() -> None:
    pinned = {
        (template.name, template.version): template.sha256 for _, template in seeded_templates()
    }
    assert set(pinned) == set(template_files())
    for (name, version), digest in pinned.items():
        text = shipped_version_text(name, version)
        assert hashlib.sha256(text.encode("utf-8")).hexdigest() == digest, (
            f"{name} v{version} changed after it shipped: restore it, or ship a new version "
            "with a migration that flips is_current"
        )


def test_the_seeding_migrations_declare_the_placeholders_each_file_uses() -> None:
    for _, template in seeded_templates():
        text = shipped_version_text(template.name, template.version)
        assert list(template.variables) == template_variables(text), template.name


def test_the_migration_refuses_a_changed_shipped_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migration = load_migration()
    (tmp_path / "discovery.v1.md").write_bytes(b"changed")
    monkeypatch.setattr(migration, "PROMPTS_DIRECTORY", tmp_path)
    with pytest.raises(RuntimeError, match="changed after it shipped"):
        migration.read_shipped_text(migration.SHIPPED_TEMPLATES[0])


def test_every_seeding_migration_normalises_windows_line_endings_before_hashing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for module, template in seeded_templates():
        text = shipped_version_text(template.name, template.version)
        crlf = text.replace(LINE_FEED, CARRIAGE_RETURN_LINE_FEED)
        (tmp_path / template.path.name).write_bytes(crlf.encode("utf-8"))
        monkeypatch.setattr(module, "PROMPTS_DIRECTORY", tmp_path)
        assert module.read_shipped_text(template) == text


TemplateRows = list[dict[str, Any]]
TEMPLATE_ATTRIBUTES = tuple(attribute.key for attribute in inspect(PromptTemplateRow).column_attrs)


async def template_rows(app: FastAPI) -> TemplateRows:
    async with app.state.session_factory() as session:
        rows = (await session.scalars(select(PromptTemplateRow))).all()
        return [{key: getattr(row, key) for key in TEMPLATE_ATTRIBUTES} for row in rows]


async def restore_template_rows(app: FastAPI, rows: TemplateRows) -> None:
    async with app.state.session_factory() as session:
        await session.execute(delete(PromptTemplateRow))
        session.add_all(PromptTemplateRow(**values) for values in rows)
        await session.commit()


@pytest.fixture
async def restore_shipped_templates(db_app: FastAPI) -> AsyncIterator[None]:
    rows = await template_rows(db_app)
    yield
    await restore_template_rows(db_app, rows)


@pytest.mark.integration
async def test_template_files_match_the_database_rows(db_app: FastAPI) -> None:
    async with db_app.state.session_factory() as session:
        rows = (await session.scalars(select(PromptTemplateRow))).all()
    stored = {(row.name.value, row.version): row for row in rows}
    files = template_files()
    assert set(stored) == set(files)
    for (name, version), path in files.items():
        row = stored[(name, version)]
        assert row.text == path.read_bytes().decode("utf-8"), f"{path.name} differs from its row"
        assert row.variables == template_variables(row.text)
        assert row.is_current is (CURRENT_VERSIONS[name] == version), path.name


@pytest.mark.integration
async def test_exactly_one_version_per_template_is_current(db_app: FastAPI) -> None:
    async with db_app.state.session_factory() as session:
        rows = (await session.scalars(select(PromptTemplateRow))).all()
    current = {row.name.value: row.version for row in rows if row.is_current}
    assert current == CURRENT_VERSIONS


@pytest.mark.integration
@pytest.mark.usefixtures("restore_shipped_templates")
async def test_a_second_current_version_of_one_template_is_rejected_by_the_database(
    db_app: FastAPI,
) -> None:
    async with db_app.state.session_factory() as session:
        session.add(
            PromptTemplateRow(
                name=PromptTemplateName.discovery,
                version=UNSHIPPED_DISCOVERY_VERSION,
                text="v3",
                variables=[],
                is_current=True,
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()


@pytest.mark.integration
@pytest.mark.usefixtures("restore_shipped_templates")
async def test_a_new_version_flips_is_current_without_touching_the_shipped_rows(
    db_app: FastAPI,
) -> None:
    async with db_app.state.session_factory() as session:
        await session.execute(
            update(PromptTemplateRow)
            .where(PromptTemplateRow.name == PromptTemplateName.discovery)
            .values(is_current=False)
        )
        session.add(
            PromptTemplateRow(
                name=PromptTemplateName.discovery,
                version=UNSHIPPED_DISCOVERY_VERSION,
                text="v3",
                variables=[],
                is_current=True,
            )
        )
        await session.commit()
    async with db_app.state.session_factory() as session:
        shipped = (
            await session.scalars(
                select(PromptTemplateRow)
                .where(
                    PromptTemplateRow.name == PromptTemplateName.discovery,
                    PromptTemplateRow.version != UNSHIPPED_DISCOVERY_VERSION,
                )
                .order_by(PromptTemplateRow.version)
            )
        ).all()
    assert [row.version for row in shipped] == [1, 2]
    for row in shipped:
        assert row.text == shipped_version_text("discovery", row.version)
        assert row.is_current is False
