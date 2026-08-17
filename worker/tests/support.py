import os
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = WORKER_ROOT.parent
API_ROOT = REPO_ROOT / "api"
WORKER_ENV_EXAMPLE = WORKER_ROOT / ".env.example"
API_ENV_EXAMPLE = API_ROOT / ".env.example"
API_ENV_TEST = Path(os.environ.get("TEST_ENV_FILE", API_ROOT / ".env.test"))
COMPOSE_PATH = REPO_ROOT / "deploy" / "docker-compose.yml"
TEST_LAYA_URL = "http://127.0.0.1:8629"
