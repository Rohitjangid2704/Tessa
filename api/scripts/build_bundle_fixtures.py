import argparse
import re
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
TOKEN_PATTERN = re.compile(r"^tgt_[a-z2-7]{22}$")


def main() -> int:
    sys.path.insert(0, str(API_ROOT))
    from tests.bundle_fixtures import DEFAULT_TARGET_TOKEN, FIXTURES, OUT_DIR, build_fixture

    parser = argparse.ArgumentParser(
        description="Write the bundle fixture zips and the paste-only manifest for upload tests"
    )
    parser.add_argument(
        "--target-token",
        default=DEFAULT_TARGET_TOKEN,
        help="target_token written into every manifest (copy it from a target)",
    )
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    arguments = parser.parse_args()
    if not TOKEN_PATTERN.fullmatch(arguments.target_token):
        parser.error("target token must look like tgt_ followed by 22 characters of a-z and 2-7")
    arguments.out_dir.mkdir(parents=True, exist_ok=True)
    for fixture in FIXTURES.values():
        destination = arguments.out_dir / fixture.file_name
        destination.write_bytes(build_fixture(fixture.name, arguments.target_token))
        print(f"{destination}  [{fixture.endpoint}]  {fixture.expectation}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
