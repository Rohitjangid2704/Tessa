from collections.abc import AsyncIterator
from typing import Any

import pytest
import yaml
from playwright.async_api import Browser, Locator, Page, async_playwright, expect

from tests.fake_target.bundle import read_bundle_files
from tests.fake_target.dataset import STAFF_EMAIL, STAFF_PASSWORD
from tests.fake_target.server import RunningTarget

PLACEHOLDERS = {"${STAFF_EMAIL}": STAFF_EMAIL, "${STAFF_PASSWORD}": STAFF_PASSWORD}
TIMEOUT_MS = 10000


@pytest.fixture
async def browser() -> AsyncIterator[Browser]:
    async with async_playwright() as playwright:
        opened = await playwright.chromium.launch(headless=True)
        try:
            yield opened
        finally:
            await opened.close()


@pytest.fixture
async def page(browser: Browser) -> AsyncIterator[Page]:
    context = await browser.new_context()
    context.set_default_timeout(TIMEOUT_MS)
    opened = await context.new_page()
    try:
        yield opened
    finally:
        await context.close()


def locate(page: Page, target: dict[str, str]) -> Locator:
    if "selector" in target:
        return page.locator(target["selector"])
    return page.locator(f'role={target["role"]}[name="{target["name"]}"s]')


def resolved(value: str) -> str:
    return PLACEHOLDERS.get(value, value)


async def run_flow(page: Page, base_url: str, flow_file: str) -> None:
    flow: dict[str, Any] = yaml.safe_load(read_bundle_files()[flow_file])
    for step in flow["steps"]:
        action = step["action"]
        if action == "goto":
            await page.goto(base_url + step["url"])
        elif action == "fill":
            await locate(page, step["target"]).fill(resolved(step["value"]))
        elif action == "click":
            await locate(page, step["target"]).click()
        elif action == "press":
            await page.keyboard.press(step["value"])
        await assert_expectations(page, step.get("expect", {}))


async def assert_expectations(page: Page, wanted: dict[str, Any]) -> None:
    if "url" in wanted:
        await page.wait_for_url(f"**{wanted['url']}")
    for text in wanted.get("text", []):
        await expect(page.get_by_text(text).first).to_be_visible()


async def test_the_login_and_chat_flow_of_the_bundle_works_on_the_real_pages(
    fake_target: RunningTarget, page: Page
) -> None:
    await run_flow(page, fake_target.base_url, "flows/login_and_chat.yaml")
    assistant = page.locator("[data-testid=message][data-author=assistant]").last
    await expect(assistant).to_contain_text(
        "3 maintenance issues are open across 2 rooms, most of them in room 20003 (2 issues)."
    )
    assert await page.title() == "Fake Target - Chat"


async def test_the_confirm_flow_of_the_bundle_creates_the_issue(
    fake_target: RunningTarget, page: Page
) -> None:
    before = len(fake_target.state.dataset.issues_with("open"))
    await run_flow(page, fake_target.base_url, "flows/confirm_create_issue.yaml")
    assert len(fake_target.state.dataset.issues_with("open")) == before + 1
    created = fake_target.state.dataset.issues[-1]
    assert (created.room, created.description) == ("20003", "the shower leaks")


async def test_a_wrong_password_shows_an_alert_and_stays_on_the_login_page(
    fake_target: RunningTarget, page: Page
) -> None:
    await page.goto(fake_target.base_url + "/login")
    await page.get_by_role("textbox", name="Email").fill(STAFF_EMAIL)
    await page.locator("[data-testid=password]").fill("wrong-password-123")
    await page.get_by_role("button", name="Sign in").click()
    await expect(page.get_by_role("alert")).to_have_text("Invalid email or password")
    assert page.url.endswith("/login")


async def test_the_chat_page_needs_a_session(fake_target: RunningTarget, page: Page) -> None:
    await page.goto(fake_target.base_url + "/chat")
    assert page.url.endswith("/login")


async def test_the_console_error_hook_logs_an_error_the_console_check_can_see(
    fake_target: RunningTarget, page: Page
) -> None:
    messages: list[tuple[str, str]] = []
    page.on("console", lambda message: messages.append((message.type, message.text)))
    await page.goto(fake_target.base_url + "/login")
    await page.get_by_role("textbox", name="Email").fill(STAFF_EMAIL)
    await page.locator("[data-testid=password]").fill(STAFF_PASSWORD)
    await page.get_by_role("button", name="Sign in").click()
    await page.wait_for_url("**/chat")
    await page.goto(fake_target.base_url + "/chat?fail=console")
    await expect(page.locator("[data-testid=chat-input]")).to_be_visible()
    assert ("info", "chat ready") in messages
    assert ("error", "fake target deliberate console error") in messages
