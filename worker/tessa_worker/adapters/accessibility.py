import asyncio
import logging
from collections.abc import Callable
from functools import cache
from importlib import resources

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page
from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger("tessa_worker.adapters.accessibility")

ACCESSIBILITY_KEY = "accessibility"
ENGINE_NAME = "axe-core"
AXE_PACKAGE = "axe_playwright_python"
AXE_FILE = "axe.min.js"
AXE_PRESENT = "typeof window.axe !== 'undefined'"
SCAN_SCRIPT = """
async () => {
  const results = await window.axe.run(document, { resultTypes: ['violations'] });
  return {
    version: String(window.axe.version),
    violations: results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 2).map((node) => node.target.join(' ')),
    })),
  };
}
"""
CAPTURE_TIMEOUT_SECONDS = 20.0
MAX_VIOLATIONS = 20
MAX_TARGETS = 2
HELP_LIMIT = 160
TARGET_LIMIT = 100


class AccessibilityViolation(BaseModel):
    id: str = Field(description="axe-core rule id")
    impact: str | None = Field(description="minor, moderate, serious or critical")
    help: str = Field(description="short rule description of axe-core")
    nodes: int = Field(ge=0, description="elements that break the rule")
    targets: list[str] = Field(description="selectors of the first elements, redacted")


class AccessibilityCapture(BaseModel):
    engine: str = Field(description="always axe-core")
    engine_version: str | None
    violations: list[AccessibilityViolation]
    truncated: bool = Field(description="true when more violations were found than are kept")


@cache
def axe_script() -> str:
    return resources.files(AXE_PACKAGE).joinpath(AXE_FILE).read_text(encoding="utf-8")


def clipped(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[: limit - 3]}..."


def parse_capture(raw: object, redact: Callable[[str], str]) -> AccessibilityCapture | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("violations"), list):
        return None
    violations: list[AccessibilityViolation] = []
    for item in raw["violations"][:MAX_VIOLATIONS]:
        try:
            parsed = AccessibilityViolation.model_validate(item)
        except ValidationError:
            continue
        violations.append(
            parsed.model_copy(
                update={
                    "help": redact(clipped(parsed.help, HELP_LIMIT)),
                    "targets": [
                        redact(clipped(target, TARGET_LIMIT))
                        for target in parsed.targets[:MAX_TARGETS]
                    ],
                }
            )
        )
    version = raw.get("version")
    return AccessibilityCapture(
        engine=ENGINE_NAME,
        engine_version=version if isinstance(version, str) else None,
        violations=violations,
        truncated=len(raw["violations"]) > MAX_VIOLATIONS,
    )


class AccessibilityScanner:
    def __init__(self, redact: Callable[[str], str]) -> None:
        self._redact = redact
        self._scanned_url: str | None = None

    def due(self, url: str, forced: bool) -> bool:
        return forced or url != self._scanned_url

    async def scan(self, page: Page, url: str) -> AccessibilityCapture | None:
        self._scanned_url = url
        try:
            async with asyncio.timeout(CAPTURE_TIMEOUT_SECONDS):
                if not await page.evaluate(AXE_PRESENT):
                    await page.evaluate(await asyncio.to_thread(axe_script))
                raw = await page.evaluate(SCAN_SCRIPT)
        except (PlaywrightError, TimeoutError, OSError):
            logger.warning("accessibility_scan_failed")
            return None
        return parse_capture(raw, self._redact)
