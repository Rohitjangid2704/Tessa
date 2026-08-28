from fixtures.adapters.graphql_app.app import create_app
from fixtures.adapters.graphql_app.config import DEFAULT_PORT, PORT_ENV
from fixtures.runner import run_simple


def main() -> None:
    run_simple("Tessa GraphQL fixture", DEFAULT_PORT, PORT_ENV, create_app())


if __name__ == "__main__":
    main()
