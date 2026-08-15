import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit

from pydantic import JsonValue
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, OracleResultRow, OracleTemplateRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest, TruthSource
from tessa_api.schemas.enums import OracleLanguage, OracleResultStatus
from tessa_api.schemas.oracles import GoldPoint
from tessa_api.schemas.temporal import ExecuteOracleQueryResult, RenderExpectedSentenceResult
from tessa_api.services.oracle_params import validate_oracle_params
from tessa_api.services.vault import Vault
from tessa_worker.adapters.auth import ResolvedEnvironment, load_environment
from tessa_worker.adapters.errors import AdapterError
from tessa_worker.adapters.redact import Redactor
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.oracle_errors import OracleExecutionError, OracleFailureCode
from tessa_worker.truth.oracle_models import OracleExecution, OracleLimits, OracleRequest
from tessa_worker.truth.oracle_rendering import evaluate_gold_points, render_sentence
from tessa_worker.truth.oracle_runner import execute_oracle
from tessa_worker.truth.sandbox import RenderError

logger = logging.getLogger("tessa_worker.truth.oracle")

ERROR_TEXT_LIMIT = 1000
POLL_INTERVAL_SECONDS = 0.5
SENTENCE_ERROR_PREFIX = "the sentence template failed: "
DATABASE_KIND = "database"
PASSWORD_SUFFIX = "_PASSWORD"


@dataclass(frozen=True, slots=True)
class OracleSubject:
    template: OracleTemplateRow
    manifest: BundleManifest
    environment: ResolvedEnvironment = field(repr=False)


@dataclass(frozen=True, slots=True)
class Attempt:
    execution: OracleExecution | None
    error: str | None


@dataclass(frozen=True, slots=True)
class OracleOutcome:
    result_id: uuid.UUID
    status: OracleResultStatus
    rows: list[dict[str, JsonValue]]
    rows_truncated: bool
    sentence: str | None
    error: str | None


def outcome_of(row: OracleResultRow) -> OracleOutcome:
    return OracleOutcome(
        result_id=row.id,
        status=row.status,
        rows=[dict(item) for item in row.rows],
        rows_truncated=row.rows_truncated,
        sentence=row.sentence,
        error=row.error,
    )


def clipped(text: str) -> str:
    return text if len(text) <= ERROR_TEXT_LIMIT else text[: ERROR_TEXT_LIMIT - 3] + "..."


def find_truth_source(manifest: BundleManifest, source_id: str | None) -> TruthSource:
    if source_id is not None:
        found = next((item for item in manifest.truth_sources if item.id == source_id), None)
        if found is None:
            raise OracleExecutionError(
                OracleFailureCode.unsupported_source,
                f"the bundle declares no truth source {source_id!r}",
            )
        return found
    if len(manifest.truth_sources) == 1:
        return manifest.truth_sources[0]
    raise OracleExecutionError(
        OracleFailureCode.unsupported_source,
        "the oracle names no truth source and the bundle does not declare exactly one",
    )


def dsn_redactor(environment: ResolvedEnvironment, source: TruthSource) -> Redactor:
    redactor = environment.new_redactor()
    found = environment.get(source.connection_env)
    password = urlsplit(found.value).password if found is not None else None
    if password:
        redactor.register(source.connection_env + PASSWORD_SUFFIX, password)
    return redactor


def redactor_for(subject: OracleSubject) -> Redactor:
    try:
        source = find_truth_source(subject.manifest, subject.template.truth_source)
    except OracleExecutionError:
        return subject.environment.new_redactor()
    return dsn_redactor(subject.environment, source)


def resolved_params(
    subject: OracleSubject, params: Mapping[str, JsonValue]
) -> dict[str, JsonValue]:
    try:
        substituted = subject.environment.substitute_json(dict(params))
    except AdapterError as error:
        raise OracleExecutionError(OracleFailureCode.environment_missing, str(error)) from None
    if not isinstance(substituted, dict):
        raise OracleExecutionError(OracleFailureCode.parameter_invalid, "params must be an object")
    problems = validate_oracle_params(subject.template.params_schema, substituted)
    if problems:
        first = problems[0]
        where = ".".join(str(part) for part in first.loc) or "params"
        raise OracleExecutionError(
            OracleFailureCode.parameter_invalid, f"parameter {where}: {first.message}"
        )
    return substituted


class OracleService:
    def __init__(
        self, session_factory: SessionFactory, vault: Vault, settings: WorkerSettings
    ) -> None:
        self.session_factory = session_factory
        self.vault = vault
        self.limits = OracleLimits(settings.oracle_statement_timeout_ms, settings.oracle_max_rows)

    async def find_template(
        self, session: AsyncSession, bundle_id: uuid.UUID, name: str
    ) -> OracleTemplateRow | None:
        return await session.scalar(
            select(OracleTemplateRow).where(
                OracleTemplateRow.bundle_id == bundle_id, OracleTemplateRow.name == name
            )
        )

    async def load_subject(self, template: OracleTemplateRow) -> OracleSubject:
        async with self.session_factory() as session:
            bundle = await session.get(BundleRow, template.bundle_id)
            if bundle is None or bundle.manifest is None:
                raise OracleExecutionError(
                    OracleFailureCode.not_found, "the bundle of the oracle has no readable manifest"
                )
            environment = await load_environment(session, self.vault, template.target_id)
        return OracleSubject(template, BundleManifest.model_validate(bundle.manifest), environment)

    def prepare_request(
        self, subject: OracleSubject, params: Mapping[str, JsonValue]
    ) -> OracleRequest:
        template = subject.template
        source = find_truth_source(subject.manifest, template.truth_source)
        if source.kind != DATABASE_KIND:
            raise OracleExecutionError(
                OracleFailureCode.unsupported_source,
                f"truth source {source.id} is a {source.kind}; only databases are supported",
            )
        if template.language is OracleLanguage.sql and not template.read_only_verified:
            raise OracleExecutionError(
                OracleFailureCode.not_read_only,
                "the oracle lint could not prove this query read-only, so it is not executed",
            )
        try:
            dsn = subject.environment.require(source.connection_env)
        except AdapterError as error:
            raise OracleExecutionError(OracleFailureCode.environment_missing, str(error)) from None
        return OracleRequest(
            language=template.language,
            source=template.source,
            dialect=source.dialect,
            dsn=dsn,
            params=resolved_params(subject, params),
            limits=self.limits,
        )

    async def attempt(self, subject: OracleSubject, params: Mapping[str, JsonValue]) -> Attempt:
        redactor = redactor_for(subject)
        try:
            return Attempt(await execute_oracle(self.prepare_request(subject, params)), None)
        except OracleExecutionError as error:
            return Attempt(None, clipped(redactor.redact_text(error.message)))
        except Exception as error:
            logger.exception("oracle_attempt_crashed")
            return Attempt(None, clipped(redactor.redact_text(f"{type(error).__name__}: {error}")))

    async def create_result(
        self, template_id: uuid.UUID, params: Mapping[str, JsonValue], run_id: uuid.UUID | None
    ) -> uuid.UUID:
        async with self.session_factory() as session:
            row = OracleResultRow(
                oracle_template_id=template_id,
                run_id=run_id,
                params=dict(params),
                status=OracleResultStatus.pending,
                rows=[],
                rows_truncated=False,
            )
            session.add(row)
            await session.commit()
            return row.id

    async def persist_attempt(self, result_id: uuid.UUID, attempt: Attempt) -> None:
        execution = attempt.execution
        values: dict[str, object] = {"executed_at": datetime.now(UTC)}
        if execution is None:
            values.update(status=OracleResultStatus.error, error=attempt.error, rows=[])
        else:
            values.update(
                rows=execution.rows,
                rows_truncated=execution.rows_truncated,
                duration_ms=execution.duration_ms,
                error=None,
            )
        async with self.session_factory() as session:
            await session.execute(
                update(OracleResultRow).where(OracleResultRow.id == result_id).values(**values)
            )
            await session.commit()

    async def read_result(self, result_id: uuid.UUID) -> tuple[OracleResultRow, OracleTemplateRow]:
        async with self.session_factory() as session:
            result = await session.get(OracleResultRow, result_id)
            if result is None:
                raise OracleExecutionError(OracleFailureCode.not_found, "oracle result not found")
            template = await session.get(OracleTemplateRow, result.oracle_template_id)
            if template is None:
                raise OracleExecutionError(OracleFailureCode.not_found, "oracle template not found")
            return result, template

    async def execute(self, oracle_result_id: uuid.UUID) -> ExecuteOracleQueryResult:
        result, template = await self.read_result(oracle_result_id)
        try:
            subject = await self.load_subject(template)
        except OracleExecutionError as error:
            attempt = Attempt(None, clipped(error.message))
        else:
            attempt = await self.attempt(subject, result.params)
        await self.persist_attempt(oracle_result_id, attempt)
        execution = attempt.execution
        return ExecuteOracleQueryResult(
            status=OracleResultStatus.ok if execution else OracleResultStatus.error,
            row_count=len(execution.rows) if execution else 0,
            rows_truncated=execution.rows_truncated if execution else False,
            duration_ms=execution.duration_ms if execution else 0,
            error=attempt.error,
        )

    async def finish_result(
        self,
        result_id: uuid.UUID,
        status: OracleResultStatus,
        sentence: str | None,
        error: str | None,
    ) -> None:
        async with self.session_factory() as session:
            await session.execute(
                update(OracleResultRow)
                .where(OracleResultRow.id == result_id)
                .values(status=status, sentence=sentence, error=error)
            )
            await session.commit()

    async def render(self, oracle_result_id: uuid.UUID) -> RenderExpectedSentenceResult:
        result, template = await self.read_result(oracle_result_id)
        if result.status is OracleResultStatus.error:
            return RenderExpectedSentenceResult(sentence=None, error=result.error)
        redactor = Redactor()
        try:
            subject = await self.load_subject(template)
            redactor = redactor_for(subject)
            params = resolved_params(subject, result.params)
            rendered = await asyncio.to_thread(
                render_sentence, template.sentence_template, result.rows, params
            )
            sentence = redactor.redact_text(rendered)
        except (OracleExecutionError, RenderError) as error:
            message = clipped(redactor.redact_text(SENTENCE_ERROR_PREFIX + error.message))
            await self.finish_result(oracle_result_id, OracleResultStatus.error, None, message)
            return RenderExpectedSentenceResult(sentence=None, error=message)
        await self.finish_result(oracle_result_id, OracleResultStatus.ok, sentence, None)
        return RenderExpectedSentenceResult(sentence=sentence, error=None)

    async def fail(self, oracle_result_id: uuid.UUID, message: str) -> None:
        async with self.session_factory() as session:
            await session.execute(
                update(OracleResultRow)
                .where(
                    OracleResultRow.id == oracle_result_id,
                    OracleResultRow.status == OracleResultStatus.pending,
                )
                .values(
                    status=OracleResultStatus.error,
                    error=clipped(message),
                    executed_at=datetime.now(UTC),
                )
            )
            await session.commit()

    async def gold_points_of(
        self,
        template: OracleTemplateRow,
        params: Mapping[str, JsonValue],
        outcome: OracleOutcome,
    ) -> list[GoldPoint]:
        subject = await self.load_subject(template)
        redactor = redactor_for(subject)
        points = await asyncio.to_thread(
            evaluate_gold_points,
            template.gold_points,
            outcome.rows,
            resolved_params(subject, params),
            outcome.result_id,
        )
        return [
            point.model_copy(
                update={
                    "value": redactor.redact_json(point.value),
                    "rendered": redactor.redact_text(point.rendered),
                }
            )
            for point in points
        ]

    async def settled_outcome(self, result_id: uuid.UUID) -> OracleOutcome:
        result, _ = await self.read_result(result_id)
        return outcome_of(result)

    async def run_fresh(
        self, template: OracleTemplateRow, params: Mapping[str, JsonValue], run_id: uuid.UUID | None
    ) -> OracleOutcome:
        return await self.run_polling(template, params, run_id, None, 0.0)

    async def run_polling(
        self,
        template: OracleTemplateRow,
        params: Mapping[str, JsonValue],
        run_id: uuid.UUID | None,
        satisfied: Callable[[OracleExecution], bool] | None,
        retry_for_seconds: float,
        interval_seconds: float = POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> OracleOutcome:
        result_id = await self.create_result(template.id, params, run_id)
        try:
            subject = await self.load_subject(template)
        except OracleExecutionError as error:
            await self.persist_attempt(result_id, Attempt(None, clipped(error.message)))
            return await self.settled_outcome(result_id)
        deadline = monotonic() + retry_for_seconds
        while True:
            attempt = await self.attempt(subject, params)
            execution = attempt.execution
            if execution is None or satisfied is None or satisfied(execution):
                break
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            await sleep(min(interval_seconds, remaining))
        await self.persist_attempt(result_id, attempt)
        if attempt.execution is not None:
            await self.finish_result(result_id, OracleResultStatus.ok, None, None)
        return await self.settled_outcome(result_id)
