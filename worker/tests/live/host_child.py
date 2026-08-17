import asyncio
import json
import sys
from pathlib import Path

from tessa_api.schemas.common import Viewport
from tessa_worker.adapters.browser_host import BrowserHost, BrowserHostConfig


async def main(data_dir: Path) -> None:
    host = BrowserHost(BrowserHostConfig(max_contexts=2, headless=True, data_dir=data_dir))
    await host.start()
    await host.acquire(Viewport(width=800, height=600))
    print(json.dumps({"browser_pid": host.browser_pid, "owner": host.owner.key}), flush=True)
    await asyncio.sleep(600)


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
