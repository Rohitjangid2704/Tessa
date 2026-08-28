import argparse
import os
from dataclasses import dataclass

import uvicorn
from fastapi import FastAPI

HOST_ENV = "FIXTURE_HOST"
DEFAULT_HOST = "127.0.0.1"
PORT_RANGE_START = 8520
PORT_RANGE_END = 8539


@dataclass(frozen=True)
class ServerOptions:
    host: str
    port: int


def add_server_arguments(parser: argparse.ArgumentParser, default_port: int, port_env: str) -> None:
    configured_port = int(os.environ.get(port_env, default_port))
    parser.add_argument(
        "--host",
        default=os.environ.get(HOST_ENV, DEFAULT_HOST),
        help=f"interface to bind, default from {HOST_ENV} or {DEFAULT_HOST}",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=configured_port,
        help=f"port in {PORT_RANGE_START}-{PORT_RANGE_END}, default from {port_env} or "
        f"{default_port}",
    )


def read_server_options(
    parser: argparse.ArgumentParser, arguments: argparse.Namespace
) -> ServerOptions:
    host = str(arguments.host)
    port = int(arguments.port)
    if not PORT_RANGE_START <= port <= PORT_RANGE_END:
        parser.error(
            f"port {port} is outside the fixture range {PORT_RANGE_START}-{PORT_RANGE_END}"
        )
    return ServerOptions(host=host, port=port)


def serve(app: FastAPI, options: ServerOptions) -> None:
    uvicorn.run(app, host=options.host, port=options.port, log_level="info")


def run_simple(description: str, default_port: int, port_env: str, app: FastAPI) -> None:
    parser = argparse.ArgumentParser(description=description)
    add_server_arguments(parser, default_port, port_env)
    serve(app, read_server_options(parser, parser.parse_args()))
