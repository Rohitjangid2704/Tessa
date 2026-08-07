import math
import time
from collections import deque
from collections.abc import Callable

from tessa_api.errors import ApiError

LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 60.0
PRUNE_THRESHOLD = 1024


class LoginRateLimiter:
    def __init__(
        self,
        max_failures: int = LOGIN_MAX_FAILURES,
        window_seconds: float = LOGIN_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self.clock = clock
        self.failures: dict[tuple[str, str], deque[float]] = {}

    def check(self, email: str, client_ip: str) -> None:
        recent = self.recent_failures((email.lower(), client_ip))
        if len(recent) >= self.max_failures:
            retry_after = max(1, math.ceil(recent[0] + self.window_seconds - self.clock()))
            raise ApiError(
                429,
                "rate_limited",
                "Too many failed attempts, try again later",
                headers={"Retry-After": str(retry_after)},
            )

    def record_failure(self, email: str, client_ip: str) -> None:
        if len(self.failures) > PRUNE_THRESHOLD:
            self.prune()
        key = (email.lower(), client_ip)
        self.failures.setdefault(key, deque()).append(self.clock())

    def reset(self, email: str, client_ip: str) -> None:
        self.failures.pop((email.lower(), client_ip), None)

    def recent_failures(self, key: tuple[str, str]) -> deque[float]:
        attempts = self.failures.get(key)
        if attempts is None:
            return deque()
        threshold = self.clock() - self.window_seconds
        while attempts and attempts[0] <= threshold:
            attempts.popleft()
        if not attempts:
            del self.failures[key]
        return attempts

    def prune(self) -> None:
        for key in list(self.failures):
            self.recent_failures(key)
