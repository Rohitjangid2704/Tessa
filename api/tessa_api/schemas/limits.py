from pydantic import BaseModel, Field


class LimitsRead(BaseModel):
    bundle_max_zip_bytes: int = Field(description="largest accepted bundle zip in bytes")
    bundle_max_manifest_bytes: int = Field(description="largest accepted pasted manifest in bytes")
    explanation_max_chars: int | None = Field(
        description="longest accepted explanation text in characters"
    )
