class LatestEventCoalescer[Message]:
    def __init__(self, min_interval_seconds: float) -> None:
        self._min_interval_seconds = min_interval_seconds
        self._last_emitted_at: float | None = None
        self._held: Message | None = None

    def offer(self, message: Message, now: float) -> Message | None:
        if (
            self._last_emitted_at is None
            or now - self._last_emitted_at >= self._min_interval_seconds
        ):
            self._last_emitted_at = now
            self._held = None
            return message
        self._held = message
        return None

    def due_at(self) -> float | None:
        if self._held is None or self._last_emitted_at is None:
            return None
        return self._last_emitted_at + self._min_interval_seconds

    def release(self, now: float) -> Message | None:
        due = self.due_at()
        if due is None or now < due:
            return None
        held = self._held
        self._held = None
        self._last_emitted_at = now
        return held
