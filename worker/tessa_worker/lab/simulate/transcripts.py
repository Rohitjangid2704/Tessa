from collections.abc import Sequence
from uuid import UUID

from tessa_api.db.models import SimSessionRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import SimSpeaker
from tessa_api.schemas.sim import TRANSCRIPT_PREVIEW_MAX_CHARS, SimTurn
from tessa_api.schemas.streams import IngestEvent, SimTurnPayload
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.lab.simulate.errors import SimulatorErrorType, permanent_simulator_error

ELLIPSIS = "…"
USER_LABEL = "user"
ASSISTANT_LABEL = "assistant"
OMITTED_NOTICE = "[earlier turns omitted]"
TURN_JUDGE_MAX_CHARS = 1200


def preview(text: str) -> str:
    if len(text) <= TRANSCRIPT_PREVIEW_MAX_CHARS:
        return text
    return text[: TRANSCRIPT_PREVIEW_MAX_CHARS - len(ELLIPSIS)] + ELLIPSIS


def turn_event(run_id: UUID, sim_session_id: UUID, turn: SimTurn) -> IngestEvent:
    return build_event(
        run_id,
        "sim.turn",
        SimTurnPayload(
            sim_session_id=sim_session_id,
            turn=turn.turn,
            speaker=turn.speaker,
            text_preview=preview(turn.text),
        ),
        f"sim.turn:{sim_session_id}:{turn.turn}",
    )


async def append_turn(
    session_factory: SessionFactory,
    events: EventClient,
    sim_session_id: UUID,
    speaker: SimSpeaker,
    text: str,
) -> SimTurn:
    async with session_factory() as session:
        row = await session.get(SimSessionRow, sim_session_id, with_for_update=True)
        if row is None:
            raise permanent_simulator_error(
                SimulatorErrorType.session_not_found,
                f"simulation session {sim_session_id} does not exist",
            )
        turn = SimTurn(turn=len(row.transcript) + 1, speaker=speaker, text=text)
        row.transcript = [*row.transcript, turn.model_dump(mode="json")]
        run_id = row.run_id
        await session.commit()
    await events.deliver([turn_event(run_id, sim_session_id, turn)])
    return turn


def target_turn_count(transcript: Sequence[SimTurn]) -> int:
    return sum(turn.speaker is SimSpeaker.target for turn in transcript)


def judge_label(speaker: SimSpeaker) -> str:
    return USER_LABEL if speaker is SimSpeaker.persona else ASSISTANT_LABEL


def judge_line(turn: SimTurn) -> str:
    text = turn.text
    if len(text) > TURN_JUDGE_MAX_CHARS:
        text = text[: TURN_JUDGE_MAX_CHARS - len(ELLIPSIS)] + ELLIPSIS
    return f"{judge_label(turn.speaker)}: {text}"


def judge_transcript(transcript: Sequence[SimTurn], max_chars: int) -> str:
    lines = [judge_line(turn) for turn in transcript]
    kept: list[str] = []
    used = 0
    for line in reversed(lines):
        if used + len(line) + 1 > max_chars and kept:
            return "\n".join([OMITTED_NOTICE, *reversed(kept)])
        kept.append(line)
        used += len(line) + 1
    return "\n".join(reversed(kept))


def target_replies(transcript: Sequence[SimTurn]) -> list[str]:
    return [turn.text for turn in transcript if turn.speaker is SimSpeaker.target]
