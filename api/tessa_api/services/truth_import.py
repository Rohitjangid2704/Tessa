import hashlib
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, OracleTemplateRow, SeedRow
from tessa_api.schemas.bundle import BundleManifest, TruthSource
from tessa_api.schemas.bundle_files import OracleSidecar
from tessa_api.schemas.enums import OracleLanguage, SeedHashSource
from tessa_api.services.bundle_validator import oracle_names_in
from tessa_api.services.manifest_loader import load_yaml_document
from tessa_api.services.oracle_lint import lint_sql_oracle

SEEDS_FOLDER = "seeds/"
DIGEST_SEPARATOR = b"\x00"


@dataclass(frozen=True, slots=True)
class SeedMaterial:
    reset_script_path: str | None
    hash_command: str | None
    declared_hash: str | None
    material_sha256: str


@dataclass(frozen=True, slots=True)
class OracleMaterial:
    name: str
    feature_ids: list[str]
    language: OracleLanguage
    source: str
    params_schema: dict[str, Any]
    sentence_template: str
    read_only_verified: bool
    truth_source: str | None
    gold_points: list[dict[str, Any]]


@dataclass(frozen=True, slots=True)
class TruthImport:
    seed: SeedRow | None
    seed_created: bool
    oracles_created: int


def length_prefixed(part: bytes) -> bytes:
    return len(part).to_bytes(8, "big") + part


def material_digest(
    reset_script_path: str | None,
    reset_script: bytes | None,
    hash_command: str | None,
    dsn_env: str | None,
    seed_files: Mapping[str, bytes],
) -> str:
    digest = hashlib.sha256()
    digest.update(length_prefixed((reset_script_path or "").encode("utf-8")))
    digest.update(length_prefixed(reset_script or b""))
    digest.update(length_prefixed((hash_command or "").encode("utf-8")))
    digest.update(length_prefixed((dsn_env or "").encode("utf-8")))
    for path in sorted(seed_files):
        digest.update(length_prefixed(path.encode("utf-8")))
        digest.update(length_prefixed(hashlib.sha256(seed_files[path]).digest()))
    return digest.hexdigest()


def seed_material(manifest: BundleManifest, files: Mapping[str, bytes]) -> SeedMaterial | None:
    seeds = manifest.seeds
    if seeds is None or (seeds.reset_script is None and seeds.hash_command is None):
        return None
    reset_path = seeds.reset_script if seeds.reset_script in files else None
    reset_script = files[reset_path] if reset_path is not None else None
    other_seed_files = {
        path: content
        for path, content in files.items()
        if path.startswith(SEEDS_FOLDER) and path != reset_path
    }
    return SeedMaterial(
        reset_script_path=reset_path,
        hash_command=seeds.hash_command,
        declared_hash=seeds.expected_hash,
        material_sha256=material_digest(
            reset_path, reset_script, seeds.hash_command, seeds.dsn_env, other_seed_files
        ),
    )


def resolve_truth_source(manifest: BundleManifest, sidecar: OracleSidecar) -> TruthSource | None:
    if sidecar.truth_source is not None:
        return next(
            (source for source in manifest.truth_sources if source.id == sidecar.truth_source),
            None,
        )
    if len(manifest.truth_sources) == 1:
        return manifest.truth_sources[0]
    return None


def is_proven_read_only(
    sidecar: OracleSidecar, source_text: str, truth: TruthSource | None
) -> bool:
    if sidecar.language != OracleLanguage.sql.value or truth is None or truth.kind != "database":
        return False
    return lint_sql_oracle(source_text, truth.dialect).ok


def load_sidecar(path: str, files: Mapping[str, bytes]) -> OracleSidecar | None:
    document = load_yaml_document(files[path].decode("utf-8", errors="replace"), path)
    if document.data is None:
        return None
    try:
        return OracleSidecar.model_validate(document.data)
    except ValidationError:
        return None


def oracle_materials(manifest: BundleManifest, files: Mapping[str, bytes]) -> list[OracleMaterial]:
    materials: list[OracleMaterial] = []
    for name, paths in sorted(oracle_names_in(frozenset(files)).items()):
        sidecar_path = paths.get("sidecar")
        sidecar = load_sidecar(sidecar_path, files) if sidecar_path is not None else None
        if sidecar is None or sidecar.name != name:
            continue
        source_path = paths.get(sidecar.language)
        if source_path is None:
            continue
        source_text = files[source_path].decode("utf-8", errors="replace")
        truth = resolve_truth_source(manifest, sidecar)
        materials.append(
            OracleMaterial(
                name=name,
                feature_ids=list(sidecar.feature_ids),
                language=OracleLanguage(sidecar.language),
                source=source_text,
                params_schema=dict(sidecar.params_schema),
                sentence_template=sidecar.sentence_template,
                read_only_verified=is_proven_read_only(sidecar, source_text, truth),
                truth_source=truth.id if truth is not None else sidecar.truth_source,
                gold_points=[point.model_dump(mode="json") for point in sidecar.gold_points],
            )
        )
    return materials


async def latest_seed(session: AsyncSession, target_id: uuid.UUID) -> SeedRow | None:
    return await session.scalar(
        select(SeedRow)
        .where(SeedRow.target_id == target_id)
        .order_by(SeedRow.version.desc())
        .limit(1)
    )


def bundle_declared_hash(row: SeedRow) -> str | None:
    return row.declared_hash if row.hash_source is SeedHashSource.bundle else None


def seed_changed(previous: SeedRow, material: SeedMaterial) -> bool:
    return (
        previous.material_sha256 != material.material_sha256
        or bundle_declared_hash(previous) != material.declared_hash
    )


def new_seed_row(bundle: BundleRow, version: int, material: SeedMaterial) -> SeedRow:
    declared = material.declared_hash is not None
    return SeedRow(
        target_id=bundle.target_id,
        bundle_id=bundle.id,
        version=version,
        declared_hash=material.declared_hash,
        hash_source=SeedHashSource.bundle if declared else SeedHashSource.first_reset,
        reset_script_path=material.reset_script_path,
        hash_command=material.hash_command,
        material_sha256=material.material_sha256,
    )


async def import_seed(
    session: AsyncSession, bundle: BundleRow, material: SeedMaterial | None
) -> tuple[SeedRow | None, bool]:
    previous = await latest_seed(session, bundle.target_id)
    if material is None:
        return previous, False
    if previous is not None and not seed_changed(previous, material):
        return previous, False
    row = new_seed_row(bundle, (previous.version if previous else 0) + 1, material)
    session.add(row)
    await session.flush()
    return row, True


def new_oracle_row(bundle: BundleRow, material: OracleMaterial) -> OracleTemplateRow:
    return OracleTemplateRow(
        bundle_id=bundle.id,
        target_id=bundle.target_id,
        name=material.name,
        feature_ids=material.feature_ids,
        language=material.language,
        source=material.source,
        params_schema=material.params_schema,
        sentence_template=material.sentence_template,
        read_only_verified=material.read_only_verified,
        truth_source=material.truth_source,
        gold_points=material.gold_points,
    )


async def import_oracles(
    session: AsyncSession, bundle: BundleRow, materials: list[OracleMaterial]
) -> int:
    if not materials:
        return 0
    existing = set(
        (
            await session.scalars(
                select(OracleTemplateRow.name).where(OracleTemplateRow.bundle_id == bundle.id)
            )
        ).all()
    )
    created = [new_oracle_row(bundle, item) for item in materials if item.name not in existing]
    session.add_all(created)
    await session.flush()
    return len(created)


async def import_truth(
    session: AsyncSession,
    bundle: BundleRow,
    manifest: BundleManifest,
    files: Mapping[str, bytes],
    include_seed: bool = True,
) -> TruthImport:
    seed: SeedRow | None = None
    seed_created = False
    if include_seed:
        seed, seed_created = await import_seed(session, bundle, seed_material(manifest, files))
    oracles_created = await import_oracles(session, bundle, oracle_materials(manifest, files))
    return TruthImport(seed=seed, seed_created=seed_created, oracles_created=oracles_created)
