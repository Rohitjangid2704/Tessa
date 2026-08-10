import argparse
import sys

from tessa_api.openapi_export import OPENAPI_PATH, build_openapi_document, render_openapi


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the OpenAPI document to api/openapi.json")
    parser.add_argument("--check", action="store_true", help="fail when the committed file differs")
    arguments = parser.parse_args()
    rendered = render_openapi(build_openapi_document())
    if arguments.check:
        current = OPENAPI_PATH.read_text(encoding="utf-8") if OPENAPI_PATH.exists() else ""
        if current != rendered:
            sys.stderr.write("api/openapi.json is out of date, run scripts/export_openapi.py\n")
            return 1
        return 0
    with OPENAPI_PATH.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
