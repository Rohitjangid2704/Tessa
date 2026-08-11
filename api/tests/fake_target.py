import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SLOW_SECONDS = 0.4
SLEEPY_SECONDS = 3.0
STREAM_SECONDS = 3.0
STOP_POLL_SECONDS = 0.02


class TargetHandler(BaseHTTPRequestHandler):
    server: "FakeTargetServer"

    def log_message(self, format: str, *args: object) -> None:
        return None

    def respond(self, status: int, body: bytes = b"ok", content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def wait(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self.server.stopping.is_set():
            time.sleep(STOP_POLL_SECONDS)

    def do_GET(self) -> None:
        self.server.record(self.path, self.headers.get("Accept", ""))
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            return

    def route(self) -> None:
        if self.path == "/bad":
            self.respond(500, b"boom")
        elif self.path == "/missing":
            self.respond(404, b"nope")
        elif self.path == "/unavailable":
            self.respond(503, b"down")
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/chat":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(b"event: ready\ndata: {}\n\n")
            self.wfile.flush()
            self.wait(STREAM_SECONDS)
        elif self.path == "/slow":
            self.server.enter()
            try:
                self.wait(SLOW_SECONDS)
                self.respond(200)
            finally:
                self.server.leave()
        elif self.path == "/sleepy":
            self.wait(SLEEPY_SECONDS)
            self.respond(200)
        else:
            self.respond(200)


class FakeTargetServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), TargetHandler)
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.inflight = 0
        self.max_inflight = 0
        self.requests: list[tuple[str, str]] = []

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"

    def record(self, path: str, accept: str) -> None:
        with self.lock:
            self.requests.append((path, accept))

    def enter(self) -> None:
        with self.lock:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)

    def leave(self) -> None:
        with self.lock:
            self.inflight -= 1


@contextmanager
def serve_fake_target() -> Iterator[FakeTargetServer]:
    server = FakeTargetServer()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
