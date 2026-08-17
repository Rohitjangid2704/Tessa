import html
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from urllib.parse import parse_qs, urlsplit

from tests.browser_site.pages import (
    ANIMATED_PAGE,
    CHAT_PAGE,
    ECHO_PAGE,
    FLOOD_PAGE,
    FORM_PAGE,
    LOGIN_PAGE,
    NOISE_PAGE,
    STATIC_PAGE,
)

STATIC_PAGES = {
    "/login": LOGIN_PAGE,
    "/chat": CHAT_PAGE,
    "/animated": ANIMATED_PAGE,
    "/noise": NOISE_PAGE,
    "/static": STATIC_PAGE,
    "/form": FORM_PAGE,
    "/flood": FLOOD_PAGE,
}


class SiteHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        if parts.path == "/":
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
        elif parts.path in STATIC_PAGES:
            self.respond(200, "text/html; charset=utf-8", STATIC_PAGES[parts.path])
        elif parts.path == "/echo":
            text = parse_qs(parts.query).get("text", [""])[0]
            self.respond(
                200, "text/html; charset=utf-8", ECHO_PAGE.replace("__TEXT__", html.escape(text))
            )
        elif parts.path == "/health":
            self.respond(200, "application/json", json.dumps({"status": "ok"}))
        else:
            self.respond(404, "text/plain", "not found")

    def respond(self, status: int, content_type: str, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


class TestSite:
    __test__ = False

    def __init__(self, port: int = 0) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", port), SiteHandler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self) -> "TestSite":
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


if __name__ == "__main__":
    with TestSite(8505) as site:
        print(f"test site on {site.url}", flush=True)
        threading.Event().wait()
