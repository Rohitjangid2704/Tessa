from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from tessa_api.schemas.common import Timestamp


class StorageSettings(BaseModel):
    model_config = ConfigDict(frozen=True)

    data_dir: Path = Field(description="root of the local backend and of local scratch areas")


class StoredObject(BaseModel):
    key: str = Field(description="storage key, a relative path with forward slashes")
    size_bytes: int = Field(ge=0)
    content_type: str | None = Field(default=None)
    modified_at: Timestamp | None = Field(
        default=None, description="last write time reported by the backend, when it has one"
    )
