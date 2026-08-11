import uuid
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from tessa_api.db.models import (
    JudgeResultRow,
    LabelRow,
    OracleResultRow,
    OracleTemplateRow,
    ProbeResultRow,
    RunRow,
    SeedRow,
    StepRow,
    User,
)
from tessa_api.schemas.enums import (
    Effort,
    InvariantPack,
    JudgeFamily,
    LabelSource,
    LabelSubjectType,
    LabelValue,
    OracleApproval,
    OracleLanguage,
    OracleResultStatus,
    ProbeEngine,
    ProbeStatus,
    SeedHashSource,
    SeedResetStatus,
    UserRole,
)
from tessa_api.settings import Settings
from tests.stage_one import create_target, insert_bundle, sample_manifest
from tests.support import AuthHeaders, MakeUser
from tests.test_stage_two_database import CollectedTable, collect, persist

pytestmark = pytest.mark.integration

EXPECTED_COLUMNS: dict[str, set[str]] = {
    "seeds": {
        "id",
        "target_id",
        "bundle_id",
        "version",
        "declared_hash",
        "hash_source",
        "reset_script_path",
        "hash_command",
        "material_sha256",
        "observed_hash",
        "last_reset_at",
        "last_reset_status",
        "last_reset_run_id",
    },
    "oracle_templates": {
        "id",
        "bundle_id",
        "target_id",
        "name",
        "feature_ids",
        "language",
        "source",
        "params_schema",
        "sentence_template",
        "read_only_verified",
        "approval",
        "truth_source",
        "gold_points",
    },
    "oracle_results": {
        "id",
        "oracle_template_id",
        "run_id",
        "params",
        "status",
        "rows",
        "rows_truncated",
        "sentence",
        "error",
        "duration_ms",
        "executed_at",
        "created_at",
    },
    "probe_results": {
        "id",
        "step_id",
        "run_id",
        "probe_id",
        "pack",
        "question",
        "answer",
        "status",
        "confidence",
        "threshold",
        "latency_ms",
        "probe_bank_version",
        "engine",
    },
    "judge_results": {
        "id",
        "step_id",
        "run_id",
        "family",
        "model",
        "effort",
        "rubric_version",
        "verdict",
        "pairwise",
        "evidence",
        "cost_usd",
        "created_at",
    },
    "labels": {
        "id",
        "subject_type",
        "subject_id",
        "value",
        "source",
        "note",
        "labeled_by",
        "labeled_at",
    },
}

NULLABLE_COLUMNS: dict[str, set[str]] = {
    "seeds": {
        "declared_hash",
        "reset_script_path",
        "hash_command",
        "observed_hash",
        "last_reset_at",
        "last_reset_status",
        "last_reset_run_id",
    },
    "oracle_templates": {"truth_source"},
    "oracle_results": {
        "run_id",
        "sentence",
        "error",
        "duration_ms",
        "executed_at",
    },
    "probe_results": {"answer"},
    "judge_results": {"pairwise"},
    "labels": {"note", "labeled_by"},
}

UNIQUE_COLUMNS: dict[str, set[tuple[str, ...]]] = {
    "seeds": {("target_id", "version")},
    "oracle_templates": {("bundle_id", "name")},
    "labels": {("subject_type", "subject_id", "source", "labeled_by")},
}

EXPECTED_INDEXES: dict[str, dict[str, list[str]]] = {
    "oracle_results": {
        "ix_oracle_results_oracle_template_id_created_at": ["oracle_template_id", "created_at"]
    },
    "probe_results": {
        "ix_probe_results_step_id": ["step_id"],
        "ix_probe_results_run_id_probe_id": ["run_id", "probe_id"],
    },
    "judge_results": {"ix_judge_results_step_id": ["step_id"]},
    "labels": {"ix_labels_subject_type_subject_id": ["subject_type", "subject_id"]},
}

ON_DELETE: dict[str, dict[str, str | None]] = {
    "seeds": {"targets": None, "bundles": None, "runs": "SET NULL"},
    "oracle_templates": {"bundles": None, "targets": None},
    "oracle_results": {"oracle_templates": "CASCADE", "runs": "SET NULL"},
    "probe_results": {"steps": "CASCADE", "runs": "CASCADE"},
    "judge_results": {"steps": "CASCADE", "runs": "CASCADE"},
    "labels": {"users": None},
}


@pytest.mark.parametrize("table", sorted(EXPECTED_COLUMNS))
async def test_a_table_has_exactly_the_contract_columns(
    settings: Settings, migrated_database: None, table: str
) -> None:
    collected = await collect(settings, table)
    assert set(collected["columns"]) == EXPECTED_COLUMNS[table]


@pytest.mark.parametrize("table", sorted(NULLABLE_COLUMNS))
async def test_nullability_follows_the_contract(
    settings: Settings, migrated_database: None, table: str
) -> None:
    columns = (await collect(settings, table))["columns"]
    nullable = {name for name, column in columns.items() if column["nullable"]}
    assert nullable == NULLABLE_COLUMNS[table]


@pytest.mark.parametrize("table", sorted(UNIQUE_COLUMNS))
async def test_unique_constraints_exist(
    settings: Settings, migrated_database: None, table: str
) -> None:
    collected = await collect(settings, table)
    found = {tuple(constraint["column_names"]) for constraint in collected["unique"]}
    assert UNIQUE_COLUMNS[table] <= found


@pytest.mark.parametrize("table", sorted(EXPECTED_INDEXES))
async def test_the_plan_indexes_exist(
    settings: Settings, migrated_database: None, table: str
) -> None:
    indexes = {index["name"]: index for index in (await collect(settings, table))["indexes"]}
    for name, columns in EXPECTED_INDEXES[table].items():
        assert indexes[name]["column_names"] == columns


@pytest.mark.parametrize("table", sorted(ON_DELETE))
async def test_the_foreign_keys_cascade_or_clear_as_designed(
    settings: Settings, migrated_database: None, table: str
) -> None:
    def rules(collected: CollectedTable) -> dict[str, str | None]:
        return {
            key["referred_table"]: key["options"].get("ondelete")
            for key in collected["foreign_keys"]
        }

    assert rules(await collect(settings, table)) == ON_DELETE[table]


async def test_the_oracle_history_index_sorts_newest_first(
    settings: Settings, migrated_database: None
) -> None:
    indexes = {
        index["name"]: index for index in (await collect(settings, "oracle_results"))["indexes"]
    }
    index = indexes["ix_oracle_results_oracle_template_id_created_at"]
    assert index["column_sorting"] == {"created_at": ("desc",)}


async def test_steps_gain_the_stage_three_and_four_columns(
    settings: Settings, migrated_database: None
) -> None:
    columns = (await collect(settings, "steps"))["columns"]
    assert {"gold_points", "db_checks", "evidence"} <= set(columns)
    assert columns["gold_points"]["nullable"] is False
    assert columns["db_checks"]["nullable"] is False
    assert columns["evidence"]["nullable"] is True


async def test_the_labels_unique_constraint_does_not_distinguish_nulls(
    settings: Settings, migrated_database: None
) -> None:
    unique = (await collect(settings, "labels"))["unique"]
    [constraint] = [
        item
        for item in unique
        if item["column_names"] == ["subject_type", "subject_id", "source", "labeled_by"]
    ]
    assert constraint["dialect_options"]["postgresql_nulls_not_distinct"] is True


async def test_probe_results_default_the_engine_to_laya(
    settings: Settings, migrated_database: None
) -> None:
    columns = (await collect(settings, "probe_results"))["columns"]
    assert "laya" in str(columns["engine"]["default"])


@pytest.fixture
async def chain(
    db_app: FastAPI,
    client: httpx.AsyncClient,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
) -> dict[str, Any]:
    user: User = await make_user(UserRole.member)
    target = await create_target(client, auth_headers(user))
    bundle = await insert_bundle(db_app, target["id"], user.id, sample_manifest())
    return {
        "app": db_app,
        "user_id": user.id,
        "target_id": uuid.UUID(target["id"]),
        "bundle_id": bundle.id,
    }


async def add_rows(chain: dict[str, Any], *rows: Any) -> None:
    async with chain["app"].state.session_factory() as session:
        session.add_all(rows)
        await session.commit()


def seed_row(chain: dict[str, Any], version: int = 1) -> SeedRow:
    return SeedRow(
        target_id=chain["target_id"],
        bundle_id=chain["bundle_id"],
        version=version,
        hash_source=SeedHashSource.first_reset,
        material_sha256="a" * 64,
    )


def template_row(chain: dict[str, Any], name: str = "open_maintenance") -> OracleTemplateRow:
    return OracleTemplateRow(
        bundle_id=chain["bundle_id"],
        target_id=chain["target_id"],
        name=name,
        feature_ids=["smart_log.read.open_maintenance"],
        language=OracleLanguage.sql,
        source="select 1",
        params_schema={"type": "object", "properties": {}},
        sentence_template="{{ rows | length }}",
    )


async def test_a_seed_round_trips_with_its_defaults(chain: dict[str, Any]) -> None:
    row = seed_row(chain)
    await add_rows(chain, row)
    async with chain["app"].state.session_factory() as session:
        stored = await session.get(SeedRow, row.id)
    assert stored is not None
    assert stored.hash_source is SeedHashSource.first_reset
    assert (stored.declared_hash, stored.observed_hash, stored.last_reset_status) == (
        None,
        None,
        None,
    )
    assert stored.last_reset_at is None


async def test_a_seed_keeps_the_outcome_of_its_last_reset(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    row = seed_row(chain)
    row.declared_hash = "sha256:abcd1234"
    row.observed_hash = "sha256:abcd1234"
    row.last_reset_status = SeedResetStatus.ok
    row.last_reset_run_id = rows["run"].id
    await add_rows(chain, row)
    async with chain["app"].state.session_factory() as session:
        stored = await session.get(SeedRow, row.id)
        assert stored is not None
        assert stored.last_reset_status is SeedResetStatus.ok
        run = await session.get(RunRow, rows["run"].id)
        assert run is not None
        await session.delete(run)
        await session.commit()
        await session.refresh(stored)
    assert stored.last_reset_run_id is None


async def test_a_target_has_one_seed_per_version(chain: dict[str, Any]) -> None:
    await add_rows(chain, seed_row(chain, 1), seed_row(chain, 2))
    async with chain["app"].state.session_factory() as session:
        session.add(seed_row(chain, 2))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_a_template_defaults_to_unreviewed_and_names_are_unique_per_bundle(
    chain: dict[str, Any],
) -> None:
    template = template_row(chain)
    await add_rows(chain, template)
    async with chain["app"].state.session_factory() as session:
        stored = await session.get(OracleTemplateRow, template.id)
        assert stored is not None
        assert stored.approval is OracleApproval.unreviewed
        assert stored.read_only_verified is False
        assert stored.gold_points == []
        assert stored.truth_source is None
        session.add(template_row(chain))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_oracle_results_keep_rows_and_follow_their_template_and_run(
    chain: dict[str, Any],
) -> None:
    rows = await persist(chain)
    template = template_row(chain)
    await add_rows(chain, template)
    result = OracleResultRow(
        oracle_template_id=template.id,
        run_id=rows["run"].id,
        params={"tenant_id": "t"},
        status=OracleResultStatus.ok,
        rows=[{"room": "204", "n": 3}],
        sentence="1 room",
        duration_ms=12,
    )
    pending = OracleResultRow(
        oracle_template_id=template.id,
        params={},
        status=OracleResultStatus.pending,
    )
    await add_rows(chain, result, pending)
    async with chain["app"].state.session_factory() as session:
        stored = await session.get(OracleResultRow, result.id)
        waiting = await session.get(OracleResultRow, pending.id)
        assert stored is not None
        assert waiting is not None
        assert stored.rows == [{"room": "204", "n": 3}]
        assert stored.rows_truncated is False
        assert stored.created_at.tzinfo is not None
        assert (waiting.rows, waiting.executed_at, waiting.sentence) == ([], None, None)
        run = await session.get(RunRow, rows["run"].id)
        assert run is not None
        await session.delete(run)
        await session.commit()
        await session.refresh(stored)
        assert stored.run_id is None
        stored_template = await session.get(OracleTemplateRow, template.id)
        assert stored_template is not None
        await session.delete(stored_template)
        await session.commit()
        count = await session.scalar(select(func.count()).select_from(OracleResultRow))
    assert count == 0


async def test_steps_default_gold_points_db_checks_and_evidence(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    async with chain["app"].state.session_factory() as session:
        step = await session.get(StepRow, rows["step"].id)
        assert step is not None
        assert (step.gold_points, step.db_checks, step.evidence) == ([], [], None)
        step.gold_points = [{"key": "open_count", "value": 2}]
        step.evidence = {"ask": "q", "answer": "a"}
        await session.commit()
        await session.refresh(step)
    assert step.gold_points == [{"key": "open_count", "value": 2}]
    assert step.evidence == {"ask": "q", "answer": "a"}


async def test_probe_and_judge_results_follow_their_step(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    probe = ProbeResultRow(
        step_id=rows["step"].id,
        run_id=rows["run"].id,
        probe_id="no_internal_ids",
        pack=InvariantPack.generic,
        question="Does the answer show an internal identifier?",
        status=ProbeStatus.decided,
        confidence=0.91,
        threshold=0.75,
        latency_ms=210,
        probe_bank_version="abc",
    )
    judge = JudgeResultRow(
        step_id=rows["step"].id,
        run_id=rows["run"].id,
        family=JudgeFamily.openai,
        model="gpt-6.1-sol",
        effort=Effort.low,
        rubric_version="judge.v1",
        verdict={"status": "fail", "tier": "judge"},
        evidence={"gold_points": [], "must_not_claim": [], "unsupported_claims": []},
        cost_usd=Decimal("0.0043219"),
    )
    await add_rows(chain, probe, judge)
    async with chain["app"].state.session_factory() as session:
        stored_probe = await session.get(ProbeResultRow, probe.id)
        stored_judge = await session.get(JudgeResultRow, judge.id)
        assert stored_probe is not None
        assert stored_probe.engine is ProbeEngine.laya
        assert stored_probe.answer is None
        assert stored_probe.confidence == pytest.approx(0.91)
        assert stored_judge is not None
        assert stored_judge.pairwise is None
        assert stored_judge.cost_usd == Decimal("0.004322")
        step = await session.get(StepRow, rows["step"].id)
        assert step is not None
        await session.delete(step)
        await session.commit()
        for model in (ProbeResultRow, JudgeResultRow):
            assert await session.scalar(select(func.count()).select_from(model)) == 0


async def test_deleting_a_run_removes_its_grading_rows(chain: dict[str, Any]) -> None:
    rows = await persist(chain)
    await add_rows(
        chain,
        ProbeResultRow(
            step_id=rows["step"].id,
            run_id=rows["run"].id,
            probe_id="p",
            pack=InvariantPack.llm_app,
            question="q",
            status=ProbeStatus.error,
            confidence=0.0,
            threshold=0.75,
            latency_ms=1,
            probe_bank_version="v",
        ),
    )
    async with chain["app"].state.session_factory() as session:
        run = await session.get(RunRow, rows["run"].id)
        assert run is not None
        await session.delete(run)
        await session.commit()
        assert await session.scalar(select(func.count()).select_from(ProbeResultRow)) == 0


def label_row(
    subject_id: uuid.UUID,
    labeled_by: uuid.UUID | None,
    source: LabelSource,
    subject_type: LabelSubjectType = LabelSubjectType.judge_result,
) -> LabelRow:
    return LabelRow(
        subject_type=subject_type,
        subject_id=subject_id,
        value=LabelValue.fail,
        source=source,
        labeled_by=labeled_by,
    )


async def test_a_weak_label_without_a_labeler_still_dedupes(chain: dict[str, Any]) -> None:
    subject = uuid.uuid4()
    await add_rows(chain, label_row(subject, None, LabelSource.judge_weak))
    async with chain["app"].state.session_factory() as session:
        session.add(label_row(subject, None, LabelSource.judge_weak))
        with pytest.raises(IntegrityError):
            await session.commit()


async def test_one_label_per_subject_and_labeler_but_other_labelers_and_subjects_are_free(
    chain: dict[str, Any],
) -> None:
    subject = uuid.uuid4()
    other_subject = uuid.uuid4()
    user_id = chain["user_id"]
    await add_rows(chain, label_row(subject, user_id, LabelSource.human))
    async with chain["app"].state.session_factory() as session:
        session.add(label_row(subject, user_id, LabelSource.human))
        with pytest.raises(IntegrityError):
            await session.commit()
    await add_rows(
        chain,
        label_row(subject, None, LabelSource.judge_weak),
        label_row(other_subject, user_id, LabelSource.human),
        label_row(subject, user_id, LabelSource.human, LabelSubjectType.step),
    )
    async with chain["app"].state.session_factory() as session:
        count = await session.scalar(select(func.count()).select_from(LabelRow))
    assert count == 4


async def test_a_label_round_trips_with_its_defaults(chain: dict[str, Any]) -> None:
    row = label_row(uuid.uuid4(), chain["user_id"], LabelSource.human, LabelSubjectType.step)
    await add_rows(chain, row)
    async with chain["app"].state.session_factory() as session:
        stored = await session.get(LabelRow, row.id)
    assert stored is not None
    assert stored.value is LabelValue.fail
    assert stored.subject_type is LabelSubjectType.step
    assert stored.note is None
    assert stored.labeled_at.tzinfo is not None
