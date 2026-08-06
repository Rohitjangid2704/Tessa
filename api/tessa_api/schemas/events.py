from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import FeedName

EVENT_FEEDS: dict[str, tuple[FeedName, ...]] = {
    "run.created": (FeedName.runs, FeedName.home),
    "run.status_changed": (FeedName.runs, FeedName.home),
    "run.progress": (FeedName.runs,),
    "run.finished": (FeedName.runs, FeedName.home),
    "budget.updated": (FeedName.runs,),
    "budget.exhausted": (FeedName.runs, FeedName.home),
    "scenario.queued": (),
    "scenario.started": (),
    "scenario.verdict": (),
    "scenario.finished": (),
    "step.recorded": (),
    "browser_session.started": (),
    "browser_session.ended": (),
    "tile.frame": (),
    "seed.progress": (),
    "step.graded": (),
    "invariant.result": (),
    "finding.created": (FeedName.findings, FeedName.home),
    "finding.updated": (FeedName.findings,),
    "finding.occurrence_added": (FeedName.findings,),
    "scenario.changed": (FeedName.coverage,),
    "coverage.updated": (FeedName.coverage,),
    "explore.action": (),
    "explore.candidate": (),
    "explore.verified": (),
    "sim.turn": (),
    "sim.checked": (),
    "mutation.outcome": (),
    "notification.created": (FeedName.home,),
    "dashboard.invalidate": (FeedName.home,),
    "proposal.updated": (FeedName.coverage,),
    "agent_session.changed": (FeedName.home,),
}


def feeds_for(event_type: str) -> tuple[FeedName, ...]:
    return EVENT_FEEDS.get(event_type, ())


class EventEnvelope(BaseModel):
    type: str = Field(description="dotted lowercase event type from the catalog")
    run_id: UUID | None = Field(description="run the event belongs to; null for feed-only events")
    seq: int | None = Field(description="per-run sequence from 1; null for ephemeral events")
    ts: Timestamp = Field(description="event time reported by the producer")
    payload: dict[str, Any] = Field(description="event payload, typed per type")


class TileFramePayload(BaseModel):
    browser_session_id: UUID = Field(description="browser session the frame belongs to")
    frame_seq: int = Field(ge=0, description="per-session frame counter used by tile.ack")
    mime: Literal["image/jpeg"] = Field(description="media type of the encoded frame")
    width: int = Field(gt=0, description="frame width in pixels")
    height: int = Field(gt=0, description="frame height in pixels")
    data_b64: str = Field(min_length=1, description="base64 encoded JPEG bytes")
    page_url: str | None = Field(default=None, description="URL of the page shown in the frame")
    captured_at: Timestamp = Field(description="capture time reported by the worker")


class FrameIngestMessage(BaseModel):
    type: Literal["frame"]
    payload: TileFramePayload


TILE_FPS_CEILING = 15
TILE_QUALITY_FLOOR = 30
TILE_QUALITY_CEILING = 90
TILE_WIDTH_CEILING = 1920
TILE_MAX_UNACKED_FRAMES = 2


class TileDemandPayload(BaseModel):
    browser_session_id: UUID = Field(description="browser session the demand applies to")
    max_fps: int = Field(
        ge=0, le=TILE_FPS_CEILING, description="frames per second wanted; 0 pauses the screencast"
    )
    quality: int = Field(
        ge=TILE_QUALITY_FLOOR, le=TILE_QUALITY_CEILING, description="JPEG quality wanted"
    )
    max_width: int = Field(gt=0, le=TILE_WIDTH_CEILING, description="frame width ceiling in pixels")


class TileDemandMessage(BaseModel):
    type: Literal["tile.demand"]
    payload: TileDemandPayload
