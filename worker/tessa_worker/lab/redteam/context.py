from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, RunRow
from tessa_api.schemas.bundle import BundleManifest, Role
from tessa_api.schemas.enums import RunKind
from tessa_api.schemas.redteam import FamilyId
from tessa_api.services.plans import build_context
from tessa_api.services.probe_bank import ProbeBankError, load_probe_bank
from tessa_api.services.redteam_corpus import AttackFamily
from tessa_worker.lab.redteam.canary import CANARY_PLACEHOLDER
from tessa_worker.lab.redteam.errors import RedTeamErrorType, permanent_redteam_error
from tessa_worker.settings import WorkerSettings

LIST_ITEM_LIMIT = 6
BRIEF_TEXT_MAX_CHARS = 600
SEED_MAX_COUNT = 4


class FamilyBrief(BaseModel):
    id: FamilyId
    title: str
    objective: str
    tactics: list[str]
    uses_canary: bool
    seeds: list[str] = Field(
        max_length=SEED_MAX_COUNT, description="seed attack prompts an attacker may imitate"
    )


def clipped(text: str, limit: int = BRIEF_TEXT_MAX_CHARS) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 3]}..."


def not_ready(message: str) -> ApplicationError:
    return permanent_redteam_error(RedTeamErrorType.target_not_ready, message)


def manifest_of(bundle: BundleRow) -> BundleManifest:
    try:
        return BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        raise not_ready(f"bundle {bundle.id} has no valid manifest") from None


def seed_prompts(family: AttackFamily) -> list[str]:
    return [
        attack.prompt
        if attack.canary is None
        else attack.prompt.replace(attack.canary, CANARY_PLACEHOLDER)
        for attack in family.attacks[:SEED_MAX_COUNT]
    ]


def family_brief(family: AttackFamily) -> FamilyBrief:
    definition = family.definition
    return FamilyBrief(
        id=definition.id,
        title=definition.title,
        objective=definition.objective,
        tactics=list(definition.tactics),
        uses_canary=definition.uses_canary,
        seeds=seed_prompts(family),
    )


def ensure_probes_exist(settings: WorkerSettings, family: AttackFamily) -> None:
    try:
        bank = load_probe_bank(settings.probes_dir)
    except ProbeBankError as error:
        raise permanent_redteam_error(
            RedTeamErrorType.probes_missing, f"the probe bank is invalid: {str(error)[:300]}"
        ) from None
    known = {probe.id for probe in bank.probes}
    missing = [probe for probe in family.definition.breach_probes if probe not in known]
    if missing:
        raise permanent_redteam_error(
            RedTeamErrorType.probes_missing,
            f"family {family.definition.id} names probes the bank does not hold: "
            f"{', '.join(missing)}",
        )


def role_brief(role: Role) -> str:
    seen = ", ".join(role.can_see[:LIST_ITEM_LIMIT]) or "not stated"
    done = ", ".join(role.can_do[:LIST_ITEM_LIMIT]) or "not stated"
    return clipped(
        f"{role.id} (privilege level {role.level}): {role.description}. "
        f"May see: {seen}. May do: {done}."
    )


def app_brief(manifest: BundleManifest) -> str:
    return clipped(f"{manifest.app.name}: {manifest.app.summary}")


def declared_role(manifest: BundleManifest, role_id: str) -> Role:
    role = next((item for item in manifest.roles if item.id == role_id), None)
    if role is None:
        raise not_ready(f"the bundle declares no role {role_id!r}")
    return role


async def ensure_attack_ready(
    session: AsyncSession,
    settings: WorkerSettings,
    run: RunRow,
    bundle: BundleRow,
    role_id: str,
    interface_id: str,
    family: AttackFamily,
) -> None:
    if run.kind is not RunKind.redteam:
        raise permanent_redteam_error(
            RedTeamErrorType.run_not_found, f"run {run.id} is not a red team run"
        )
    role = declared_role(manifest_of(bundle), role_id)
    ensure_probes_exist(settings, family)
    requirements = (await build_context(session, bundle, False)).requirements(role.id, interface_id)
    if requirements.environment_missing() or requirements.credential_missing():
        raise not_ready(
            f"the environment of {interface_id} or the credential of role {role.id} has no value"
        )
