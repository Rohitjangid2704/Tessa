import argparse
import sys
from pathlib import Path

from tessa_api.services.schema_registry import render_committed_files

API_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_ROOT = API_ROOT.parent / "schemas"


def find_drift(expected: dict[str, str], directory: Path) -> list[str]:
    problems: list[str] = []
    for file_name, content in expected.items():
        path = directory / file_name
        if not path.exists():
            problems.append(f"missing {file_name}")
        elif path.read_bytes() != content.encode("utf-8"):
            problems.append(f"out of date {file_name}")
    if directory.exists():
        problems.extend(
            f"unexpected {path.name}"
            for path in sorted(directory.glob("*.json"))
            if path.name not in expected
        )
    return problems


def write_files(expected: dict[str, str], directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for file_name, content in expected.items():
        with (directory / file_name).open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the published JSON Schemas to schemas/")
    parser.add_argument("--check", action="store_true", help="fail when committed files differ")
    arguments = parser.parse_args()
    expected = render_committed_files()
    if arguments.check:
        problems = find_drift(expected, SCHEMAS_ROOT)
        if problems:
            sys.stderr.write(
                "schemas/ is out of date, run scripts/export_schemas.py: "
                + ", ".join(problems)
                + "\n"
            )
            return 1
        return 0
    write_files(expected, SCHEMAS_ROOT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
