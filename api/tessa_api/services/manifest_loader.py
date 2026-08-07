import datetime
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from tessa_api.errors import ApiError
from tessa_api.schemas.bundles import BundleValidationError
from tessa_api.schemas.common import ErrorDetail

MANIFEST_FILE = "manifest.yaml"
SCHEMA_KEY = "schema"
TARGET_TOKEN_KEY = "target_token"

Location = tuple[int, int]


class AliasRejected(yaml.YAMLError):
    def __init__(self, mark: yaml.Mark) -> None:
        super().__init__("YAML aliases are not allowed")
        self.problem_mark = mark


class StrictLoader(yaml.SafeLoader):
    def compose_node(self, parent: Node | None, index: Any) -> Node | None:
        if self.check_event(yaml.AliasEvent):
            raise AliasRejected(self.current_event.start_mark)
        return super().compose_node(parent, index)


def escape_pointer_segment(segment: str | int) -> str:
    return str(segment).replace("~", "~0").replace("/", "~1")


def to_pointer(loc: Sequence[str | int]) -> str:
    return "".join(f"/{escape_pointer_segment(part)}" for part in loc)


def parent_pointer(pointer: str) -> str:
    return pointer.rsplit("/", 1)[0] if "/" in pointer else ""


class PointerMap:
    def __init__(self, locations: Mapping[str, Location] | None = None) -> None:
        self.locations = dict(locations or {})

    def locate(self, pointer: str) -> Location | None:
        current = pointer
        while True:
            found = self.locations.get(current)
            if found is not None:
                return found
            if not current:
                return None
            current = parent_pointer(current)


@dataclass
class LoadedDocument:
    file: str
    data: dict[str, Any] | None = None
    pointers: PointerMap = field(default_factory=PointerMap)
    errors: list[BundleValidationError] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return self.data is not None


@dataclass
class LoadedManifest(LoadedDocument):
    target_token: str | None = None
    schema_url: str | None = None


def manifest_too_large(size: int, limit: int, file: str) -> ApiError:
    message = f"{file} is {size} bytes, the limit is {limit}"
    detail = ErrorDetail(loc=["file", file], code="manifest_too_large", message=message)
    return ApiError(413, "payload_too_large", message, [detail])


def ensure_within_limit(text: str, limit: int, file: str) -> None:
    size = len(text.encode("utf-8"))
    if size > limit:
        raise manifest_too_large(size, limit, file)


def error_at(
    file: str, code: str, message: str, mark: yaml.Mark | None, pointer: str | None = None
) -> BundleValidationError:
    return BundleValidationError(
        code=code,
        message=message,
        severity="error",
        file=file,
        pointer=pointer,
        line=mark.line + 1 if mark is not None else None,
        column=mark.column + 1 if mark is not None else None,
    )


def describe_yaml_error(error: yaml.YAMLError) -> tuple[str, str, yaml.Mark | None]:
    mark = getattr(error, "problem_mark", None)
    if isinstance(error, AliasRejected):
        return "yaml_alias_rejected", "YAML aliases (&anchor, *alias, <<) are not allowed", mark
    problem = getattr(error, "problem", None) or str(error)
    context = getattr(error, "context", None)
    if isinstance(error, yaml.composer.ComposerError) and "single document" in str(context):
        return "multiple_documents", "The file holds more than one YAML document", mark
    message = f"{context}: {problem}" if context else str(problem)
    return "yaml_syntax", message, mark


def collect_structure(
    node: Node,
    pointer: str,
    file: str,
    locations: dict[str, Location],
    errors: list[BundleValidationError],
) -> None:
    if isinstance(node, MappingNode):
        seen: set[str] = set()
        for key_node, value_node in node.value:
            if not isinstance(key_node, ScalarNode):
                errors.append(
                    error_at(
                        file,
                        "complex_key",
                        "Mapping keys must be plain text",
                        key_node.start_mark,
                        pointer,
                    )
                )
                continue
            key = str(key_node.value)
            child = f"{pointer}/{escape_pointer_segment(key)}"
            if key in seen:
                errors.append(
                    error_at(
                        file,
                        "duplicate_key",
                        f"Key {key!r} appears twice",
                        key_node.start_mark,
                        child,
                    )
                )
            seen.add(key)
            locations.setdefault(
                child, (key_node.start_mark.line + 1, key_node.start_mark.column + 1)
            )
            collect_structure(value_node, child, file, locations, errors)
    elif isinstance(node, SequenceNode):
        for index, item in enumerate(node.value):
            child = f"{pointer}/{index}"
            locations[child] = (item.start_mark.line + 1, item.start_mark.column + 1)
            collect_structure(item, child, file, locations, errors)


def to_json_compatible(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): to_json_compatible(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [to_json_compatible(item) for item in value]
    if isinstance(value, set | frozenset):
        return sorted((to_json_compatible(item) for item in value), key=repr)
    if isinstance(value, datetime.datetime | datetime.date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def parse_single_document(text: str) -> tuple[Node | None, Any]:
    loader = StrictLoader(text)
    try:
        node = loader.get_single_node()
        if node is None:
            return None, None
        return node, loader.construct_document(node)
    finally:
        loader.dispose()


def load_yaml_document(text: str, file: str) -> LoadedDocument:
    document = LoadedDocument(file=file)
    try:
        node, constructed = parse_single_document(text)
    except yaml.YAMLError as error:
        code, message, mark = describe_yaml_error(error)
        document.errors.append(error_at(file, code, message, mark, ""))
        return document
    except RecursionError:
        document.errors.append(
            error_at(file, "yaml_too_deep", "The document is nested too deeply", None, "")
        )
        return document
    if node is None:
        document.errors.append(error_at(file, "empty_document", "The file is empty", None, ""))
        return document
    locations: dict[str, Location] = {"": (node.start_mark.line + 1, node.start_mark.column + 1)}
    try:
        collect_structure(node, "", file, locations, document.errors)
    except RecursionError:
        document.errors.append(
            error_at(file, "yaml_too_deep", "The document is nested too deeply", None, "")
        )
        return document
    document.pointers = PointerMap(locations)
    if not isinstance(constructed, dict):
        document.errors.append(
            error_at(
                file, "root_not_a_mapping", "The top level must be a mapping", node.start_mark, ""
            )
        )
        return document
    document.data = to_json_compatible(constructed)
    return document


def read_text_field(data: Mapping[str, Any] | None, key: str) -> str | None:
    if data is None:
        return None
    value = data.get(key)
    return value if isinstance(value, str) and value else None


def load_manifest(text: str, max_bytes: int, file: str = MANIFEST_FILE) -> LoadedManifest:
    ensure_within_limit(text, max_bytes, file)
    document = load_yaml_document(text, file)
    return LoadedManifest(
        file=file,
        data=document.data,
        pointers=document.pointers,
        errors=document.errors,
        target_token=read_text_field(document.data, TARGET_TOKEN_KEY),
        schema_url=read_text_field(document.data, SCHEMA_KEY),
    )
