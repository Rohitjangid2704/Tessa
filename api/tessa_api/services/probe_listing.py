import uuid
from collections.abc import Callable, Sequence
from functools import cmp_to_key

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.errors import ApiError
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import InvariantPack
from tessa_api.schemas.probes import ProbePage
from tessa_api.services.pagination import PageQuery, decode_cursor, encode_cursor
from tessa_api.services.plans import latest_valid_bundle
from tessa_api.services.probe_bank import ProbeBank, ProbeBankError, load_probe_bank
from tessa_api.services.probe_specs import ProbeSpec, listed_specs, parse_manifest
from tessa_api.services.settings_service import resolve_thresholds
from tessa_api.services.targets import get_target
from tessa_api.settings import Settings

SORT_VALUES: dict[str, Callable[[ProbeSpec], str]] = {
    "pack": lambda spec: spec.pack.value,
    "id": lambda spec: spec.id,
}


def invalid_bank_error(error: ProbeBankError) -> ApiError:
    return ApiError(500, "internal_error", f"The probe bank is invalid: {error}")


def read_bank(settings: Settings) -> ProbeBank:
    try:
        return load_probe_bank(settings.probes_dir)
    except ProbeBankError as error:
        raise invalid_bank_error(error) from None


async def target_manifest(session: AsyncSession, target_id: uuid.UUID) -> BundleManifest | None:
    await get_target(session, target_id)
    bundle: BundleRow | None = await latest_valid_bundle(session, target_id)
    return None if bundle is None else parse_manifest(bundle.manifest)


def matches_filters(spec: ProbeSpec, packs: Sequence[InvariantPack], query: str | None) -> bool:
    if packs and spec.pack not in packs:
        return False
    if not query:
        return True
    needle = query.casefold()
    return any(needle in text.casefold() for text in (spec.id, spec.question, spec.invariant_id))


def sort_values(spec: ProbeSpec, keys: Sequence[str]) -> list[str]:
    return [*(SORT_VALUES[key](spec) for key in keys), spec.id]


def compare_values(left: Sequence[str], right: Sequence[str], descending: Sequence[bool]) -> int:
    for first, second, is_descending in zip(left, right, descending, strict=True):
        if first != second:
            ordering = -1 if first < second else 1
            return -ordering if is_descending else ordering
    return 0


def order_specs(
    specs: Sequence[ProbeSpec], keys: Sequence[str], descending: Sequence[bool]
) -> list[ProbeSpec]:
    def compare(left: ProbeSpec, right: ProbeSpec) -> int:
        return compare_values(sort_values(left, keys), sort_values(right, keys), descending)

    return sorted(specs, key=cmp_to_key(compare))


def page_of(
    ordered: Sequence[ProbeSpec], keys: Sequence[str], descending: Sequence[bool], page: PageQuery
) -> tuple[list[ProbeSpec], str | None]:
    remaining = list(ordered)
    if page.cursor is not None:
        after = decode_cursor(page.cursor, page.sort_text, [str] * (len(keys) + 1))
        remaining = [
            spec
            for spec in remaining
            if compare_values(sort_values(spec, keys), after, descending) > 0
        ]
    items = remaining[: page.limit]
    next_cursor = None
    if len(remaining) > page.limit:
        next_cursor = encode_cursor(page.sort_text, sort_values(items[-1], keys))
    return items, next_cursor


async def list_probe_page(
    session: AsyncSession,
    settings: Settings,
    page: PageQuery,
    packs: Sequence[InvariantPack],
    query: str | None,
    target_id: uuid.UUID | None,
) -> ProbePage:
    manifest = None if target_id is None else await target_manifest(session, target_id)
    matching = [
        spec
        for spec in listed_specs(read_bank(settings), manifest)
        if matches_filters(spec, packs, query)
    ]
    keys = [term.key for term in page.sort]
    descending = [term.descending for term in page.sort] + [page.sort[0].descending]
    items, next_cursor = page_of(order_specs(matching, keys, descending), keys, descending, page)
    thresholds = await resolve_thresholds(session, settings)
    return ProbePage(
        items=[spec.to_probe(thresholds.probe_confidence) for spec in items],
        next_cursor=next_cursor,
        total=len(matching) if page.include_total else None,
    )
