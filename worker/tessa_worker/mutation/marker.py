from collections.abc import Callable
from dataclasses import dataclass

import httpx

from tessa_api.schemas.mutants import DeployedMarker

MARKER_TIMEOUT_SECONDS = 10.0
MARKER_MAX_BYTES = 65536
MARKER_USER_AGENT = "tessa-mutation-run"
HTTP_OK = range(200, 300)


class MarkerUnreachableError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class MarkerCheck:
    ok: bool
    reason: str | None


def marker_url(address: str, marker: DeployedMarker) -> str:
    return f"{address.rstrip('/')}{marker.path}"


async def read_limited_body(response: httpx.Response) -> str:
    received = bytearray()
    async for chunk in response.aiter_bytes():
        received.extend(chunk)
        if len(received) >= MARKER_MAX_BYTES:
            break
    return bytes(received[:MARKER_MAX_BYTES]).decode("utf-8", errors="replace")


async def check_deployed_marker(
    address: str,
    marker: DeployedMarker,
    client_factory: Callable[[], httpx.AsyncClient] = httpx.AsyncClient,
) -> MarkerCheck:
    url = marker_url(address, marker)
    try:
        async with (
            client_factory() as client,
            client.stream(
                "GET",
                url,
                timeout=MARKER_TIMEOUT_SECONDS,
                follow_redirects=False,
                headers={"User-Agent": MARKER_USER_AGENT},
            ) as response,
        ):
            if response.status_code not in HTTP_OK:
                return MarkerCheck(
                    False,
                    f"the marker route {marker.path} answered HTTP {response.status_code}, so "
                    "the mutant is not the build that is deployed",
                )
            body = await read_limited_body(response)
    except httpx.HTTPError as error:
        raise MarkerUnreachableError(
            f"the marker route {marker.path} could not be read: {type(error).__name__}"
        ) from None
    if marker.expected_text not in body:
        return MarkerCheck(
            False,
            f"the marker route {marker.path} does not contain the expected text, so the mutant "
            "is not the build that is deployed",
        )
    return MarkerCheck(True, None)
