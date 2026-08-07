import time
from collections import OrderedDict
from collections.abc import Callable
from uuid import UUID

from tessa_api.schemas.calibration import CalibrationReport

CALIBRATION_CACHE_TTL_SECONDS = 60.0
CALIBRATION_CACHE_CAPACITY = 128

Clock = Callable[[], float]
CacheKey = tuple[UUID | None, int]


class CalibrationCache:
    def __init__(
        self,
        ttl_seconds: float = CALIBRATION_CACHE_TTL_SECONDS,
        capacity: int = CALIBRATION_CACHE_CAPACITY,
        clock: Clock = time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._capacity = capacity
        self._clock = clock
        self._generation = 0
        self._entries: OrderedDict[CacheKey, tuple[float, CalibrationReport]] = OrderedDict()

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def generation(self) -> int:
        return self._generation

    def get(self, key: CacheKey) -> CalibrationReport | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, report = entry
        if self._clock() >= expires_at:
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return report

    def put(self, key: CacheKey, report: CalibrationReport, generation: int) -> None:
        if generation != self._generation:
            return
        self._entries[key] = (self._clock() + self._ttl_seconds, report)
        self._entries.move_to_end(key)
        while len(self._entries) > self._capacity:
            self._entries.popitem(last=False)

    def invalidate(self) -> None:
        self._generation += 1
        self._entries.clear()


CALIBRATION_CACHE = CalibrationCache()
