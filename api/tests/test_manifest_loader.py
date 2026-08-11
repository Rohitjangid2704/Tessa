import pytest

from tessa_api.errors import ApiError
from tessa_api.services.manifest_loader import (
    PointerMap,
    load_manifest,
    load_yaml_document,
    to_pointer,
)

LIMIT = 1024 * 1024
VALID = """schema: http://localhost:8000/schemas/bundle.v1.json
target_token: tgt_abcdefghijklmnopqrstuv
app:
  name: Notes
features:
  - id: notes.read.list
    examples:
      - expected: a list
      - expected: another
"""


def codes(text: str) -> list[str]:
    return [error.code for error in load_manifest(text, LIMIT).errors]


def test_valid_manifest_loads_with_token_and_schema() -> None:
    loaded = load_manifest(VALID, LIMIT)
    assert loaded.errors == []
    assert loaded.usable
    assert loaded.target_token == "tgt_abcdefghijklmnopqrstuv"
    assert loaded.schema_url == "http://localhost:8000/schemas/bundle.v1.json"
    assert loaded.data is not None
    assert loaded.data["features"][0]["examples"][1] == {"expected": "another"}


def test_pointers_map_to_line_and_column() -> None:
    pointers = load_manifest(VALID, LIMIT).pointers
    assert pointers.locate("/app/name") == (4, 3)
    assert pointers.locate("/features/0") == (6, 5)
    assert pointers.locate("/features/0/examples/1") == (9, 9)
    assert pointers.locate("/target_token") == (2, 1)


def test_unknown_pointer_falls_back_to_the_nearest_parent() -> None:
    pointers = load_manifest(VALID, LIMIT).pointers
    assert pointers.locate("/features/0/examples/1/oracle") == (9, 9)
    assert pointers.locate("/nothing/here") == (1, 1)
    assert PointerMap().locate("/a") is None


def test_pointer_segments_are_escaped() -> None:
    assert to_pointer(["a/b", "c~d", 3]) == "/a~1b/c~0d/3"
    loaded = load_manifest("a/b:\n  c: 1\n", LIMIT)
    assert loaded.pointers.locate("/a~1b/c") == (2, 3)


@pytest.mark.parametrize(
    "text",
    [
        "a: &anchor [1, 2]\nb: *anchor\n",
        "base: &base {k: 1}\nderived:\n  <<: *base\n",
    ],
)
def test_aliases_and_merge_keys_are_rejected(text: str) -> None:
    loaded = load_manifest(text, LIMIT)
    assert not loaded.usable
    assert [error.code for error in loaded.errors] == ["yaml_alias_rejected"]
    assert loaded.errors[0].line is not None
    assert loaded.errors[0].column is not None


def test_multiple_documents_are_rejected() -> None:
    loaded = load_manifest("a: 1\n---\nb: 2\n", LIMIT)
    assert not loaded.usable
    assert [error.code for error in loaded.errors] == ["multiple_documents"]
    assert loaded.errors[0].line == 2


def test_syntax_error_has_line_and_column() -> None:
    loaded = load_manifest("a: [1, 2\nb: 3\n", LIMIT)
    assert not loaded.usable
    error = loaded.errors[0]
    assert error.code == "yaml_syntax"
    assert error.severity == "error"
    assert error.file == "manifest.yaml"
    assert (error.line, error.column) == (2, 2)


def test_python_tags_are_rejected_by_the_safe_loader() -> None:
    loaded = load_manifest("a: !!python/object/apply:os.system ['echo hi']\n", LIMIT)
    assert not loaded.usable
    assert codes("a: !!python/object/apply:os.system ['echo hi']\n") == ["yaml_syntax"]


def test_duplicate_keys_are_reported_with_a_pointer_and_the_last_value_wins() -> None:
    loaded = load_manifest("a: 1\nb:\n  c: 1\n  c: 2\n", LIMIT)
    assert [(error.code, error.pointer, error.line) for error in loaded.errors] == [
        ("duplicate_key", "/b/c", 4)
    ]
    assert loaded.data == {"a": 1, "b": {"c": 2}}


def test_top_level_must_be_a_mapping() -> None:
    loaded = load_manifest("- 1\n- 2\n", LIMIT)
    assert not loaded.usable
    assert [error.code for error in loaded.errors] == ["root_not_a_mapping"]


def test_empty_file_is_reported() -> None:
    assert codes("") == ["empty_document"]
    assert codes("# only a comment\n") == ["empty_document"]


def test_very_deep_nesting_does_not_crash() -> None:
    assert codes("[" * 5000 + "]" * 5000) in (["yaml_too_deep"], ["root_not_a_mapping"])


def test_dates_and_booleans_become_json_values() -> None:
    loaded = load_manifest("when: 2024-01-02\nflag: yes\nstamp: 2024-01-02 03:04:05\n", LIMIT)
    assert loaded.data == {"when": "2024-01-02", "flag": True, "stamp": "2024-01-02T03:04:05"}


def test_schema_invalid_manifest_still_resolves_its_target() -> None:
    loaded = load_manifest("target_token: tgt_abcdefghijklmnopqrstuv\nfeatures: nope\n", LIMIT)
    assert loaded.usable
    assert loaded.target_token == "tgt_abcdefghijklmnopqrstuv"
    assert loaded.schema_url is None


def test_non_text_token_is_ignored() -> None:
    assert load_manifest("target_token: 12\n", LIMIT).target_token is None
    assert load_manifest("target_token: ''\n", LIMIT).target_token is None


def test_manifest_larger_than_limit_is_413() -> None:
    with pytest.raises(ApiError) as caught:
        load_manifest("a: " + "x" * 200, 100)
    assert caught.value.status_code == 413
    assert caught.value.code == "payload_too_large"
    assert caught.value.details[0].code == "manifest_too_large"


def test_limit_counts_bytes_not_characters() -> None:
    text = "a: " + "\u00e9" * 60
    with pytest.raises(ApiError):
        load_manifest(text, 100)
    assert load_manifest(text, 200).usable


def test_other_yaml_files_load_with_their_own_file_name() -> None:
    loaded = load_yaml_document("name: a\nname: b\n", "oracle/a.yaml")
    assert loaded.errors[0].file == "oracle/a.yaml"
    assert loaded.errors[0].pointer == "/name"
