import argparse
import asyncio
import json
import sys

import httpx

from tessa_api.services.hello import LAYA_SMOKE_TEXT
from tessa_worker.activities.laya import call_laya_smoke
from tessa_worker.settings import load_settings


def parse_arguments(arguments: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call Laya once with one noul question and print the LayaSmokeResult as JSON"
    )
    parser.add_argument("--url", help="Laya base URL; default TESSA_LAYA_URL from worker/.env")
    parser.add_argument(
        "--timeout",
        type=float,
        help="seconds; default TESSA_LAYA_TIMEOUT_SECONDS from worker/.env",
    )
    parser.add_argument("--text", default=LAYA_SMOKE_TEXT, help="state text sent to Laya")
    parser.add_argument(
        "--repeat", type=int, default=1, help="number of calls; prints one line each"
    )
    return parser.parse_args(arguments)


async def run(arguments: argparse.Namespace) -> int:
    url: str | None = arguments.url
    timeout: float | None = arguments.timeout
    if url is None or timeout is None:
        settings = load_settings()
        url = url if url is not None else settings.laya_url
        timeout = timeout if timeout is not None else float(settings.laya_timeout_seconds)
    all_ok = True
    async with httpx.AsyncClient() as http:
        for _ in range(arguments.repeat):
            result = await call_laya_smoke(http, url.rstrip("/"), arguments.text, timeout)
            all_ok = all_ok and result.ok
            print(json.dumps(result.model_dump(mode="json")))
    return 0 if all_ok else 1


def main() -> None:
    sys.exit(asyncio.run(run(parse_arguments(sys.argv[1:]))))


if __name__ == "__main__":
    main()
