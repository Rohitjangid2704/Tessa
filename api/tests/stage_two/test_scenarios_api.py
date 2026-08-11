import uuid
from typing import Any

import httpx
import pytest
import yaml
from fastapi import FastAPI
from sqlalchemy import select, update

from tessa_api.db.models import CoverageCellRow, EnvironmentRow, ScenarioRow
from tessa_api.schemas.enums import CellStatus
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.services.plans import expand_plan_cells
from tessa_api.services.scenario_library import validate_stored_scenario
from tessa_api.services.smoke_generator import SmokeGeneration, generate_smoke_scenarios
from tessa_api.services.storage import bundle_store_from_settings
from tests.bundle_fixtures import gracie_like, mutate_manifest
from tests.bundles.support import upload_zip
from tests.stage_one import create_target
from tests.stage_two.support import (
    CREATE_ISSUE,
    LIST_USERS,
    LOGIN_STAFF,
    OPEN_ISSUES,
    PLANS_PATH,
    SCENARIOS_PATH,
    SeededTarget,
    plan_body,
    seed_gracie,
)
from tests.zip_builder import build_zip

pytestmark = pytest.mark.integration

ALL_FEATURES = [OPEN_ISSUES, CREATE_ISSUE, LOGIN_STAFF, LIST_USERS]


async def create_plan(
    client: httpx.AsyncClient, headers: dict[str, str], seeded: SeededTarget, **overrides: Any
) -> str:
    overrides.setdefault("feature_ids", ALL_FEATURES)
    overrides.setdefault("interface_mode", "both")
    response = await client.post(
        PLANS_PATH, json=plan_body(seeded.target_id, **overrides), headers=headers
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def generate_all(app: FastAPI, plan_id: str) -> dict[tuple[str, str, str], SmokeGeneration]:
    store = bundle_store_from_settings(app.state.settings)
    results: dict[tuple[str, str, str], SmokeGeneration] = {}
    async with app.state.session_factory() as session:
        cell_ids = await expand_plan_cells(session, uuid.UUID(plan_id))
        for cell_id in cell_ids:
            cell = await session.get(CoverageCellRow, cell_id)
            assert cell is not None
            key = (cell.feature_id, cell.role, cell.interface_id)
            results[key] = await generate_smoke_scenarios(session, store, cell_id)
        await session.commit()
    return results


async def scenario_rows(app: FastAPI) -> list[ScenarioRow]:
    async with app.state.session_factory() as session:
        return list((await session.scalars(select(ScenarioRow).order_by(ScenarioRow.id))).all())


async def test_generation_creates_one_accepted_scenario_per_example_and_cell(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan_id = await create_plan(client, member_headers, seeded)
    results = await generate_all(db_app, plan_id)
    counts = {key: len(result.scenario_ids) for key, result in results.items()}
    assert counts == {
        (OPEN_ISSUES, "staff", "chat_sse"): 2,
        (OPEN_ISSUES, "staff", "browser"): 0,
        (OPEN_ISSUES, "manager", "chat_sse"): 2,
        (OPEN_ISSUES, "manager", "browser"): 0,
        (OPEN_ISSUES, "admin", "chat_sse"): 2,
        (OPEN_ISSUES, "admin", "browser"): 0,
        (CREATE_ISSUE, "staff", "chat_sse"): 1,
        (CREATE_ISSUE, "staff", "browser"): 1,
        (CREATE_ISSUE, "manager", "chat_sse"): 1,
        (CREATE_ISSUE, "manager", "browser"): 0,
        (LOGIN_STAFF, "staff", "browser"): 0,
        (LIST_USERS, "admin", "admin_api"): 1,
    }
    assert all(result.created == len(result.scenario_ids) for result in results.values())
    assert all(result.invalid == 0 for result in results.values())
    rows = await scenario_rows(db_app)
    assert len(rows) == 10
    assert {row.status.value for row in rows} == {"accepted"}
    assert {row.origin.value for row in rows} == {"bundle_example"}
    assert {row.version for row in rows} == {1}
    cells = (await client.get(f"{PLANS_PATH}/{plan_id}/cells", headers=member_headers)).json()
    by_key = {
        (cell["feature_id"], cell["role"], cell["interface_id"]): cell for cell in cells["items"]
    }
    assert by_key[(OPEN_ISSUES, "staff", "chat_sse")]["status"] == "covered"
    assert by_key[(OPEN_ISSUES, "staff", "chat_sse")]["scenario_count"] == 2
    assert by_key[(OPEN_ISSUES, "staff", "browser")]["status"] == "needs_author"
    assert by_key[(OPEN_ISSUES, "staff", "browser")]["scenario_count"] == 0
    assert by_key[(LOGIN_STAFF, "staff", "browser")]["status"] == "needs_author"
    assert by_key[(CREATE_ISSUE, "staff", "browser")]["scenario_count"] == 1


async def test_a_second_pass_and_a_second_plan_reuse_the_same_scenarios(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    first_plan = await create_plan(client, member_headers, seeded)
    first = await generate_all(db_app, first_plan)
    again = await generate_all(db_app, first_plan)
    second_plan = await create_plan(client, member_headers, seeded, name="Another")
    other = await generate_all(db_app, second_plan)
    for key, result in first.items():
        assert again[key].scenario_ids == result.scenario_ids
        assert again[key].created == 0
        assert again[key].reused == len(result.scenario_ids)
        assert other[key].scenario_ids == result.scenario_ids
        assert other[key].created == 0
    assert len(await scenario_rows(db_app)) == 10


async def test_a_scenario_is_read_with_its_yaml_parsed_form_and_provenance(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=[LIST_USERS])
    results = await generate_all(db_app, plan_id)
    scenario_id = results[(LIST_USERS, "admin", "admin_api")].scenario_ids[0]
    response = await client.get(f"{SCENARIOS_PATH}/{scenario_id}", headers=member_headers)
    assert response.status_code == 200
    scenario = response.json()
    assert scenario["id"] == str(scenario_id)
    assert scenario["target_id"] == seeded.target_id
    assert scenario["bundle_id"] == seeded.bundle_id
    assert scenario["feature_id"] == LIST_USERS
    assert scenario["family"] == "admin"
    assert scenario["origin"] == "bundle_example"
    assert scenario["status"] == "accepted"
    assert scenario["version"] == 1
    assert scenario["synthetic"] is False
    validation = scenario["validation"]
    assert (validation["valid"], validation["errors"]) == (True, [])
    assert [(item["code"], item["pointer"]) for item in validation["warnings"]] == [
        ("write_without_cleanup", "/feature_id")
    ]
    assert scenario["cell_id"] is not None
    assert scenario["created_at"].endswith("Z")
    provenance = scenario["provenance"]
    assert provenance["generator"] == "smoke"
    assert provenance["role"] == "admin"
    assert provenance["interface_id"] == "admin_api"
    assert provenance["source"] == "example"
    assert provenance["example_index"] == 0
    assert provenance["bundle_version"] == 1
    assert len(provenance["example_hash"]) == 64
    stored_document = yaml.safe_load(scenario["yaml"])
    assert stored_document["steps"][0]["request"] == {"method": "GET", "path": "/users"}
    assert ScenarioDoc.model_validate(scenario["parsed"]).role == "admin"
    step = scenario["parsed"]["steps"][0]
    assert step["adapter"] == "http"
    assert step["request"]["path"] == "/users"
    summary = (await client.get(SCENARIOS_PATH, headers=member_headers)).json()["items"][0]
    assert "yaml" not in summary
    assert "parsed" not in summary
    assert summary["synthetic"] is False


async def test_the_scenario_filters_each_narrow_the_library(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    other = await seed_gracie(client, member_headers, name="Other")
    plan_id = await create_plan(client, member_headers, seeded)
    await generate_all(db_app, plan_id)
    await generate_all(db_app, await create_plan(client, member_headers, other))

    async def ids(**params: Any) -> list[str]:
        response = await client.get(SCENARIOS_PATH, params=params, headers=member_headers)
        assert response.status_code == 200, response.text
        return [item["id"] for item in response.json()["items"]]

    assert len(await ids()) == 20
    assert len(await ids(target_id=seeded.target_id)) == 10
    assert len(await ids(target_id=seeded.target_id, feature_id=OPEN_ISSUES)) == 6
    assert len(await ids(target_id=seeded.target_id, feature_id=[OPEN_ISSUES, LIST_USERS])) == 7
    assert len(await ids(target_id=seeded.target_id, family="admin")) == 1
    assert len(await ids(target_id=seeded.target_id, family=["admin", "smart-log"])) == 10
    assert len(await ids(target_id=seeded.target_id, status="accepted")) == 10
    assert await ids(status="invalid") == []
    assert len(await ids(origin="bundle_example")) == 20
    assert await ids(origin="authored") == []
    assert len(await ids(target_id=seeded.target_id, plan_id=plan_id)) == 10
    assert len(await ids(plan_id=plan_id)) == 10
    assert await ids(plan_id=str(uuid.uuid4())) == []
    cells = (await client.get(f"{PLANS_PATH}/{plan_id}/cells", headers=member_headers)).json()
    staff_cell = next(
        cell["id"]
        for cell in cells["items"]
        if (cell["feature_id"], cell["role"], cell["interface_id"])
        == (OPEN_ISSUES, "staff", "chat_sse")
    )
    assert len(await ids(cell_id=staff_cell)) == 2
    assert len(await ids(q="maintenance")) == 18
    assert len(await ids(q="MAINTENANCE", target_id=seeded.target_id)) == 9
    assert len(await ids(q="smart_log.write")) == 6
    assert await ids(q="100%") == []


async def test_synthetic_scenarios_are_hidden_unless_asked_for(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=[LIST_USERS])
    await generate_all(db_app, plan_id)
    rows = await scenario_rows(db_app)
    async with db_app.state.session_factory() as session:
        original = rows[0]
        session.add(
            ScenarioRow(
                target_id=original.target_id,
                bundle_id=original.bundle_id,
                feature_id=None,
                title="Invariant probe",
                family="invariant",
                origin=original.origin,
                status=original.status,
                yaml="",
                parsed={**original.parsed, "synthetic": True, "feature_id": None},
                validation=original.validation,
            )
        )
        await session.commit()
    hidden = (await client.get(SCENARIOS_PATH, headers=member_headers)).json()["items"]
    assert [item["title"] == "Invariant probe" for item in hidden] == [False]
    shown = (
        await client.get(
            SCENARIOS_PATH, params={"include_synthetic": "true"}, headers=member_headers
        )
    ).json()["items"]
    assert len(shown) == 2
    synthetic = [item for item in shown if item["title"] == "Invariant probe"]
    assert synthetic[0]["synthetic"] is True


async def test_pages_sort_and_reject_unknown_keys(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await generate_all(db_app, await create_plan(client, member_headers, seeded))
    first = await client.get(
        SCENARIOS_PATH,
        params={"limit": 4, "sort": "title", "include_total": "true"},
        headers=member_headers,
    )
    assert first.json()["total"] == 10
    titles = [item["title"] for item in first.json()["items"]]
    second = await client.get(
        SCENARIOS_PATH,
        params={"limit": 4, "sort": "title", "cursor": first.json()["next_cursor"]},
        headers=member_headers,
    )
    titles += [item["title"] for item in second.json()["items"]]
    assert titles == sorted(titles)
    assert len(set(titles)) == 8
    newest = await client.get(
        SCENARIOS_PATH, params={"sort": "-created_at"}, headers=member_headers
    )
    stamps = [item["created_at"] for item in newest.json()["items"]]
    assert stamps == sorted(stamps, reverse=True)
    assert (
        await client.get(SCENARIOS_PATH, params={"bogus": "1"}, headers=member_headers)
    ).status_code == 422
    assert (
        await client.get(SCENARIOS_PATH, params={"sort": "nope"}, headers=member_headers)
    ).status_code == 422
    assert (
        await client.get(SCENARIOS_PATH, params={"status": "weird"}, headers=member_headers)
    ).status_code == 422


async def set_stale(app: FastAPI, target_id: str, name: str, stale: bool) -> None:
    async with app.state.session_factory() as session:
        await session.execute(
            update(EnvironmentRow)
            .where(EnvironmentRow.target_id == uuid.UUID(target_id), EnvironmentRow.name == name)
            .values(stale=stale)
        )
        await session.commit()


async def cell_status(client: httpx.AsyncClient, headers: dict[str, str], plan_id: str) -> str:
    cells = (await client.get(f"{PLANS_PATH}/{plan_id}/cells", headers=headers)).json()["items"]
    staff_browser = next(c for c in cells if (c["role"], c["interface_id"]) == ("staff", "browser"))
    return str(staff_browser["status"])


async def test_a_scenario_whose_variable_went_stale_is_invalid_until_the_variable_returns(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=[CREATE_ISSUE])
    first = await generate_all(db_app, plan_id)
    browser = first[(CREATE_ISSUE, "staff", "browser")]
    assert (browser.created, browser.invalid) == (1, 0)
    assert await cell_status(client, member_headers, plan_id) == "covered"
    await set_stale(db_app, seeded.target_id, "STAFF_EMAIL", True)
    async with db_app.state.session_factory() as session:
        validation = await validate_stored_scenario(session, browser.scenario_ids[0])
        await session.commit()
    assert validation.valid is False
    assert [(issue.code, issue.pointer) for issue in validation.errors] == [
        ("unknown_environment_variable", "/steps/1/value")
    ]
    assert validation.errors[0].line is not None
    stored = (
        await client.get(f"{SCENARIOS_PATH}/{browser.scenario_ids[0]}", headers=member_headers)
    ).json()
    assert stored["status"] == "invalid"
    assert stored["validation"]["valid"] is False
    again = await generate_all(db_app, plan_id)
    assert (
        again[(CREATE_ISSUE, "staff", "browser")].reused,
        again[(CREATE_ISSUE, "staff", "browser")].invalid,
    ) == (1, 1)
    assert await cell_status(client, member_headers, plan_id) == "needs_author"
    await set_stale(db_app, seeded.target_id, "STAFF_EMAIL", False)
    healed = await generate_all(db_app, plan_id)
    assert healed[(CREATE_ISSUE, "staff", "browser")].invalid == 0
    restored = (
        await client.get(f"{SCENARIOS_PATH}/{browser.scenario_ids[0]}", headers=member_headers)
    ).json()
    assert restored["status"] == "accepted"
    assert restored["validation"]["valid"] is True
    assert await cell_status(client, member_headers, plan_id) == "covered"
    assert len(await scenario_rows(db_app)) == 3


async def test_a_scenario_generated_with_a_stale_variable_is_stored_invalid(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    seeded = await seed_gracie(client, member_headers)
    await set_stale(db_app, seeded.target_id, "STAFF_PASSWORD", True)
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=[CREATE_ISSUE])
    results = await generate_all(db_app, plan_id)
    browser = results[(CREATE_ISSUE, "staff", "browser")]
    assert (browser.created, browser.invalid) == (1, 1)
    row = next(r for r in await scenario_rows(db_app) if r.id == browser.scenario_ids[0])
    assert row.status.value == "invalid"
    assert row.validation["errors"][0]["code"] == "unknown_environment_variable"
    assert row.validation["errors"][0]["pointer"] == "/steps/2/value"


async def test_a_websocket_cell_gets_no_smoke_scenario_and_needs_an_author(
    client: httpx.AsyncClient, member_headers: dict[str, str], db_app: FastAPI
) -> None:
    target = await create_target(client, member_headers, name="With websocket")
    token = str(target["target_token"])

    def add_websocket(document: dict[str, Any]) -> None:
        document["interfaces"].append({"id": "live", "kind": "websocket", "base_path": "/ws"})
        document["environment"].append(
            {
                "name": "LIVE_URL",
                "kind": "url",
                "secret": False,
                "required": True,
                "purpose": "Live socket",
                "interfaces": ["live"],
            }
        )
        document["features"].append(
            {
                "id": "live.stream.updates",
                "area": "Live",
                "kind": "stream",
                "description": "Receive live updates",
                "interfaces": ["live"],
                "roles": ["staff"],
                "examples": [{"ask": "subscribe", "expected": "updates"}],
            }
        )

    files = mutate_manifest(gracie_like(token), add_websocket)
    uploaded = await upload_zip(client, member_headers, build_zip(files, prefix="tessa/"))
    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["bundle"]["validation_status"] == "valid", uploaded.text
    seeded = SeededTarget(str(target["id"]), token, str(uploaded.json()["bundle"]["id"]))
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=["live.stream.updates"])
    results = await generate_all(db_app, plan_id)
    assert results[("live.stream.updates", "staff", "live")].scenario_ids == ()
    cells = (await client.get(f"{PLANS_PATH}/{plan_id}/cells", headers=member_headers)).json()
    assert [
        (cell["status"], cell["skip_reason"], cell["scenario_count"]) for cell in cells["items"]
    ] == [(CellStatus.needs_author.value, None, 0)]
    assert cells["items"][0]["reason"] == (
        "The bundle has no example or flow to build a smoke scenario for this cell from"
    )
    preview = (
        await client.post(
            f"{PLANS_PATH}/preview",
            json=plan_body(
                seeded.target_id, feature_ids=["live.stream.updates"], interface_mode="both"
            ),
            headers=member_headers,
        )
    ).json()
    assert preview["skipped"] == [
        {
            "feature_id": "live.stream.updates",
            "role": "staff",
            "interface_id": "live",
            "reason": "env_missing",
        }
    ]
    assert preview["scenarios_estimated"] == 0


async def test_scenario_reads_are_open_to_viewers_and_need_a_token(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    viewer_headers: dict[str, str],
    db_app: FastAPI,
) -> None:
    seeded = await seed_gracie(client, member_headers)
    plan_id = await create_plan(client, member_headers, seeded, feature_ids=[LIST_USERS])
    results = await generate_all(db_app, plan_id)
    scenario_id = results[(LIST_USERS, "admin", "admin_api")].scenario_ids[0]
    assert (
        await client.get(f"{SCENARIOS_PATH}/{scenario_id}", headers=viewer_headers)
    ).status_code == 200
    assert (await client.get(SCENARIOS_PATH, headers=viewer_headers)).status_code == 200
    assert (await client.get(f"{SCENARIOS_PATH}/{scenario_id}")).status_code == 401
    missing = await client.get(f"{SCENARIOS_PATH}/{uuid.uuid4()}", headers=viewer_headers)
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"
    assert (await client.get(f"{SCENARIOS_PATH}/nope", headers=viewer_headers)).status_code == 422
