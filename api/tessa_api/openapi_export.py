import json
from pathlib import Path
from typing import Any

from tessa_api.main import create_app
from tessa_api.settings import Settings

API_ROOT = Path(__file__).resolve().parent.parent
OPENAPI_PATH = API_ROOT / "openapi.json"
ENV_EXAMPLE_PATH = API_ROOT / ".env.example"


def build_openapi_document(settings: Settings | None = None) -> dict[str, Any]:
    app_settings = settings or Settings(_env_file=ENV_EXAMPLE_PATH)
    return create_app(app_settings).openapi()


def render_openapi(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
