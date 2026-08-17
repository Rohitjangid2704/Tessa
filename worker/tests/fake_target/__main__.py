import argparse
import os

import uvicorn

from tests.fake_target.app import create_app
from tests.fake_target.database import DatabaseMirror

DEFAULT_PORT = 8504
DSN_VARIABLE = "FAKE_TARGET_DSN"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Tessa fake target")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--database",
        action="store_true",
        help=f"serve rooms and issues from the Postgres database named by ${DSN_VARIABLE}",
    )
    arguments = parser.parse_args()
    database = DatabaseMirror(os.environ[DSN_VARIABLE]) if arguments.database else None
    app = create_app(database=database)
    uvicorn.run(app, host=arguments.host, port=arguments.port, log_level="info")


if __name__ == "__main__":
    main()
