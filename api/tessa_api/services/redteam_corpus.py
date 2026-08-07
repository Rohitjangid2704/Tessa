import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import ValidationError

from tessa_api.schemas.attack_family import (
    AttackFamilyFile,
    FamilyAttack,
    FamilyDefinition,
)
from tessa_api.schemas.enums import RedTeamFamily
from tessa_api.schemas.redteam import RedTeamFamilyInfo
from tessa_api.services.invariants.attacks import ATTACK_PACK_RELATIVE_PATH

FAMILY_DIRECTORY = ATTACK_PACK_RELATIVE_PATH.parent
FAMILY_FILE_SUFFIX = ".yaml"
INVARIANT_PACK_FILE_NAME = ATTACK_PACK_RELATIVE_PATH.name
MAX_FAMILY_FILE_BYTES = 128 * 1024
BUILT_IN_ORDER = {family.value: position for position, family in enumerate(RedTeamFamily)}


class RedTeamCorpusError(Exception):
    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = tuple(problems)


@dataclass(frozen=True, slots=True)
class AttackFamily:
    definition: FamilyDefinition
    attacks: tuple[FamilyAttack, ...]

    @property
    def id(self) -> str:
        return self.definition.id

    def info(self) -> RedTeamFamilyInfo:
        return RedTeamFamilyInfo(
            id=self.definition.id,
            title=self.definition.title,
            description=self.definition.description,
        )


@dataclass(frozen=True, slots=True)
class RedTeamCorpus:
    version: str
    families: tuple[AttackFamily, ...]

    def get(self, family_id: str) -> AttackFamily | None:
        return next((family for family in self.families if family.id == family_id), None)

    def ids(self) -> list[str]:
        return [family.id for family in self.families]

    def infos(self) -> list[RedTeamFamilyInfo]:
        return [family.info() for family in self.families]


def family_files(directory: Path) -> list[Path]:
    folder = directory / FAMILY_DIRECTORY
    if not folder.is_dir():
        raise RedTeamCorpusError([f"attack directory {folder} does not exist"])
    files = sorted(
        path
        for path in folder.glob(f"*{FAMILY_FILE_SUFFIX}")
        if path.name != INVARIANT_PACK_FILE_NAME
    )
    if not files:
        raise RedTeamCorpusError([f"no attack family files in {folder}"])
    return files


def normalized_content(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def parse_family_file(path: Path, content: bytes) -> AttackFamilyFile:
    if len(content) > MAX_FAMILY_FILE_BYTES:
        raise RedTeamCorpusError([f"{path.name}: larger than {MAX_FAMILY_FILE_BYTES} bytes"])
    try:
        document = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise RedTeamCorpusError(
            [f"{path.name}: not valid YAML ({type(error).__name__})"]
        ) from None
    try:
        parsed = AttackFamilyFile.model_validate(document)
    except ValidationError as error:
        raise RedTeamCorpusError(
            [
                f"{path.name}: {'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()
            ]
        ) from None
    if parsed.family.id != path.stem:
        raise RedTeamCorpusError(
            [f"{path.name}: family id {parsed.family.id} does not match the file name"]
        )
    return parsed


def family_order(family: AttackFamily) -> tuple[int, str]:
    return BUILT_IN_ORDER.get(family.id, len(BUILT_IN_ORDER)), family.id


def read_corpus(directory: Path) -> RedTeamCorpus:
    digest = hashlib.sha256()
    families: list[AttackFamily] = []
    problems: list[str] = []
    for path in family_files(directory):
        content = normalized_content(path)
        digest.update(path.name.encode())
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
        try:
            parsed = parse_family_file(path, content)
        except RedTeamCorpusError as error:
            problems.extend(error.problems)
            continue
        families.append(AttackFamily(parsed.family, tuple(parsed.attacks)))
    if problems:
        raise RedTeamCorpusError(problems)
    return RedTeamCorpus(
        version=digest.hexdigest(), families=tuple(sorted(families, key=family_order))
    )


@lru_cache(maxsize=4)
def cached_corpus(directory: str, signature: tuple[tuple[str, int, int], ...]) -> RedTeamCorpus:
    return read_corpus(Path(directory))


def file_signature(files: Sequence[Path]) -> tuple[tuple[str, int, int], ...]:
    stats = [(path, path.stat()) for path in files]
    return tuple((path.name, stat.st_mtime_ns, stat.st_size) for path, stat in stats)


def load_redteam_corpus(probes_dir: Path) -> RedTeamCorpus:
    resolved = probes_dir.resolve()
    return cached_corpus(str(resolved), file_signature(family_files(resolved)))
