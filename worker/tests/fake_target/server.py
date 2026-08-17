import socket
import threading
import time
from types import TracebackType
from typing import Self

import uvicorn
from fastapi import FastAPI

from tests.fake_target.app import FakeTargetState, create_app

DEFAULT_HOST = "127.0.0.1"
START_TIMEOUT_SECONDS = 15.0
STOP_TIMEOUT_SECONDS = 15.0
POLL_SECONDS = 0.02


class RunningTarget:
    def __init__(self, app: FastAPI | None = None, host: str = DEFAULT_HOST, port: int = 0) -> None:
        self.app = app if app is not None else create_app()
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.bind((host, port))
        self.host = host
        self.port = int(self._listener.getsockname()[1])
        self._server = uvicorn.Server(
            uvicorn.Config(self.app, log_level="warning", lifespan="off", access_log=False)
        )
        self._thread = threading.Thread(
            target=self._server.run, kwargs={"sockets": [self._listener]}, daemon=True
        )

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def state(self) -> FakeTargetState:
        state: FakeTargetState = self.app.state.fake
        return state

    def start(self) -> None:
        self._thread.start()
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while not self._server.started:
            if not self._thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("the fake target did not start")
            time.sleep(POLL_SECONDS)

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=STOP_TIMEOUT_SECONDS)
        self._listener.close()

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(
        self,
        error_type: type[BaseException] | None,
        error: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.stop()
