from typing import Any

import yaml

from tests.support import API_ROOT

EXAMPLES_ROOT = API_ROOT / "tests" / "fixtures" / "bundle_examples"
EXAMPLE_NAMES = ("minimal", "gracie")


def example_text(example: str, relative_path: str) -> str:
    return (EXAMPLES_ROOT / example / relative_path).read_text(encoding="utf-8")


def example_yaml(example: str, relative_path: str) -> dict[str, Any]:
    loaded = yaml.safe_load(example_text(example, relative_path))
    assert isinstance(loaded, dict)
    return loaded


def example_manifest(example: str) -> dict[str, Any]:
    return example_yaml(example, "manifest.yaml")
