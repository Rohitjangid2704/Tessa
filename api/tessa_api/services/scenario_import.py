import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, CoverageCellRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.enums import CoverageUpdateReason, ScenarioStatus
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.scenarios import ScenarioIssue
from tessa_api.schemas.streams import IngestEvent
from tessa_api.services.cell_status import CellChange
from tessa_api.services.coverage import find_baseline_plan
from tessa_api.services.coverage_events import coverage_updated_events, scenario_changed_event
from tessa_api.services.scenario_library import scenario_view_for_bundle
from tessa_api.services.scenario_lifecycle import (
    ProvenanceInput,
    ScenarioWrite,
    ValidScenario,
    complete_dry_runs,
    lifecycle_events,
    prompt_issue_for,
    resolve_edit_cell,
    upsert_authored_in_cell,
)
from tessa_api.services.scenario_validator import (
    MAX_SCENARIO_BYTES,
    ScenarioBundleView,
    validate_scenario_text,
)
from tessa_api.services.storage import BundleStore
from tessa_api.settings import Settings

SCENARIO_FOLDER = "scenarios/"
YAML_SUFFIXES = (".yaml", ".yml")
MAX_WARNINGS = 100
MAX_ISSUES_PER_FILE = 10
UNCHANGED = "unchanged"
DRY_RUN_SKIPPED = "dry_run_skipped"

CellResolver = Callable[[AsyncSession, ValidScenario], Awaitable[uuid.UUID | None]]


@dataclass(frozen=True, slots=True)
class ImportedScenario:
    scenario_id: uuid.UUID
    path: str
    outcome: str
    status: ScenarioStatus


@dataclass(frozen=True, slots=True)
class AuthoredLink:
    scenario_id: uuid.UUID
    feature_id: str | None
    interface_id: str | None
    prompt_issue_id: uuid.UUID


@dataclass(slots=True)
class ScenarioImport:
    imported: list[ImportedScenario] = field(default_factory=list)
    unchanged: int = 0
    rejected: int = 0
    warnings: list[BundleValidationError] = field(default_factory=list)
    changes: list[CellChange] = field(default_factory=list)
    events: list[IngestEvent] = field(default_factory=list)
    authored_links: list[AuthoredLink] = field(default_factory=list)

    @property
    def scenario_ids(self) -> list[uuid.UUID]:
        return [item.scenario_id for item in self.imported]

    @property
    def awaiting_dry_run(self) -> list[uuid.UUID]:
        return [
            item.scenario_id for item in self.imported if item.status is ScenarioStatus.validating
        ]


def scenario_paths(files: Mapping[str, bytes]) -> list[str]:
    return sorted(
        path
        for path in files
        if path.startswith(SCENARIO_FOLDER) and path.lower().endswith(YAML_SUFFIXES)
    )


def authored_key_of(document: ScenarioDoc, path: str) -> str:
    return document.id if document.id is not None else path


def api_cell_resolver(
    settings: Settings, target: TargetRow, bundle: BundleRow, owner_id: uuid.UUID
) -> CellResolver:
    async def resolve(session: AsyncSession, valid: ValidScenario) -> uuid.UUID | None:
        return await resolve_edit_cell(session, settings, target, bundle, valid, owner_id)

    return resolve


def stored_cell_resolver(target: TargetRow, bundle: BundleRow) -> CellResolver:
    async def resolve(session: AsyncSession, valid: ValidScenario) -> uuid.UUID | None:
        document = valid.document
        if document.feature_id is None:
            return None
        plan = await find_baseline_plan(session, target.id, bundle.id)
        if plan is None:
            return None
        return await session.scalar(
            select(CoverageCellRow.id).where(
                CoverageCellRow.plan_id == plan.id,
                CoverageCellRow.feature_id == document.feature_id,
                CoverageCellRow.role == document.role,
                CoverageCellRow.interface_id == document.interface_id,
            )
        )

    return resolve


def file_warning(
    path: str,
    code: str,
    message: str,
    pointer: str | None = None,
    line: int | None = None,
    column: int | None = None,
) -> BundleValidationError:
    return BundleValidationError(
        code=code,
        message=message,
        severity="warning",
        file=path,
        pointer=pointer,
        line=line,
        column=column,
    )


def issue_warning(path: str, issue: ScenarioIssue) -> BundleValidationError:
    return file_warning(path, issue.code, issue.message, issue.pointer, issue.line, issue.column)


def api_error_warning(path: str, error: ApiError) -> BundleValidationError:
    code = error.details[0].code if error.details else error.code
    return file_warning(path, code, error.message)


class ScenarioImporter:
    def __init__(
        self,
        session: AsyncSession,
        target: TargetRow,
        bundle: BundleRow,
        user_id: uuid.UUID,
        view: ScenarioBundleView,
        resolve_cell: CellResolver,
    ) -> None:
        self.session = session
        self.target = target
        self.bundle = bundle
        self.user_id = user_id
        self.view = view
        self.resolve_cell = resolve_cell
        self.result = ScenarioImport()
        self.seen_keys: dict[str, str] = {}
        self.suppressed = 0

    def warn(self, warning: BundleValidationError) -> None:
        if len(self.result.warnings) >= MAX_WARNINGS:
            self.suppressed += 1
            return
        self.result.warnings.append(warning)

    def reject(self, warning: BundleValidationError) -> None:
        self.result.rejected += 1
        self.warn(warning)

    def reject_invalid(self, path: str, issues: list[ScenarioIssue]) -> None:
        count = len(issues)
        first = issues[0].message if issues else "the file is empty"
        self.reject(
            file_warning(
                path,
                "scenario_rejected",
                f"The scenario was not imported: {count} error(s), first: {first}",
            )
        )
        for issue in issues[:MAX_ISSUES_PER_FILE]:
            self.warn(issue_warning(path, issue))

    async def import_file(self, path: str, content: bytes) -> None:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            self.reject(
                file_warning(path, "scenario_unreadable", "The file is not valid UTF-8 text")
            )
            return
        check = validate_scenario_text(text, self.view, MAX_SCENARIO_BYTES)
        if not check.validation.valid or check.document is None or check.parsed is None:
            self.reject_invalid(path, check.validation.errors)
            return
        await self.import_valid(
            path, ValidScenario(text, check.document, check.parsed, check.validation)
        )

    async def import_valid(self, path: str, valid: ValidScenario) -> None:
        document = valid.document
        if document.synthetic:
            self.reject(
                file_warning(
                    path,
                    "synthetic_not_allowed",
                    "Synthetic scenarios are created by Tessa, not imported",
                    "/synthetic",
                )
            )
            return
        key = authored_key_of(document, path)
        if key in self.seen_keys:
            self.reject(
                file_warning(
                    path,
                    "duplicate_scenario_id",
                    f"The scenario id {key!r} is already used by {self.seen_keys[key]} in this "
                    "upload; the file was not imported",
                    "/id",
                )
            )
            return
        self.seen_keys[key] = path
        self.note_conventions(path, document)
        issue_id = await self.known_prompt_issue(path, document)
        provenance = ProvenanceInput(
            prompt_issue_id=issue_id,
            details={"source_path": path, "source_bundle_version": self.bundle.version},
        )
        note = f"Imported from {path} of bundle version {self.bundle.version}"
        cell_id = await self.resolve_cell(self.session, valid)
        try:
            write, outcome = await upsert_authored_in_cell(
                self.session,
                self.target,
                self.bundle,
                cell_id,
                key,
                valid,
                self.user_id,
                provenance,
                note,
            )
        except ApiError as error:
            self.reject(api_error_warning(path, error))
            return
        self.record(path, write, outcome)
        if issue_id is not None and outcome != UNCHANGED:
            self.result.authored_links.append(
                AuthoredLink(
                    scenario_id=write.row.id,
                    feature_id=document.feature_id,
                    interface_id=document.interface_id,
                    prompt_issue_id=issue_id,
                )
            )

    def note_conventions(self, path: str, document: ScenarioDoc) -> None:
        if document.feature_id is not None and not path.startswith(
            f"{SCENARIO_FOLDER}{document.feature_id}/"
        ):
            self.warn(
                file_warning(
                    path,
                    "scenario_path_convention",
                    f"Scenario files belong at tessa/{SCENARIO_FOLDER}{document.feature_id}/"
                    "<slug>.yaml",
                )
            )

    async def known_prompt_issue(self, path: str, document: ScenarioDoc) -> uuid.UUID | None:
        if document.authored_from is None:
            return None
        found = await prompt_issue_for(self.session, self.target.id, document.authored_from)
        if found is None:
            self.warn(
                file_warning(
                    path,
                    "authored_from_unknown",
                    f"authored_from {document.authored_from} is not a prompt issue of this target",
                    "/authored_from",
                )
            )
        return found

    def record(self, path: str, write: ScenarioWrite, outcome: str) -> None:
        if outcome == UNCHANGED:
            self.result.unchanged += 1
            return
        self.result.imported.append(ImportedScenario(write.row.id, path, outcome, write.row.status))
        self.result.changes.extend(write.changes)
        self.result.events.append(
            scenario_changed_event(write.row.id, write.row.status, write.row.cell_id)
        )

    def finish(self) -> ScenarioImport:
        if self.suppressed:
            self.result.warnings.append(
                file_warning(
                    SCENARIO_FOLDER.rstrip("/"),
                    "scenario_warnings_truncated",
                    f"{self.suppressed} more scenario warning(s) were left out",
                )
            )
        self.result.events.extend(
            coverage_updated_events(self.result.changes, CoverageUpdateReason.generated)
        )
        return self.result


async def import_authored_scenarios(
    session: AsyncSession,
    target: TargetRow,
    bundle: BundleRow,
    files: Mapping[str, bytes],
    user_id: uuid.UUID,
    resolve_cell: CellResolver,
) -> ScenarioImport:
    paths = scenario_paths(files)
    if not paths:
        return ScenarioImport()
    view = await scenario_view_for_bundle(session, target.id, bundle.id)
    importer = ScenarioImporter(session, target, bundle, user_id, view, resolve_cell)
    for path in paths:
        await importer.import_file(path, files[path])
    return importer.finish()


def skipped_issue(message: str) -> ScenarioIssue:
    return ScenarioIssue(
        code=DRY_RUN_SKIPPED, pointer=None, line=None, column=None, message=message
    )


async def settle_without_dry_runs(
    session: AsyncSession, scenario_ids: Sequence[uuid.UUID], message: str
) -> list[IngestEvent]:
    events: list[IngestEvent] = []
    for scenario_id in scenario_ids:
        write = await complete_dry_runs(session, scenario_id, [], [skipped_issue(message)])
        events.extend(lifecycle_events(write, CoverageUpdateReason.generated))
    return events


async def read_stored_scenario_files(store: BundleStore, bundle: BundleRow) -> dict[str, bytes]:
    if bundle.storage_path is None:
        return {}
    files: dict[str, bytes] = {}
    for entry in bundle.files:
        path = str(entry.get("path", ""))
        if not (path.startswith(SCENARIO_FOLDER) and path.lower().endswith(YAML_SUFFIXES)):
            continue
        content = await store.read(bundle.storage_path, path, MAX_SCENARIO_BYTES + 1)
        if content is not None:
            files[path] = content
    return files
