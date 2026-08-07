import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import timedelta
from pathlib import Path

import httpx
from sqlalchemy import text
from temporalio.service import ConnectConfig, ServiceClient

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import DependencyStatus
from tessa_api.schemas.health import DependencyCheck, DependencyHealth
from tessa_api.settings import Settings

CHECK_TIMEOUT_SECONDS = 2.0

Probe = Callable[[], Awaitable[str | None]]


async def probe_database(session_factory: SessionFactory) -> str | None:
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
    return None


async def probe_temporal(address: str) -> str | None:
    client = await ServiceClient.connect(ConnectConfig(target_host=address))
    serving = await client.check_health(timeout=timedelta(seconds=CHECK_TIMEOUT_SECONDS))
    if not serving:
        raise RuntimeError("workflow service is not serving")
    return None


def write_probe_file(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    probe = data_dir / f".write-probe-{uuid.uuid4().hex}"
    probe.write_bytes(b"ok")
    probe.unlink()


async def probe_storage(data_dir: Path) -> str | None:
    await asyncio.to_thread(write_probe_file, data_dir)
    return "writable"


async def probe_laya(url: str) -> str | None:
    async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_SECONDS) as client:
        response = await client.get(url)
    return f"HTTP {response.status_code}"


async def run_check(probe: Probe) -> DependencyCheck:
    started = time.perf_counter()
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
            detail = await probe()
    except TimeoutError:
        return DependencyCheck(
            status=DependencyStatus.down,
            latency_ms=None,
            detail=f"timed out after {CHECK_TIMEOUT_SECONDS:g}s",
        )
    except Exception as error:
        return DependencyCheck(
            status=DependencyStatus.down,
            latency_ms=None,
            detail=type(error).__name__,
        )
    return DependencyCheck(
        status=DependencyStatus.up,
        latency_ms=round((time.perf_counter() - started) * 1000),
        detail=detail,
    )


def unconfigured(detail: str) -> DependencyCheck:
    return DependencyCheck(status=DependencyStatus.unconfigured, latency_ms=None, detail=detail)


async def check_dependencies(
    settings: Settings, session_factory: SessionFactory
) -> DependencyHealth:
    async def database() -> str | None:
        return await probe_database(session_factory)

    async def temporal() -> str | None:
        return await probe_temporal(settings.temporal_address)

    async def laya() -> str | None:
        return await probe_laya(settings.laya_url)

    async def laya_check() -> DependencyCheck:
        if not settings.laya_url:
            return unconfigured("TESSA_LAYA_URL is empty")
        return await run_check(laya)

    async def storage() -> str | None:
        return await probe_storage(settings.data_dir)

    db_check, temporal_check, laya_result, storage_check = await asyncio.gather(
        run_check(database), run_check(temporal), laya_check(), run_check(storage)
    )
    return DependencyHealth(
        db=db_check,
        temporal=temporal_check,
        laya=laya_result,
        storage=storage_check,
    )
