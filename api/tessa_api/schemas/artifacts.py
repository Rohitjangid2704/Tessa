from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import ArtifactKind


class StoredArtifact(BaseModel):
    id: UUID = Field(description="artifact id; the store derives the file path from it")
    kind: ArtifactKind
    mime: str = Field(description="media type served for the artifact")
    size_bytes: int = Field(ge=0, description="size of the stored file in bytes")


class ArtifactRef(BaseModel):
    id: UUID = Field(description="artifact id")
    kind: ArtifactKind
    mime: str = Field(description="media type of the file behind url")
    size_bytes: int = Field(ge=0, description="size of the file in bytes")
    url: str = Field(description="signed relative URL, used verbatim by the client")
    expires_at: Timestamp = Field(description="moment the signature stops being accepted")
