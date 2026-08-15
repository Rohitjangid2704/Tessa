from tessa_api.services.redteam_corpus import (
    AttackFamily,
    RedTeamCorpus,
    RedTeamCorpusError,
    load_redteam_corpus,
)
from tessa_worker.lab.redteam.errors import RedTeamErrorType, permanent_redteam_error
from tessa_worker.settings import WorkerSettings

ERROR_TEXT_LIMIT = 300


def corpus_of(settings: WorkerSettings) -> RedTeamCorpus:
    try:
        return load_redteam_corpus(settings.probes_dir)
    except RedTeamCorpusError as error:
        raise permanent_redteam_error(
            RedTeamErrorType.corpus_invalid,
            f"the attack families are invalid: {str(error)[:ERROR_TEXT_LIMIT]}",
        ) from None


def family_of(settings: WorkerSettings, family_id: str) -> AttackFamily:
    family = corpus_of(settings).get(family_id)
    if family is None:
        raise permanent_redteam_error(
            RedTeamErrorType.family_unknown, f"{family_id!r} is not an attack family"
        )
    return family
