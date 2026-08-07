import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import yaml
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import MutantRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.enums import MutantStatus
from tessa_api.schemas.mutants import MUTANTS_SIDECAR_MAX_ENTRIES, MutantFields
from tessa_api.services.manifest_loader import (
    PointerMap,
    collect_structure,
    describe_yaml_error,
    parse_single_document,
    to_json_compatible,
    to_pointer,
)
from tessa_api.services.mutant_invariants import InvariantVocabulary, vocabulary_of
from tessa_api.services.production_url import is_plain_http_address, matches_production_pattern
from tessa_api.services.scenario_import import file_warning
from tessa_api.settings import Settings

MUTANTS_FILE = "mutants.yaml"
MAX_WARNINGS = 100
MAX_ISSUES_PER_ENTRY = 10
CREATED = "created"
UPDATED = "updated"


@dataclass(frozen=True, slots=True)
class ImportedMutant:
    mutant_id: uuid.UUID
    name: str
    outcome: str


@dataclass(slots=True)
class MutantImport:
    imported: list[ImportedMutant] = field(default_factory=list)
    unchanged: int = 0
    rejected: int = 0
    warnings: list[BundleValidationError] = field(default_factory=list)


@dataclass(slots=True)
class LoadedEntries:
    items: list[Any] | None = None
    pointers: PointerMap = field(default_factory=PointerMap)
    warnings: list[BundleValidationError] = field(default_factory=list)


def mutants_file_present(files: Mapping[str, bytes]) -> bool:
    return MUTANTS_FILE in files


def unreadable(code: str, message: str, line: int | None, column: int | None) -> LoadedEntries:
    return LoadedEntries(warnings=[file_warning(MUTANTS_FILE, code, message, "", line, column)])


def load_entries(text: str) -> LoadedEntries:
    try:
        node, constructed = parse_single_document(text)
    except yaml.YAMLError as error:
        code, message, mark = describe_yaml_error(error)
        line = None if mark is None else mark.line + 1
        column = None if mark is None else mark.column + 1
        return unreadable(code, message, line, column)
    except RecursionError:
        return unreadable("yaml_too_deep", "The document is nested too deeply", None, None)
    if node is None:
        return unreadable("empty_document", "The file is empty", None, None)
    locations: dict[str, tuple[int, int]] = {
        "": (node.start_mark.line + 1, node.start_mark.column + 1)
    }
    problems: list[BundleValidationError] = []
    try:
        collect_structure(node, "", MUTANTS_FILE, locations, problems)
    except RecursionError:
        return unreadable("yaml_too_deep", "The document is nested too deeply", None, None)
    if problems:
        return LoadedEntries(
            warnings=[
                file_warning(
                    MUTANTS_FILE, item.code, item.message, item.pointer, item.line, item.column
                )
                for item in problems
            ]
        )
    if not isinstance(constructed, list):
        return unreadable(
            "mutants_not_a_list",
            "The top level must be a list with one entry per mutant",
            node.start_mark.line + 1,
            node.start_mark.column + 1,
        )
    return LoadedEntries(items=to_json_compatible(constructed), pointers=PointerMap(locations))


def mutant_marker(entry: MutantFields) -> dict[str, Any] | None:
    return None if entry.deployed_marker is None else entry.deployed_marker.model_dump(mode="json")


async def find_mutant(session: AsyncSession, target_id: uuid.UUID, name: str) -> MutantRow | None:
    return await session.scalar(
        select(MutantRow).where(MutantRow.target_id == target_id, MutantRow.name == name)
    )


class MutantImporter:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        target: TargetRow,
        user_id: uuid.UUID,
        vocabulary: InvariantVocabulary,
        pointers: PointerMap,
    ) -> None:
        self.session = session
        self.settings = settings
        self.target = target
        self.user_id = user_id
        self.vocabulary = vocabulary
        self.pointers = pointers
        self.result = MutantImport()
        self.seen_names: dict[str, int] = {}
        self.suppressed = 0

    def warn(self, code: str, message: str, pointer: str | None = None) -> None:
        if len(self.result.warnings) >= MAX_WARNINGS:
            self.suppressed += 1
            return
        location = None if pointer is None else self.pointers.locate(pointer)
        line, column = location if location is not None else (None, None)
        self.result.warnings.append(
            file_warning(MUTANTS_FILE, code, message, pointer, line, column)
        )

    def reject(self, code: str, message: str, pointer: str | None = None) -> None:
        self.result.rejected += 1
        self.warn(code, message, pointer)

    def reject_invalid(self, index: int, error: ValidationError) -> None:
        issues = error.errors()
        first = str(issues[0]["msg"]) if issues else "the entry is not valid"
        self.reject(
            "mutant_rejected",
            f"The mutant was not imported: {len(issues)} error(s), first: {first}",
            to_pointer([index]),
        )
        for issue in issues[:MAX_ISSUES_PER_ENTRY]:
            self.warn(str(issue["type"]), str(issue["msg"]), to_pointer([index, *issue["loc"]]))

    def unknown_catchers(self, index: int, entry: MutantFields) -> bool:
        positions = self.vocabulary.unknown_positions(entry.expected_catchers)
        for position in positions:
            self.warn(
                "mutant_unknown_invariant",
                f"{entry.expected_catchers[position]!r} is neither a built-in invariant nor one "
                "the bundle declares; the entry was not imported",
                to_pointer([index, "expected_catchers", position]),
            )
        if positions:
            self.result.rejected += 1
        return bool(positions)

    async def import_entry(self, index: int, raw: Any) -> None:
        try:
            entry = MutantFields.model_validate(raw)
        except ValidationError as error:
            self.reject_invalid(index, error)
            return
        if entry.name in self.seen_names:
            self.reject(
                "duplicate_mutant_name",
                f"The name {entry.name!r} is already used by entry {self.seen_names[entry.name]} "
                "of this file; the entry was not imported",
                to_pointer([index, "name"]),
            )
            return
        self.seen_names[entry.name] = index
        if not self.base_url_acceptable(index, entry) or self.unknown_catchers(index, entry):
            return
        await self.upsert(index, entry)

    def base_url_acceptable(self, index: int, entry: MutantFields) -> bool:
        if entry.base_url is None:
            return True
        pointer = to_pointer([index, "base_url"])
        if not is_plain_http_address(entry.base_url):
            self.reject(
                "mutant_base_url_invalid",
                "The base_url must be an http or https address without credentials, query or "
                "fragment",
                pointer,
            )
            return False
        if matches_production_pattern(self.settings, entry.base_url):
            self.reject(
                "mutant_production_url",
                "The base_url matches a production URL pattern; a mutant never runs there",
                pointer,
            )
            return False
        return True

    async def upsert(self, index: int, entry: MutantFields) -> None:
        row = await find_mutant(self.session, self.target.id, entry.name)
        if row is None:
            row = await self.create(entry)
            if row is not None:
                self.result.imported.append(ImportedMutant(row.id, row.name, CREATED))
                return
            row = await find_mutant(self.session, self.target.id, entry.name)
        if row is None:
            self.reject(
                "mutant_not_stored",
                "The mutant could not be stored; upload the bundle again",
                to_pointer([index]),
            )
            return
        if row.status is MutantStatus.retired:
            self.result.unchanged += 1
            self.warn(
                "mutant_retired",
                f"The mutant {entry.name!r} is retired, so the entry did not change it",
                to_pointer([index, "name"]),
            )
            return
        if apply_definition(row, entry):
            self.result.imported.append(ImportedMutant(row.id, row.name, UPDATED))
        else:
            self.result.unchanged += 1

    async def create(self, entry: MutantFields) -> MutantRow | None:
        row = MutantRow(
            target_id=self.target.id,
            name=entry.name,
            branch=entry.branch,
            description=entry.description,
            expected_catchers=list(entry.expected_catchers),
            base_url=entry.base_url,
            deployed_marker=mutant_marker(entry),
            status=MutantStatus.registered,
            last_outcome=None,
            created_by=self.user_id,
        )
        try:
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
        except IntegrityError:
            return None
        return row

    def finish(self) -> MutantImport:
        if self.suppressed:
            self.result.warnings.append(
                file_warning(
                    MUTANTS_FILE,
                    "mutant_warnings_truncated",
                    f"{self.suppressed} more mutant warning(s) were left out",
                )
            )
        return self.result


def apply_definition(row: MutantRow, entry: MutantFields) -> bool:
    changed = False
    if row.branch != entry.branch:
        row.branch = entry.branch
        changed = True
    if row.description != entry.description:
        row.description = entry.description
        changed = True
    catchers = list(entry.expected_catchers)
    if row.expected_catchers != catchers:
        row.expected_catchers = catchers
        changed = True
    marker = mutant_marker(entry)
    if marker is not None and row.deployed_marker != marker:
        row.deployed_marker = marker
        changed = True
    if entry.base_url is not None and row.base_url is None:
        row.base_url = entry.base_url
        changed = True
    return changed


async def import_mutants(
    session: AsyncSession,
    settings: Settings,
    target: TargetRow,
    manifest: BundleManifest,
    files: Mapping[str, bytes],
    user_id: uuid.UUID,
) -> MutantImport:
    content = files.get(MUTANTS_FILE)
    if content is None:
        return MutantImport()
    if len(content) > settings.bundle_max_manifest_bytes:
        return MutantImport(
            rejected=1,
            warnings=[
                file_warning(
                    MUTANTS_FILE,
                    "mutants_file_too_large",
                    f"{MUTANTS_FILE} is {len(content)} bytes, the limit is "
                    f"{settings.bundle_max_manifest_bytes}; no mutant was imported",
                )
            ],
        )
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return MutantImport(
            rejected=1,
            warnings=[
                file_warning(MUTANTS_FILE, "mutants_unreadable", "The file is not valid UTF-8 text")
            ],
        )
    loaded = load_entries(text)
    if loaded.items is None:
        return MutantImport(rejected=1, warnings=loaded.warnings)
    importer = MutantImporter(
        session, settings, target, user_id, vocabulary_of(None, manifest), loaded.pointers
    )
    if len(loaded.items) > MUTANTS_SIDECAR_MAX_ENTRIES:
        importer.warn(
            "mutants_truncated",
            f"The file lists {len(loaded.items)} mutants; only the first "
            f"{MUTANTS_SIDECAR_MAX_ENTRIES} were read",
        )
    for index, raw in enumerate(loaded.items[:MUTANTS_SIDECAR_MAX_ENTRIES]):
        await importer.import_entry(index, raw)
    return importer.finish()
