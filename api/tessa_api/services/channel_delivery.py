import httpx
from pydantic import SecretStr

SLACK_TIMEOUT_SECONDS = 10.0
RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429})
SLACK_ESCAPE_TABLE = str.maketrans({"&": "&amp;", "<": "&lt;", ">": "&gt;"})


class ChannelDeliveryError(Exception):
    def __init__(self, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


def escape_slack_text(text: str) -> str:
    return text.translate(SLACK_ESCAPE_TABLE)


def slack_payload(text: str, link: str | None) -> dict[str, str]:
    escaped = escape_slack_text(text)
    return {"text": escaped if link is None else f"{escaped}\n{link}"}


def slack_status_error(status_code: int) -> ChannelDeliveryError:
    retryable = status_code in RETRYABLE_HTTP_STATUSES or status_code >= 500
    return ChannelDeliveryError(f"Slack answered HTTP {status_code}", retryable)


async def post_slack(
    client: httpx.AsyncClient,
    webhook: SecretStr,
    text: str,
    link: str | None = None,
    timeout_seconds: float = SLACK_TIMEOUT_SECONDS,
) -> None:
    try:
        response = await client.post(
            webhook.get_secret_value(),
            json=slack_payload(text, link),
            timeout=timeout_seconds,
        )
    except httpx.InvalidURL:
        raise ChannelDeliveryError("the Slack webhook is not a valid URL", False) from None
    except httpx.TimeoutException:
        raise ChannelDeliveryError("Slack did not answer in time", True) from None
    except httpx.HTTPError as error:
        raise ChannelDeliveryError(
            f"Slack could not be reached ({type(error).__name__})", True
        ) from None
    if not response.is_success:
        raise slack_status_error(response.status_code)
