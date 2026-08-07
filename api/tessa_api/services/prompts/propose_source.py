import uuid
from collections.abc import Collection, Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.errors import ApiError
from tessa_api.schemas.catalog import Catalog
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.prompts import ProposePromptParams
from tessa_api.services.catalog_builder import CatalogFilters, read_catalog
from tessa_api.services.plans import latest_valid_bundle
from tessa_api.services.prompts.propose import (
    PreviousItem,
    ProposeArea,
    ProposeFeature,
    ProposeInputs,
)
from tessa_api.services.proposals import current_items
from tessa_api.services.run_guard import ensure_bundle_usable


def unknown_areas_error(focus: Sequence[str], known: Collection[str]) -> ApiError | None:
    details = [
        ErrorDetail(
            loc=["body", "focus", position],
            code="unknown_area",
            message=f"The catalog has no area {name!r}; areas: {', '.join(sorted(known))}",
        )
        for position, name in enumerate(focus)
        if name not in known
    ]
    if not details:
        return None
    return ApiError(422, "validation_failed", "Request validation failed", details)


def areas_of(catalog: Catalog) -> tuple[ProposeArea, ...]:
    return tuple(
        ProposeArea(
            name=area.name,
            features=tuple(
                ProposeFeature(
                    feature_id=item.feature_id,
                    kind=item.kind.value,
                    description=item.description,
                )
                for item in area.items
            ),
        )
        for area in catalog.areas
    )


async def load_propose_inputs(
    session: AsyncSession,
    target: TargetRow,
    params: ProposePromptParams,
    issue_id: uuid.UUID,
) -> tuple[ProposeInputs, BundleRow]:
    bundle = ensure_bundle_usable(await latest_valid_bundle(session, target.id))
    catalog = await read_catalog(session, target.id, bundle.id, CatalogFilters())
    areas = areas_of(catalog)
    focus = tuple(dict.fromkeys(params.focus))
    if (problem := unknown_areas_error(focus, {area.name for area in areas})) is not None:
        raise problem
    previous = tuple(
        PreviousItem(key=item.key, title=item.title, status=item.status.value)
        for item in await current_items(session, target.id)
    )
    inputs = ProposeInputs(
        issue_id=issue_id,
        bundle_version=bundle.version,
        areas=areas,
        focus=focus,
        since_commit=params.since_commit,
        previous=previous,
    )
    return inputs, bundle
