from fixtures.adapters.ws_echo.app import create_app
from fixtures.adapters.ws_echo.config import DEFAULT_PORT, PORT_ENV
from fixtures.runner import run_simple


def main() -> None:
    run_simple("Tessa websocket echo fixture", DEFAULT_PORT, PORT_ENV, create_app())


if __name__ == "__main__":
    main()
