import json
import re
from collections.abc import Mapping
from typing import Any

from tessa_api.db.models import BundleRow
from tessa_api.services.bundle_validator import OPENAPI_FILE
from tessa_api.services.storage import BundleStore

MAX_OPENAPI_BYTES = 10 * 1024 * 1024
SERVER_VARIABLE = re.compile(r"\{([^{}]+)\}")


class OpenApiUnavailableError(Exception):
    pass


def bundle_openapi_ref(bundle: BundleRow) -> str | None:
    for entry in bundle.files:
        if entry.get("path") == OPENAPI_FILE:
            return OPENAPI_FILE
    return None


async def read_openapi_document(store: BundleStore, bundle: BundleRow, ref: str) -> dict[str, Any]:
    if bundle.storage_path is None:
        raise OpenApiUnavailableError("the stored bundle files are gone")
    raw = await store.read(bundle.storage_path, ref, MAX_OPENAPI_BYTES + 1)
    if raw is None:
        raise OpenApiUnavailableError(f"{ref} is no longer stored")
    if len(raw) > MAX_OPENAPI_BYTES:
        raise OpenApiUnavailableError(f"{ref} is larger than {MAX_OPENAPI_BYTES} bytes")
    try:
        document = json.loads(raw.decode("utf-8-sig"))
    except ValueError:
        raise OpenApiUnavailableError(f"{ref} is not valid JSON") from None
    if not isinstance(document, dict):
        raise OpenApiUnavailableError(f"{ref} is not a JSON object")
    return document


def first_server_url(document: Mapping[str, Any]) -> str | None:
    servers = document.get("servers")
    if not isinstance(servers, list) or not servers or not isinstance(servers[0], dict):
        return None
    url = servers[0].get("url")
    if not isinstance(url, str):
        return None
    variables = servers[0].get("variables")
    defaults = variables if isinstance(variables, dict) else {}

    def substitute(match: re.Match[str]) -> str:
        declared = defaults.get(match.group(1))
        default = declared.get("default") if isinstance(declared, dict) else None
        return str(default) if default is not None else match.group(0)

    return SERVER_VARIABLE.sub(substitute, url)


def declares_base_path(document: Mapping[str, Any]) -> bool:
    if first_server_url(document) is not None:
        return True
    return isinstance(document.get("basePath"), str)
