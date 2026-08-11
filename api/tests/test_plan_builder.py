import random
import uuid
from typing import Any

import pytest

from tessa_api.schemas.catalog import (
    Catalog,
    CatalogArea,
    CatalogExample,
    CatalogInterface,
    CatalogItem,
    CatalogRole,
)
from tessa_api.schemas.enums import (
    AdapterKind,
    Confidence,
    EnvVarKind,
    FeatureKind,
    InterfaceMode,
    SkipReason,
)
from tessa_api.schemas.plans import PlanSelection
from tessa_api.services.plan_builder import (
    SUPPORTED_ADAPTER_KINDS,
    EnvironmentVariableState,
    PlanningContext,
    build_planning_context,
    expand_cells,
    family_for_area,
    is_write_feature,
    required_hooks,
    runnable_cells,
)

ROLES = ("staff", "manager", "admin")
INTERFACES = (
    ("chat_sse", AdapterKind.sse),
    ("browser", AdapterKind.browser),
    ("admin_api", AdapterKind.http),
    ("live", AdapterKind.websocket),
)


def item(
    feature_id: str,
    area: str = "Smart Log",
    kind: FeatureKind = FeatureKind.read,
    interfaces: tuple[str, ...] = ("chat_sse",),
    roles: tuple[str, ...] = ("all",),
    preconditions: tuple[str, ...] = (),
    cleanup: str = "none",
    writes_to: str | None = None,
) -> CatalogItem:
    return CatalogItem(
        id=uuid.uuid4(),
        bundle_id=uuid.UUID(int=1),
        feature_id=feature_id,
        area=area,
        kind=kind,
        description="d",
        interface_ids=list(interfaces),
        roles=list(roles),
        flag="none",
        preconditions=list(preconditions),
        examples=[CatalogExample(ask="hi", expected="e")],
        invariants=[],
        cleanup=cleanup,
        confidence=Confidence.high,
        writes_to=writes_to,
    )


def catalog_of(*items: CatalogItem) -> Catalog:
    areas: dict[str, list[CatalogItem]] = {}
    for entry in items:
        areas.setdefault(entry.area, []).append(entry)
    return Catalog(
        bundle_id=uuid.UUID(int=1),
        bundle_version=3,
        roles=[
            CatalogRole(id=role, level=index, description="r") for index, role in enumerate(ROLES)
        ],
        interfaces=[
            CatalogInterface(id=interface_id, kind=kind, base_path="/")
            for interface_id, kind in INTERFACES
        ],
        areas=[CatalogArea(name=name, items=entries) for name, entries in areas.items()],
    )


def selection(**overrides: Any) -> PlanSelection:
    base: dict[str, Any] = {
        "feature_ids": [],
        "area_ids": [],
        "roles": ["all"],
        "interface_mode": InterfaceMode.both,
        "depth": "smoke",
        "k": 1,
    }
    return PlanSelection.model_validate({**base, **overrides})


def keys(cells: Any) -> list[tuple[str, str, str]]:
    return [(cell.feature_id, cell.role, cell.interface_id) for cell in cells]


def test_features_roles_and_interfaces_multiply_into_unique_cells() -> None:
    catalog = catalog_of(
        item("a.read.x", interfaces=("chat_sse", "browser")),
        item("a.read.y", roles=("staff", "admin"), interfaces=("admin_api",)),
    )
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x", "a.read.y"]))
    assert keys(expansion.cells) == [
        ("a.read.x", "staff", "chat_sse"),
        ("a.read.x", "staff", "browser"),
        ("a.read.x", "manager", "chat_sse"),
        ("a.read.x", "manager", "browser"),
        ("a.read.x", "admin", "chat_sse"),
        ("a.read.x", "admin", "browser"),
        ("a.read.y", "staff", "admin_api"),
        ("a.read.y", "admin", "admin_api"),
    ]
    assert expansion.skipped == ()
    assert expansion.warnings == ()


def test_an_area_selects_every_feature_in_it() -> None:
    catalog = catalog_of(item("a.read.x"), item("a.read.y"), item("b.read.z", area="Rooms"))
    expansion = expand_cells(catalog, selection(area_ids=["Smart Log"]))
    assert {cell.feature_id for cell in expansion.cells} == {"a.read.x", "a.read.y"}
    both = expand_cells(catalog, selection(area_ids=["Smart Log"], feature_ids=["b.read.z"]))
    assert {cell.feature_id for cell in both.cells} == {"a.read.x", "a.read.y", "b.read.z"}


def test_the_family_is_the_slug_of_the_area() -> None:
    catalog = catalog_of(item("a.read.x", area="Smart Log"), item("b.read.z", area="  Café & Bar!"))
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x", "b.read.z"]))
    assert {cell.family for cell in expansion.cells} == {"smart-log", "cafe-bar"}
    assert family_for_area("日本語") == "general"


def test_all_expands_to_the_roles_the_feature_allows() -> None:
    catalog = catalog_of(item("a.read.x", roles=("all",)), item("a.read.y", roles=("manager",)))
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x", "a.read.y"]))
    assert {cell.role for cell in expansion.cells if cell.feature_id == "a.read.x"} == set(ROLES)
    assert {cell.role for cell in expansion.cells if cell.feature_id == "a.read.y"} == {"manager"}


def test_explicit_roles_narrow_the_cells_and_an_empty_list_means_every_role() -> None:
    catalog = catalog_of(item("a.read.x"))
    narrowed = expand_cells(catalog, selection(feature_ids=["a.read.x"], roles=["manager"]))
    assert {cell.role for cell in narrowed.cells} == {"manager"}
    unrestricted = expand_cells(catalog, selection(feature_ids=["a.read.x"], roles=[]))
    assert {cell.role for cell in unrestricted.cells} == set(ROLES)


def test_a_role_the_feature_does_not_allow_makes_the_whole_feature_skip() -> None:
    catalog = catalog_of(item("a.read.x", roles=("admin",)))
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"], roles=["staff"]))
    assert expansion.cells == ()
    assert [(s.feature_id, s.role, s.interface_id, s.reason) for s in expansion.skipped] == [
        ("a.read.x", None, None, SkipReason.role_unavailable)
    ]


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        (InterfaceMode.api_only, {"chat_sse", "admin_api", "live"}),
        (InterfaceMode.browser_only, {"browser"}),
        (InterfaceMode.both, {"chat_sse", "browser", "admin_api", "live"}),
    ],
)
def test_the_interface_mode_filters_interfaces_by_kind(
    mode: InterfaceMode, expected: set[str]
) -> None:
    catalog = catalog_of(item("a.read.x", interfaces=("chat_sse", "browser", "admin_api", "live")))
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"], interface_mode=mode))
    assert {cell.interface_id for cell in expansion.cells} == expected


def test_a_feature_whose_interfaces_are_all_filtered_out_is_skipped_as_unsupported() -> None:
    catalog = catalog_of(item("a.read.x", interfaces=("browser",)))
    expansion = expand_cells(
        catalog, selection(feature_ids=["a.read.x"], interface_mode=InterfaceMode.api_only)
    )
    assert expansion.cells == ()
    assert expansion.skipped[0].reason is SkipReason.adapter_unsupported


def test_every_adapter_kind_is_plannable_so_a_websocket_interface_gives_a_runnable_cell() -> None:
    assert set(AdapterKind) == SUPPORTED_ADAPTER_KINDS
    catalog = catalog_of(item("a.read.x", interfaces=("live", "chat_sse")))
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"], roles=["staff"]))
    reasons = {cell.interface_id: cell.skip_reason for cell in expansion.cells}
    assert reasons == {"live": None, "chat_sse": None}
    assert expansion.skipped == ()
    assert not any("not supported yet" in warning for warning in expansion.warnings)
    assert sorted(keys(runnable_cells(expansion.cells))) == [
        ("a.read.x", "staff", "chat_sse"),
        ("a.read.x", "staff", "live"),
    ]


def test_unknown_selection_ids_become_warnings_not_cells() -> None:
    catalog = catalog_of(item("a.read.x"))
    expansion = expand_cells(
        catalog,
        selection(
            feature_ids=["a.read.x", "b.read.y"], area_ids=["Nowhere"], roles=["staff", "boss"]
        ),
    )
    assert len(expansion.cells) == 1
    assert expansion.warnings == (
        "Feature b.read.y is not in bundle v3 and was ignored",
        "Area Nowhere is not in bundle v3 and was ignored",
        "Role boss is not in bundle v3 and was ignored",
    )


def test_an_empty_selection_expands_to_nothing() -> None:
    catalog = catalog_of(item("a.read.x"))
    assert expand_cells(catalog, selection()).cells == ()


def test_expansion_is_deterministic_and_repeatable() -> None:
    catalog = catalog_of(item("a.read.x", interfaces=("chat_sse", "browser")), item("a.read.y"))
    chosen = selection(feature_ids=["a.read.y", "a.read.x"])
    assert expand_cells(catalog, chosen) == expand_cells(catalog, chosen)


def random_catalog(rng: random.Random) -> Catalog:
    features = []
    for index in range(rng.randint(1, 8)):
        features.append(
            item(
                f"f.read.{index}",
                area=rng.choice(["Alpha", "Beta", "Gamma"]),
                interfaces=tuple(
                    rng.sample([name for name, _ in INTERFACES], rng.randint(1, len(INTERFACES)))
                ),
                roles=rng.choice([("all",), ("staff",), ("staff", "admin"), ("manager", "admin")]),
            )
        )
    return catalog_of(*features)


def random_selection(rng: random.Random, catalog: Catalog) -> PlanSelection:
    feature_ids = [entry.feature_id for area in catalog.areas for entry in area.items]
    return selection(
        feature_ids=rng.sample(feature_ids, rng.randint(0, len(feature_ids))),
        area_ids=rng.sample(["Alpha", "Beta", "Gamma", "Delta"], rng.randint(0, 2)),
        roles=rng.choice([["all"], ["staff"], ["manager", "admin"], [], ["staff", "ghost"]]),
        interface_mode=rng.choice(list(InterfaceMode)),
    )


@pytest.mark.parametrize("seed", range(40))
def test_cells_are_always_a_subset_of_the_selection_and_unique(seed: int) -> None:
    rng = random.Random(seed)
    catalog = random_catalog(rng)
    chosen = random_selection(rng, catalog)
    expansion = expand_cells(catalog, chosen)
    items = {entry.feature_id: entry for area in catalog.areas for entry in area.items}
    kinds = {interface.id: interface.kind for interface in catalog.interfaces}
    assert len(keys(expansion.cells)) == len(set(keys(expansion.cells)))
    for cell in expansion.cells:
        entry = items[cell.feature_id]
        assert cell.feature_id in chosen.feature_ids or entry.area in chosen.area_ids
        assert cell.interface_id in entry.interface_ids
        assert "all" in entry.roles or cell.role in entry.roles
        assert cell.role in ROLES
        if chosen.roles and "all" not in chosen.roles:
            assert cell.role in chosen.roles
        if chosen.interface_mode is InterfaceMode.api_only:
            assert kinds[cell.interface_id] is not AdapterKind.browser
        if chosen.interface_mode is InterfaceMode.browser_only:
            assert kinds[cell.interface_id] is AdapterKind.browser
        assert cell.family == family_for_area(entry.area)
    for item_skipped in expansion.skipped:
        assert item_skipped.feature_id in items


@pytest.mark.parametrize("seed", range(20))
def test_both_is_the_union_of_api_only_and_browser_only(seed: int) -> None:
    rng = random.Random(seed)
    catalog = random_catalog(rng)
    base = random_selection(rng, catalog).model_dump()
    results = {
        mode: set(
            keys(
                expand_cells(
                    catalog, PlanSelection.model_validate({**base, "interface_mode": mode})
                ).cells
            )
        )
        for mode in InterfaceMode
    }
    assert (
        results[InterfaceMode.both]
        == results[InterfaceMode.api_only] | results[InterfaceMode.browser_only]
    )
    assert results[InterfaceMode.api_only].isdisjoint(results[InterfaceMode.browser_only])


def variable(
    name: str,
    interfaces: tuple[str, ...] = (),
    kind: EnvVarKind = EnvVarKind.string,
    required: bool = True,
    has_value: bool = True,
) -> EnvironmentVariableState:
    return EnvironmentVariableState(
        name=name,
        kind=kind,
        required=required,
        interface_ids=frozenset(interfaces),
        has_value=has_value,
    )


def manifest(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "roles": [
            {"id": "staff", "credential_env": "STAFF_PASSWORD"},
            {"id": "manager", "credential_env": "MANAGER_TOKEN"},
            {"id": "admin"},
        ],
        "interfaces": [
            {"id": "chat_sse", "kind": "sse", "base_path": "/api/chat"},
            {"id": "browser", "kind": "browser", "base_path": "/"},
            {"id": "admin_api", "kind": "http", "base_path": "https://${ADMIN_HOST}/api"},
            {"id": "live", "kind": "websocket", "base_path": "/ws"},
        ],
        "test_hooks": {"available": [{"id": "health"}], "missing": [{"id": "pin_clock"}]},
    }
    return {**base, **overrides}


def context(
    variables: list[EnvironmentVariableState], read_only: bool = False, **manifest_overrides: Any
) -> PlanningContext:
    return build_planning_context(manifest(**manifest_overrides), variables, read_only)


READY = [
    variable("BASE_URL", ("chat_sse", "browser"), EnvVarKind.url),
    variable("STAFF_PASSWORD", ("chat_sse", "browser"), EnvVarKind.password),
    variable("MANAGER_TOKEN", ("chat_sse",), EnvVarKind.token),
    variable("ADMIN_HOST", (), EnvVarKind.string),
    variable("ADMIN_API_URL", ("admin_api",), EnvVarKind.url),
]


def reasons(expansion: Any) -> dict[tuple[str, str, str], SkipReason | None]:
    return {(c.feature_id, c.role, c.interface_id): c.skip_reason for c in expansion.cells}


def test_a_ready_environment_skips_nothing() -> None:
    catalog = catalog_of(item("a.read.x", interfaces=("chat_sse", "browser")))
    expansion = expand_cells(
        catalog, selection(feature_ids=["a.read.x"], roles=["staff"]), context(READY)
    )
    assert set(reasons(expansion).values()) == {None}


def test_a_missing_credential_makes_that_role_unavailable_only() -> None:
    catalog = catalog_of(item("a.read.x"))
    variables = [
        v
        if v.name != "MANAGER_TOKEN"
        else variable("MANAGER_TOKEN", ("chat_sse",), EnvVarKind.token, has_value=False)
        for v in READY
    ]
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"]), context(variables))
    assert reasons(expansion) == {
        ("a.read.x", "staff", "chat_sse"): None,
        ("a.read.x", "manager", "chat_sse"): SkipReason.role_unavailable,
        ("a.read.x", "admin", "chat_sse"): None,
    }


def test_another_roles_credential_is_not_needed_for_this_role() -> None:
    catalog = catalog_of(item("a.read.x"))
    variables = [
        variable("BASE_URL", ("chat_sse",), EnvVarKind.url),
        variable("STAFF_PASSWORD", ("chat_sse",), EnvVarKind.password),
        variable("MANAGER_TOKEN", ("chat_sse",), EnvVarKind.token, has_value=False),
    ]
    expansion = expand_cells(
        catalog, selection(feature_ids=["a.read.x"], roles=["staff"]), context(variables)
    )
    assert set(reasons(expansion).values()) == {None}


def test_a_missing_required_interface_variable_skips_every_role_as_env_missing() -> None:
    catalog = catalog_of(item("a.read.x"))
    variables = [variable("BASE_URL", ("chat_sse",), EnvVarKind.url, has_value=False), *READY[1:]]
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"]), context(variables))
    assert set(reasons(expansion).values()) == {SkipReason.env_missing}


def test_an_optional_missing_variable_never_skips() -> None:
    catalog = catalog_of(item("a.read.x"))
    variables = [*READY, variable("NICE_TO_HAVE", ("chat_sse",), required=False, has_value=False)]
    expansion = expand_cells(catalog, selection(feature_ids=["a.read.x"]), context(variables))
    assert set(reasons(expansion).values()) == {None}


def test_an_interface_without_a_url_variable_is_env_missing_unless_its_address_is_absolute() -> (
    None
):
    catalog = catalog_of(item("a.read.x", interfaces=("chat_sse", "admin_api")))
    without_url = [v for v in READY if v.name != "BASE_URL"]
    expansion = expand_cells(
        catalog, selection(feature_ids=["a.read.x"], roles=["admin"]), context(without_url)
    )
    assert reasons(expansion) == {
        ("a.read.x", "admin", "chat_sse"): SkipReason.env_missing,
        ("a.read.x", "admin", "admin_api"): None,
    }
    placeholder_missing = [v for v in without_url if v.name != "ADMIN_HOST"]
    expansion = expand_cells(
        catalog,
        selection(feature_ids=["a.read.x"], roles=["admin"]),
        context([*placeholder_missing, variable("ADMIN_HOST", (), has_value=False)]),
    )
    assert reasons(expansion)[("a.read.x", "admin", "admin_api")] is SkipReason.env_missing


def test_a_precondition_that_needs_a_missing_hook_skips_the_feature() -> None:
    catalog = catalog_of(
        item("a.read.x", preconditions=("clock.pinned",)),
        item("a.read.y", preconditions=("hook.health",)),
        item("a.read.z", preconditions=("hook:flush_cache",)),
        item("a.read.w", preconditions=("seed.history",)),
    )
    expansion = expand_cells(
        catalog,
        selection(feature_ids=["a.read.x", "a.read.y", "a.read.z", "a.read.w"], roles=["staff"]),
        context(READY),
    )
    assert reasons(expansion) == {
        ("a.read.x", "staff", "chat_sse"): SkipReason.hook_missing,
        ("a.read.y", "staff", "chat_sse"): None,
        ("a.read.z", "staff", "chat_sse"): SkipReason.hook_missing,
        ("a.read.w", "staff", "chat_sse"): None,
    }
    assert [(s.feature_id, s.role, s.reason) for s in expansion.skipped] == [
        ("a.read.x", None, SkipReason.hook_missing),
        ("a.read.z", None, SkipReason.hook_missing),
    ]


def test_a_pin_clock_hook_that_exists_lets_clock_features_run() -> None:
    catalog = catalog_of(item("a.read.x", preconditions=("clock.pinned",)))
    available = {"available": [{"id": "pin_clock"}], "missing": []}
    expansion = expand_cells(
        catalog,
        selection(feature_ids=["a.read.x"], roles=["staff"]),
        context(READY, test_hooks=available),
    )
    assert set(reasons(expansion).values()) == {None}


def test_required_hooks_reads_the_documented_precondition_forms() -> None:
    assert required_hooks(
        item("a", preconditions=("clock.pinned", "hook.a", "hook:b", "hook.", "seed.x"))
    ) == {
        "pin_clock",
        "a",
        "b",
    }


@pytest.mark.parametrize(
    ("kind", "cleanup", "writes_to", "expected"),
    [
        (FeatureKind.read, "none", None, False),
        (FeatureKind.write, "none", None, True),
        (FeatureKind.admin, "none", None, True),
        (FeatureKind.job, "none", None, True),
        (FeatureKind.auth, "none", None, False),
        (FeatureKind.stream, "none", None, False),
        (FeatureKind.read, "none", "issue", True),
        (FeatureKind.flow, "delete the issue", None, True),
        (FeatureKind.flow, "none", None, False),
    ],
)
def test_write_features_are_recognised(
    kind: FeatureKind, cleanup: str, writes_to: str | None, expected: bool
) -> None:
    assert is_write_feature(item("a", kind=kind, cleanup=cleanup, writes_to=writes_to)) is expected


def test_a_read_only_run_skips_write_features_once_per_feature() -> None:
    catalog = catalog_of(
        item("a.write.x", kind=FeatureKind.write, interfaces=("chat_sse", "browser")),
        item("a.read.y"),
    )
    expansion = expand_cells(
        catalog,
        selection(feature_ids=["a.write.x", "a.read.y"], roles=["staff"]),
        context(READY, read_only=True),
    )
    assert reasons(expansion) == {
        ("a.write.x", "staff", "chat_sse"): SkipReason.production_blocked,
        ("a.write.x", "staff", "browser"): SkipReason.production_blocked,
        ("a.read.y", "staff", "chat_sse"): None,
    }
    assert [(s.feature_id, s.role, s.interface_id) for s in expansion.skipped] == [
        ("a.write.x", None, None)
    ]
    assert any(
        "read-only" in warning and "1 write feature" in warning for warning in expansion.warnings
    )
    writable = expand_cells(
        catalog,
        selection(feature_ids=["a.write.x"], roles=["staff"]),
        context(READY, read_only=False),
    )
    assert set(reasons(writable).values()) == {None}


def test_requirements_list_the_names_a_cell_needs() -> None:
    planning = context(READY)
    needed = planning.requirements("staff", "chat_sse")
    assert [v.name for v in needed.variables] == ["BASE_URL", "STAFF_PASSWORD"]
    assert needed.credential_name == "STAFF_PASSWORD"
    assert needed.missing() == ()
    absolute = planning.requirements("admin", "admin_api")
    assert [v.name for v in absolute.variables] == ["ADMIN_HOST", "ADMIN_API_URL"]
    assert absolute.address_missing is False
