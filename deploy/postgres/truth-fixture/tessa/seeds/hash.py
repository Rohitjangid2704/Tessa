import asyncio
import hashlib
import json
import os

import asyncpg

QUERIES = {
    "rooms": "SELECT id, number, floor, status FROM rooms ORDER BY id",
    "issues": "SELECT id, room_id, description, status, created_at FROM issues ORDER BY id",
}
HASH_LENGTH = 32


async def read_state() -> dict[str, list[list[str]]]:
    connection = await asyncpg.connect(os.environ["TRUTH_DB_DSN"])
    try:
        return {
            name: [[str(value) for value in row.values()] for row in await connection.fetch(query)]
            for name, query in QUERIES.items()
        }
    finally:
        await connection.close()


def main() -> None:
    state = asyncio.run(read_state())
    digest = hashlib.sha256(json.dumps(state, sort_keys=True).encode("utf-8"))
    print(digest.hexdigest()[:HASH_LENGTH])


main()
