from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.services.mutant_invariants import (
    ensure_invariants_known,
    load_invariant_vocabulary,
)
from tessa_api.services.prompts.mutants import MutantInvariant, MutantsInputs


async def load_mutants_inputs(
    session: AsyncSession, target: TargetRow, invariant_ids: Sequence[str]
) -> tuple[MutantsInputs, BundleRow | None]:
    vocabulary = await load_invariant_vocabulary(session, target.id)
    ensure_invariants_known(vocabulary, list(invariant_ids), ("body", "invariant_ids"))
    wanted = list(dict.fromkeys(invariant_ids))
    invariants = tuple(
        MutantInvariant(
            invariant_id=info.id,
            pack=info.pack,
            title=info.title,
            description=info.description,
            check=info.check,
        )
        for info in (vocabulary.infos[invariant_id] for invariant_id in wanted)
    )
    bundle = vocabulary.bundle
    return (
        MutantsInputs(
            target_token=target.target_token,
            bundle_version=None if bundle is None else bundle.version,
            invariants=invariants,
        ),
        bundle,
    )
