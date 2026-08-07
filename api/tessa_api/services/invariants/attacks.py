import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import ValidationError

from tessa_api.schemas.attack_pack import AttackDefinition, AttackPackFile
from tessa_api.schemas.enums import BuiltInInvariantId

ATTACK_PACK_RELATIVE_PATH = Path("attacks") / "core.yaml"
MAX_ATTACK_PACK_BYTES = 256 * 1024


class AttackPackError(Exception):
    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = tuple(problems)


@dataclass(frozen=True, slots=True)
class AttackPack:
    version: str
    attacks: tuple[AttackDefinition, ...]

    def for_invariant(self, invariant_id: BuiltInInvariantId) -> list[AttackDefinition]:
        return [attack for attack in self.attacks if attack.invariant is invariant_id]


def parse_attack_pack(content: bytes, name: str) -> AttackPackFile:
    try:
        document = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise AttackPackError([f"{name}: not valid YAML ({type(error).__name__})"]) from None
    try:
        return AttackPackFile.model_validate(document)
    except ValidationError as error:
        raise AttackPackError(
            [
                f"{name}: {'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()
            ]
        ) from None


def read_attack_pack(path: Path) -> AttackPack:
    if not path.is_file():
        raise AttackPackError([f"attack pack {path} does not exist"])
    content = path.read_bytes().replace(b"\r\n", b"\n")
    if len(content) > MAX_ATTACK_PACK_BYTES:
        raise AttackPackError([f"{path.name}: larger than {MAX_ATTACK_PACK_BYTES} bytes"])
    parsed = parse_attack_pack(content, path.name)
    return AttackPack(version=hashlib.sha256(content).hexdigest(), attacks=tuple(parsed.attacks))


@lru_cache(maxsize=4)
def cached_attack_pack(path: str, signature: tuple[int, int]) -> AttackPack:
    return read_attack_pack(Path(path))


def load_attack_pack(probes_dir: Path) -> AttackPack:
    path = (probes_dir / ATTACK_PACK_RELATIVE_PATH).resolve()
    if not path.is_file():
        raise AttackPackError([f"attack pack {path} does not exist"])
    stat = path.stat()
    return cached_attack_pack(str(path), (stat.st_mtime_ns, stat.st_size))
