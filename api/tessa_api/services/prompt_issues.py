import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    BundleRow,
    FindingRow,
    PromptIssueRow,
    PromptTemplateRow,
    Target,
    User,
)
from tessa_api.errors import ApiError, not_found
from tessa_api.ids import new_id
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import PromptTemplateName
from tessa_api.schemas.prompts import (
    AuthorPromptParams,
    DiscoveryPromptParams,
    ExplainPromptParams,
    FixupPromptParams,
    HooksPromptParams,
    MutantsPromptParams,
    PromptIssue,
    PromptIssuePage,
    PromptIssueParams,
    PromptTemplate,
    PromptTemplatePage,
    ProposePromptParams,
)
from tessa_api.services.app_kinds import known_hint_ids
from tessa_api.services.findings.explain_source import load_explain_inputs
from tessa_api.services.fixup_items import build_fixup_items, render_fixup_items
from tessa_api.services.pagination import PageQuery, SortableColumn, paginate, sortable
from tessa_api.services.prompt_composer import (
    PromptCompositionError,
    render_discovery,
    render_fixup,
)
from tessa_api.services.prompts.author import render_author
from tessa_api.services.prompts.author_source import (
    load_author_inputs,
    load_author_inputs_for_items,
)
from tessa_api.services.prompts.explain import render_explain
from tessa_api.services.prompts.hooks import render_hooks
from tessa_api.services.prompts.hooks_source import load_hooks_inputs
from tessa_api.services.prompts.mutants import render_mutants
from tessa_api.services.prompts.mutants_source import load_mutants_inputs
from tessa_api.services.prompts.propose import render_propose
from tessa_api.services.prompts.propose_source import load_propose_inputs
from tessa_api.services.targets import get_active_target, get_target
from tessa_api.settings import Settings

TEMPLATE_SORT_COLUMNS: dict[str, SortableColumn] = {
    "name": sortable(PromptTemplateRow.name, str),
    "version": sortable(PromptTemplateRow.version, int),
    "created_at": sortable(PromptTemplateRow.created_at, datetime),
}
TEMPLATE_ID_COLUMN = sortable(PromptTemplateRow.id, uuid.UUID)
ISSUE_SORT_COLUMNS: dict[str, SortableColumn] = {
    "issued_at": sortable(PromptIssueRow.issued_at, datetime),
}
ISSUE_ID_COLUMN = sortable(PromptIssueRow.id, uuid.UUID)


def to_template(row: PromptTemplateRow) -> PromptTemplate:
    return PromptTemplate(
        name=row.name,
        version=row.version,
        text=row.text,
        variables=list(row.variables),
        created_at=row.created_at,
    )


def to_issue(row: PromptIssueRow) -> PromptIssue:
    return PromptIssue(
        id=row.id,
        target_id=row.target_id,
        template_name=row.template_name,
        template_version=row.template_version,
        target_token=row.token,
        text=row.text,
        params=row.params,
        issued_by=row.issued_by,
        issued_at=row.issued_at,
    )


async def list_templates(session: AsyncSession, query: PageQuery) -> PromptTemplatePage:
    page = await paginate(
        session, select(PromptTemplateRow), TEMPLATE_SORT_COLUMNS, TEMPLATE_ID_COLUMN, query
    )
    return PromptTemplatePage(
        items=[to_template(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def read_template(
    session: AsyncSession, name: PromptTemplateName, version: int | None
) -> PromptTemplate:
    return to_template(await find_template(session, name, version))


async def find_template(
    session: AsyncSession, name: PromptTemplateName, version: int | None
) -> PromptTemplateRow:
    statement = select(PromptTemplateRow).where(PromptTemplateRow.name == name)
    if version is None:
        statement = statement.where(PromptTemplateRow.is_current.is_(True))
    else:
        statement = statement.where(PromptTemplateRow.version == version)
    row = await session.scalar(statement)
    if row is None:
        qualifier = "current" if version is None else f"version {version}"
        raise not_found(f"No {qualifier} {name.value} template")
    return row


def unknown_hint_error(target: Target, hint_ids: Sequence[str]) -> ApiError | None:
    allowed = known_hint_ids(target.app_kind)
    details = [
        ErrorDetail(
            loc=["body", "hint_ids", index],
            code="unknown_hint",
            message=f"Unknown hint {hint_id!r} for app kind {target.app_kind.value}; "
            f"allowed: {', '.join(allowed)}",
        )
        for index, hint_id in enumerate(hint_ids)
        if hint_id not in allowed
    ]
    if not details:
        return None
    return ApiError(422, "validation_failed", "Request validation failed", details)


def composition_failed(error: PromptCompositionError) -> ApiError:
    return ApiError(500, "internal_error", f"The prompt template cannot be rendered: {error}")


async def issue_discovery(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: DiscoveryPromptParams,
) -> PromptIssueRow:
    hint_ids = list(dict.fromkeys(params.hint_ids))
    if (hint_error := unknown_hint_error(target, hint_ids)) is not None:
        raise hint_error
    template = await find_template(session, PromptTemplateName.discovery, params.template_version)
    try:
        text = render_discovery(
            template.text,
            settings.public_api_url,
            target.target_token,
            target.app_kind,
            hint_ids,
        )
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        target_id=target.id,
        template_name=PromptTemplateName.discovery,
        template_version=template.version,
        token=target.target_token,
        params=params.model_copy(update={"hint_ids": hint_ids}).model_dump(mode="json"),
        text=text,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_fixup(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: FixupPromptParams,
) -> PromptIssueRow:
    bundle = await session.get(BundleRow, params.bundle_id)
    if bundle is None or bundle.target_id != target.id:
        raise not_found("Bundle not found for this target")
    template = await find_template(session, PromptTemplateName.fixup, None)
    items = build_fixup_items(bundle.errors, bundle.warnings, bundle.completeness)
    try:
        text = render_fixup(
            template.text,
            settings.public_api_url,
            target.target_token,
            bundle.version,
            int(bundle.completeness["score"]),
            int(bundle.completeness["bar"]),
            render_fixup_items(items),
        )
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        target_id=target.id,
        template_name=PromptTemplateName.fixup,
        template_version=template.version,
        token=target.target_token,
        params=params.model_dump(mode="json"),
        text=text,
        bundle_id=bundle.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_explain(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: ExplainPromptParams,
) -> PromptIssueRow:
    finding = await session.get(FindingRow, params.finding_id)
    if finding is None or finding.target_id != target.id:
        raise not_found("Finding not found for this target")
    template = await find_template(session, PromptTemplateName.explain, None)
    inputs = await load_explain_inputs(session, finding, target.target_token)
    try:
        rendered = render_explain(template.text, inputs, settings.explain_max_chars)
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        target_id=target.id,
        template_name=PromptTemplateName.explain,
        template_version=template.version,
        token=target.target_token,
        params={
            **params.model_dump(mode="json"),
            "masked_secret_hits": rendered.masked_hits,
            "elided": rendered.elided,
        },
        text=rendered.text,
        finding_id=finding.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_author(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: AuthorPromptParams,
) -> PromptIssueRow:
    template = await find_template(session, PromptTemplateName.author, None)
    issue_id = new_id()
    if params.proposal_item_ids is not None:
        inputs, bundle = await load_author_inputs_for_items(
            session, settings, target, params.proposal_item_ids, issue_id, user.id
        )
    else:
        inputs, bundle = await load_author_inputs(session, target, params.cell_ids or [], issue_id)
    try:
        text = render_author(template.text, settings.public_api_url, target.target_token, inputs)
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        id=issue_id,
        target_id=target.id,
        template_name=PromptTemplateName.author,
        template_version=template.version,
        token=target.target_token,
        params={
            **params.model_dump(mode="json"),
            "cell_ids": [str(cell.cell_id) for cell in inputs.cells],
            "bundle_version": bundle.version,
        },
        text=text,
        bundle_id=bundle.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_mutants(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: MutantsPromptParams,
) -> PromptIssueRow:
    template = await find_template(session, PromptTemplateName.mutants, None)
    inputs, bundle = await load_mutants_inputs(session, target, params.invariant_ids)
    try:
        rendered = render_mutants(template.text, settings.public_api_url, inputs)
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        target_id=target.id,
        template_name=PromptTemplateName.mutants,
        template_version=template.version,
        token=target.target_token,
        params={
            **params.model_dump(mode="json"),
            "invariant_ids": [item.invariant_id for item in inputs.invariants],
            "bundle_version": None if bundle is None else bundle.version,
            "masked_secret_hits": rendered.masked_hits,
            "elided": rendered.elided,
        },
        text=rendered.text,
        bundle_id=None if bundle is None else bundle.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_hooks(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: HooksPromptParams,
) -> PromptIssueRow:
    template = await find_template(session, PromptTemplateName.hooks, None)
    inputs, bundle = await load_hooks_inputs(session, target, params.bundle_id)
    try:
        rendered = render_hooks(template.text, settings.public_api_url, inputs)
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        target_id=target.id,
        template_name=PromptTemplateName.hooks,
        template_version=template.version,
        token=target.target_token,
        params={
            **params.model_dump(mode="json"),
            "bundle_version": bundle.version,
            "hook_ids": [item.hook_id for item in inputs.hooks],
            "masked_secret_hits": rendered.masked_hits,
            "elided": rendered.elided,
        },
        text=rendered.text,
        bundle_id=bundle.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_propose(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target: Target,
    params: ProposePromptParams,
) -> PromptIssueRow:
    template = await find_template(session, PromptTemplateName.propose, None)
    issue_id = new_id()
    inputs, bundle = await load_propose_inputs(session, target, params, issue_id)
    try:
        text = render_propose(template.text, settings.public_api_url, target.target_token, inputs)
    except PromptCompositionError as error:
        raise composition_failed(error) from error
    return PromptIssueRow(
        id=issue_id,
        target_id=target.id,
        template_name=PromptTemplateName.propose,
        template_version=template.version,
        token=target.target_token,
        params={
            **params.model_dump(mode="json"),
            "focus": list(inputs.focus),
            "bundle_version": bundle.version,
            "previous_items": len(inputs.previous),
        },
        text=text,
        bundle_id=bundle.id,
        issued_by=user.id,
        issued_at=datetime.now(UTC),
    )


async def issue_prompt(
    session: AsyncSession,
    settings: Settings,
    user: User,
    target_id: uuid.UUID,
    params: PromptIssueParams,
) -> PromptIssue:
    target = await get_active_target(session, target_id)
    if isinstance(params, DiscoveryPromptParams):
        row = await issue_discovery(session, settings, user, target, params)
    elif isinstance(params, FixupPromptParams):
        row = await issue_fixup(session, settings, user, target, params)
    elif isinstance(params, ExplainPromptParams):
        row = await issue_explain(session, settings, user, target, params)
    elif isinstance(params, AuthorPromptParams):
        row = await issue_author(session, settings, user, target, params)
    elif isinstance(params, MutantsPromptParams):
        row = await issue_mutants(session, settings, user, target, params)
    elif isinstance(params, ProposePromptParams):
        row = await issue_propose(session, settings, user, target, params)
    else:
        row = await issue_hooks(session, settings, user, target, params)
    session.add(row)
    await session.commit()
    return to_issue(row)


async def list_issues(
    session: AsyncSession,
    target_id: uuid.UUID,
    query: PageQuery,
    template_names: Sequence[PromptTemplateName] | None,
) -> PromptIssuePage:
    await get_target(session, target_id)
    statement = select(PromptIssueRow).where(PromptIssueRow.target_id == target_id)
    if template_names:
        statement = statement.where(PromptIssueRow.template_name.in_(list(template_names)))
    page = await paginate(session, statement, ISSUE_SORT_COLUMNS, ISSUE_ID_COLUMN, query)
    return PromptIssuePage(
        items=[to_issue(row[0]) for row in page.rows],
        next_cursor=page.next_cursor,
        total=page.total,
    )


async def read_issue(session: AsyncSession, prompt_issue_id: uuid.UUID) -> PromptIssue:
    row = await session.get(PromptIssueRow, prompt_issue_id)
    if row is None:
        raise not_found("Prompt issue not found")
    return to_issue(row)
