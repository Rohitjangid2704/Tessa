import argparse
import asyncio
import base64
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from core_loop import API_PREFIX, BROWSER_SCENARIO_KEY, mint_dev_token
from websockets.asyncio.client import ClientConnection, connect

JPEG_MAGIC = b"\xff\xd8"
ZIP_MAGIC = b"PK"
TERMINAL_EVENT = "run.finished"


@dataclass
class FrameTally:
    events: int = 0
    frames: int = 0
    valid_jpegs: int = 0
    sessions: set[str] = field(default_factory=set)
    subscribed: set[str] = field(default_factory=set)
    page_urls: set[str] = field(default_factory=set)
    finished: bool = False


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Start a run of the smoke browser scenario on a target set up by core_loop.py, "
            "subscribe to its live tile on the run WebSocket and check that frames arrive and "
            "that a recording and a trace per step are stored."
        )
    )
    parser.add_argument("--target-id", required=True)
    parser.add_argument(
        "--api-url",
        default=os.environ.get("TESSA_SMOKE_API_URL", "http://127.0.0.1:8000"),
    )
    parser.add_argument(
        "--email",
        default=os.environ.get("TESSA_SMOKE_EMAIL", "admin@tessa.local"),
    )
    parser.add_argument("--timeout", type=float, default=600.0)
    return parser.parse_args()


def browser_scenario_id(client: httpx.Client, target_id: str) -> str:
    page = client.get(
        "/scenarios",
        params={"target_id": target_id, "origin": "authored", "limit": 100},
    ).json()
    for item in page["items"]:
        detail = client.get(f"/scenarios/{item['id']}").json()
        if (detail.get("parsed") or {}).get("id") == BROWSER_SCENARIO_KEY:
            return str(item["id"])
    raise SystemExit(f"target {target_id} has no scenario {BROWSER_SCENARIO_KEY}")


async def subscribe(connection: ClientConnection, tally: FrameTally) -> None:
    tiles = [
        {"browser_session_id": session, "mode": "focus"}
        for session in sorted(tally.sessions)
    ]
    await connection.send(
        json.dumps({"type": "tile.subscribe", "payload": {"tiles": tiles}})
    )
    tally.subscribed = set(tally.sessions)


async def handle(
    connection: ClientConnection, message: dict[str, Any], tally: FrameTally
) -> None:
    kind = message.get("type")
    payload = message.get("payload") or {}
    if kind == "tile.frame":
        tally.frames += 1
        if base64.b64decode(payload["data_b64"])[:2] == JPEG_MAGIC:
            tally.valid_jpegs += 1
        if payload.get("page_url"):
            tally.page_urls.add(str(payload["page_url"]))
        ack = {
            "browser_session_id": payload["browser_session_id"],
            "frame_seq": payload["frame_seq"],
        }
        await connection.send(json.dumps({"type": "tile.ack", "payload": ack}))
        return
    tally.events += 1
    if kind == "browser_session.started":
        tally.sessions.add(str(payload["browser_session_id"]))
        await subscribe(connection, tally)
    elif kind == TERMINAL_EVENT:
        tally.finished = True


async def watch(ws_url: str, timeout: float) -> FrameTally:
    tally = FrameTally()
    async with asyncio.timeout(timeout), connect(f"{ws_url}&last_seq=0") as connection:
        async for raw in connection:
            text = raw if isinstance(raw, str) else raw.decode("utf-8")
            await handle(connection, json.loads(text), tally)
            if tally.finished:
                break
    return tally


def stored_evidence(
    client: httpx.Client, run_id: str
) -> tuple[list[dict[str, Any]], int, int]:
    sessions = client.get(f"/runs/{run_id}/browser-sessions").json()["items"]
    items = client.get(f"/runs/{run_id}/scenarios").json()["items"]
    steps_total = 0
    steps_with_trace = 0
    for item in items:
        detail = client.get(f"/run-scenarios/{item['id']}").json()
        for summary in detail["steps"]:
            step = client.get(f"/steps/{summary['id']}").json()
            steps_total += 1
            traces = [a for a in step.get("artifacts") or [] if a["kind"] == "trace"]
            if (
                traces
                and client.get(traces[0]["url"].removeprefix(API_PREFIX)).content[:2]
                == ZIP_MAGIC
            ):
                steps_with_trace += 1
    return sessions, steps_total, steps_with_trace


def main() -> int:
    arguments = parse_arguments()
    token = os.environ.get("TESSA_SMOKE_TOKEN") or mint_dev_token(arguments.email)
    client = httpx.Client(
        base_url=arguments.api_url.rstrip("/") + API_PREFIX,
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    scenario_id = browser_scenario_id(client, arguments.target_id)
    response = client.post(
        "/runs",
        headers={"Idempotency-Key": f"smoke-{uuid.uuid4()}"},
        json={
            "target_id": arguments.target_id,
            "scenario_ids": [scenario_id],
            "reset_seed": True,
        },
    )
    if response.status_code != 202:
        print(f"FAIL run start {response.status_code}: {response.text[:400]}")
        return 1
    run_id = response.json()["run_id"]
    ticket = client.post("/ws-tickets", json={"run_id": run_id}).json()
    begun = time.monotonic()
    tally = asyncio.run(watch(ticket["ws_url"], arguments.timeout))
    run = client.get(f"/runs/{run_id}").json()
    sessions, steps_total, steps_with_trace = stored_evidence(client, run_id)
    recordings = sum(1 for session in sessions if session["has_recording"])
    print(
        f"run {run_id} {run['status']} in {time.monotonic() - begun:.0f}s: {tally.events} events, "
        f"{len(tally.sessions)} browser sessions, {tally.frames} tile frames "
        f"({tally.valid_jpegs} JPEG) from {sorted(tally.page_urls)}, "
        f"{recordings} of {len(sessions)} sessions recorded, "
        f"{steps_with_trace} of {steps_total} steps with a downloadable trace"
    )
    checks = {
        "run completed": run["status"] == "completed",
        "a browser session started": bool(tally.sessions),
        "frames reached the run WebSocket": tally.frames > 0
        and tally.valid_jpegs == tally.frames,
        "every session has a recording": bool(sessions) and recordings == len(sessions),
        "every step has a trace": steps_total > 0 and steps_with_trace == steps_total,
    }
    for name, passed in checks.items():
        print(f"{'ok  ' if passed else 'FAIL'} {name}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
