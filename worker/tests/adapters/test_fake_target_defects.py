import httpx

from tests.fake_target.app import DIRTY_FILTER_DEFECT, create_app
from tests.fake_target.dataset import MANAGER_TOKEN

AUTHORIZATION = {"Authorization": f"Bearer {MANAGER_TOKEN}"}


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="http://fake.test"
    )


async def dirty_room_numbers(session: httpx.AsyncClient) -> list[str]:
    response = await session.get("/api/rooms", params={"status": "dirty"}, headers=AUTHORIZATION)
    assert response.status_code == 200
    return [room["number"] for room in response.json()["items"]]


async def test_no_defect_is_on_by_default_and_the_filter_works() -> None:
    async with client() as session:
        defects = (await session.get("/qa/defects")).json()
        assert defects == {"enabled": [], "known": [DIRTY_FILTER_DEFECT]}
        assert await dirty_room_numbers(session) == ["20002", "20003", "20005"]


async def test_the_dirty_filter_defect_returns_every_room_until_switched_off() -> None:
    async with client() as session:
        switched_on = await session.put(
            f"/qa/defects/{DIRTY_FILTER_DEFECT}", json={"enabled": True}
        )
        assert switched_on.json()["enabled"] == [DIRTY_FILTER_DEFECT]
        assert len(await dirty_room_numbers(session)) == 8
        await session.put(f"/qa/defects/{DIRTY_FILTER_DEFECT}", json={"enabled": False})
        assert await dirty_room_numbers(session) == ["20002", "20003", "20005"]


async def test_an_unknown_defect_is_refused() -> None:
    async with client() as session:
        response = await session.put("/qa/defects/nothing", json={"enabled": True})
    assert response.status_code == 404
