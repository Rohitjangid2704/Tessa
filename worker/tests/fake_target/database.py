from datetime import UTC, datetime

import asyncpg

from tests.fake_target.dataset import (
    FIRST_NEW_ISSUE_ID,
    SEED_ISSUES,
    SEED_ROOMS,
    Dataset,
    Issue,
    Room,
)

ROOMS_QUERY = "SELECT id, number, status, floor FROM rooms ORDER BY id"
ISSUES_QUERY = (
    "SELECT i.id, r.number AS room, i.description, i.status "
    "FROM issues i JOIN rooms r ON r.id = i.room_id ORDER BY i.id"
)
INSERT_ISSUE = (
    "INSERT INTO issues (id, room_id, description, status, created_at) "
    "SELECT GREATEST(COALESCE((SELECT max(id) FROM issues), 0) + 1, $3), r.id, $2, 'open', now() "
    "FROM rooms r WHERE r.number = $1 RETURNING id"
)
SEED_MONTH = (2026, 9)
SEED_HOUR = 8


class DatabaseMirror:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=4)
        return self._pool

    async def load(self) -> Dataset:
        pool = await self.pool()
        async with pool.acquire() as connection:
            rooms = await connection.fetch(ROOMS_QUERY)
            issues = await connection.fetch(ISSUES_QUERY)
        highest = max((row["id"] for row in issues), default=FIRST_NEW_ISSUE_ID - 1)
        return Dataset(
            rooms=[Room(row["number"], row["status"], row["floor"]) for row in rooms],
            issues=[
                Issue(row["id"], row["room"], row["description"], row["status"]) for row in issues
            ],
            next_issue_id=max(highest + 1, FIRST_NEW_ISSUE_ID),
        )

    async def insert_issue(self, room: str, description: str) -> Issue:
        pool = await self.pool()
        async with pool.acquire() as connection:
            issue_id = await connection.fetchval(
                INSERT_ISSUE, room, description, FIRST_NEW_ISSUE_ID
            )
        return Issue(issue_id, room, description, "open")

    async def reset(self) -> None:
        pool = await self.pool()
        async with pool.acquire() as connection, connection.transaction():
            await connection.execute("DELETE FROM issues")
            await connection.execute("DELETE FROM rooms")
            await connection.executemany(
                "INSERT INTO rooms (id, number, status, floor) VALUES ($1, $2, $3, $4)",
                [
                    (position, number, status, floor)
                    for position, (number, status, floor) in enumerate(SEED_ROOMS, start=1)
                ],
            )
            room_ids = {number: position for position, (number, _, _) in enumerate(SEED_ROOMS, 1)}
            await connection.executemany(
                "INSERT INTO issues (id, room_id, description, status, created_at) "
                "VALUES ($1, $2, $3, $4, $5)",
                [
                    (issue_id, room_ids[room], description, status, seed_created_at(day))
                    for day, (issue_id, room, description, status) in enumerate(SEED_ISSUES, 1)
                ],
            )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None


def seed_created_at(day: int) -> datetime:
    year, month = SEED_MONTH
    return datetime(year, month, day, SEED_HOUR, tzinfo=UTC)
