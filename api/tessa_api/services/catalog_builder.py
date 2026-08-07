import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, CatalogItemRow
from tessa_api.errors import not_found
from tessa_api.schemas.catalog import (
    Catalog,
    CatalogArea,
    CatalogExample,
    CatalogInterface,
    CatalogItem,
    CatalogRole,
)
from tessa_api.schemas.enums import AdapterKind, BundleValidationStatus, Confidence, FeatureKind
from tessa_api.services.targets import get_target

ALL_ROLES = "all"
SEARCH_ESCAPE = "\\"


@dataclass(frozen=True)
class CatalogFilters:
    areas: Sequence[str] = field(default_factory=tuple)
    kinds: Sequence[FeatureKind] = field(default_factory=tuple)
    roles: Sequence[str] = field(default_factory=tuple)
    interface_ids: Sequence[str] = field(default_factory=tuple)
    confidences: Sequence[Confidence] = field(default_factory=tuple)
    query: str | None = None


def string_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def catalog_rows(bundle_id: uuid.UUID, manifest: Mapping[str, Any]) -> list[CatalogItemRow]:
    rows: list[CatalogItemRow] = []
    seen: set[str] = set()
    features = manifest.get("features")
    for feature in features if isinstance(features, list) else []:
        if not isinstance(feature, Mapping) or feature["id"] in seen:
            continue
        seen.add(feature["id"])
        examples = feature.get("examples")
        rows.append(
            CatalogItemRow(
                bundle_id=bundle_id,
                feature_id=feature["id"],
                area=feature["area"],
                kind=FeatureKind(feature["kind"]),
                description=feature["description"],
                interface_ids=string_list(feature.get("interfaces")),
                roles=string_list(feature.get("roles")),
                flag=feature.get("flag") or "none",
                preconditions=string_list(feature.get("preconditions")),
                examples=list(examples) if isinstance(examples, list) else [],
                invariants=string_list(feature.get("invariants")),
                cleanup=feature.get("cleanup") or "none",
                confidence=Confidence(feature.get("confidence") or Confidence.medium.value),
                raw=dict(feature),
            )
        )
    return rows


def to_catalog_item(row: CatalogItemRow) -> CatalogItem:
    return CatalogItem(
        id=row.id,
        bundle_id=row.bundle_id,
        feature_id=row.feature_id,
        area=row.area,
        kind=row.kind,
        description=row.description,
        interface_ids=list(row.interface_ids),
        roles=list(row.roles),
        flag=row.flag,
        preconditions=list(row.preconditions),
        examples=[CatalogExample.model_validate(example) for example in row.examples],
        invariants=list(row.invariants),
        cleanup=row.cleanup,
        confidence=row.confidence,
        writes_to=row.raw.get("writes_to"),
        confirmation=row.raw.get("confirmation"),
        expect_db=row.raw.get("expect_db"),
    )


def escape_like(text: str) -> str:
    return (
        text.replace(SEARCH_ESCAPE, SEARCH_ESCAPE * 2)
        .replace("%", f"{SEARCH_ESCAPE}%")
        .replace("_", f"{SEARCH_ESCAPE}_")
    )


def filter_conditions(bundle_id: uuid.UUID, filters: CatalogFilters) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = [CatalogItemRow.bundle_id == bundle_id]
    if filters.areas:
        conditions.append(CatalogItemRow.area.in_(list(filters.areas)))
    if filters.kinds:
        conditions.append(CatalogItemRow.kind.in_(list(filters.kinds)))
    if filters.confidences:
        conditions.append(CatalogItemRow.confidence.in_(list(filters.confidences)))
    if filters.roles:
        conditions.append(CatalogItemRow.roles.overlap([*filters.roles, ALL_ROLES]))
    if filters.interface_ids:
        conditions.append(CatalogItemRow.interface_ids.overlap(list(filters.interface_ids)))
    if filters.query:
        pattern = f"%{escape_like(filters.query.strip())}%"
        conditions.append(
            or_(
                CatalogItemRow.feature_id.ilike(pattern, escape=SEARCH_ESCAPE),
                CatalogItemRow.description.ilike(pattern, escape=SEARCH_ESCAPE),
                CatalogItemRow.area.ilike(pattern, escape=SEARCH_ESCAPE),
            )
        )
    return conditions


def catalog_roles(manifest: Mapping[str, Any]) -> list[CatalogRole]:
    roles = manifest.get("roles")
    return [
        CatalogRole(
            id=str(role["id"]),
            level=int(role.get("level", 0)),
            description=str(role.get("description", "")),
        )
        for role in (roles if isinstance(roles, list) else [])
        if isinstance(role, Mapping) and "id" in role
    ]


def catalog_interfaces(manifest: Mapping[str, Any]) -> list[CatalogInterface]:
    interfaces = manifest.get("interfaces")
    return [
        CatalogInterface(
            id=str(interface["id"]),
            kind=AdapterKind(interface["kind"]),
            base_path=str(interface.get("base_path", "")),
        )
        for interface in (interfaces if isinstance(interfaces, list) else [])
        if isinstance(interface, Mapping) and "id" in interface and "kind" in interface
    ]


def empty_catalog(bundle_id: uuid.UUID | None, bundle_version: int | None) -> Catalog:
    return Catalog(
        bundle_id=bundle_id, bundle_version=bundle_version, roles=[], interfaces=[], areas=[]
    )


async def resolve_catalog_bundle(
    session: AsyncSession, target_id: uuid.UUID, bundle_id: uuid.UUID | None
) -> BundleRow | None:
    if bundle_id is not None:
        bundle = await session.get(BundleRow, bundle_id)
        if bundle is None or bundle.target_id != target_id:
            raise not_found("Bundle not found for this target")
        return bundle
    return await session.scalar(
        select(BundleRow)
        .where(
            BundleRow.target_id == target_id,
            BundleRow.validation_status == BundleValidationStatus.valid,
        )
        .order_by(BundleRow.version.desc())
        .limit(1)
    )


async def read_catalog(
    session: AsyncSession,
    target_id: uuid.UUID,
    bundle_id: uuid.UUID | None,
    filters: CatalogFilters,
) -> Catalog:
    await get_target(session, target_id)
    bundle = await resolve_catalog_bundle(session, target_id, bundle_id)
    if bundle is None:
        return empty_catalog(None, None)
    if bundle.validation_status is not BundleValidationStatus.valid or bundle.manifest is None:
        return empty_catalog(bundle.id, bundle.version)
    rows = (
        await session.scalars(
            select(CatalogItemRow)
            .where(and_(*filter_conditions(bundle.id, filters)))
            .order_by(func.lower(CatalogItemRow.area), CatalogItemRow.area, CatalogItemRow.id)
        )
    ).all()
    areas: dict[str, list[CatalogItem]] = {}
    for row in rows:
        areas.setdefault(row.area, []).append(to_catalog_item(row))
    return Catalog(
        bundle_id=bundle.id,
        bundle_version=bundle.version,
        roles=catalog_roles(bundle.manifest),
        interfaces=catalog_interfaces(bundle.manifest),
        areas=[CatalogArea(name=name, items=items) for name, items in areas.items()],
    )


async def read_catalog_item(session: AsyncSession, catalog_item_id: uuid.UUID) -> CatalogItem:
    row = await session.get(CatalogItemRow, catalog_item_id)
    if row is None:
        raise not_found("Catalog item not found")
    return to_catalog_item(row)
