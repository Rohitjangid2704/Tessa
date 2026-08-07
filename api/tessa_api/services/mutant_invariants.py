import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.errors import ApiError
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.invariants import InvariantInfo
from tessa_api.services.invariants.catalog import build_catalog
from tessa_api.services.plans import latest_valid_bundle
from tessa_api.services.probe_specs import parse_manifest


@dataclass(frozen=True, slots=True)
class InvariantVocabulary:
    bundle: BundleRow | None
    infos: Mapping[str, InvariantInfo]

    def knows(self, invariant_id: str) -> bool:
        return invariant_id in self.infos

    def unknown_positions(self, invariant_ids: Sequence[str]) -> list[int]:
        return [
            position
            for position, invariant_id in enumerate(invariant_ids)
            if not self.knows(invariant_id)
        ]


def vocabulary_of(bundle: BundleRow | None, manifest: BundleManifest | None) -> InvariantVocabulary:
    return InvariantVocabulary(
        bundle=bundle, infos={item.id: item for item in build_catalog(manifest).items}
    )


async def load_invariant_vocabulary(
    session: AsyncSession, target_id: uuid.UUID
) -> InvariantVocabulary:
    bundle = await latest_valid_bundle(session, target_id)
    manifest = parse_manifest(bundle.manifest) if bundle is not None else None
    return vocabulary_of(bundle, manifest)


def unknown_invariant_detail(loc: Sequence[str | int], invariant_id: str) -> ErrorDetail:
    return ErrorDetail(
        loc=list(loc),
        code="unknown_invariant",
        message=f"{invariant_id!r} is neither a built-in invariant nor one the bundle of the "
        "target declares; read the ids from GET /invariants",
    )


def ensure_invariants_known(
    vocabulary: InvariantVocabulary, invariant_ids: Sequence[str], loc_prefix: Sequence[str]
) -> None:
    details = [
        unknown_invariant_detail([*loc_prefix, position], invariant_ids[position])
        for position in vocabulary.unknown_positions(invariant_ids)
    ]
    if details:
        raise ApiError(422, "validation_failed", "Request validation failed", details)
