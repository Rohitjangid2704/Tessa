from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import SeedHashSource, SeedResetStatus
from tessa_api.schemas.targets import TARGET_NAME_MAX_LENGTH


class Seed(BaseModel):
    id: UUID
    target_id: UUID
    bundle_id: UUID
    version: int = Field(ge=1, description="seed version of the target, from 1")
    declared_hash: str | None = Field(
        description="expected state hash; null while the bundle declares none and nothing was reset"
    )
    hash_source: SeedHashSource = Field(
        description="bundle when the bundle declared the hash, first_reset when it was recorded"
    )
    observed_hash: str | None = Field(description="hash the last verify or reset observed")
    last_reset_at: Timestamp | None = Field(description="when the last verify or reset finished")
    last_reset_status: SeedResetStatus | None = Field(
        description="outcome of the last verify or reset"
    )
    last_reset_run_id: UUID | None = Field(description="seed run that produced the last outcome")
    has_reset_script: bool = Field(description="true when the bundle carries a reset script")
    has_hash_command: bool = Field(description="true when the manifest carries a hash command")
    reset_script_path: str | None = Field(
        description="path of the reset script inside the bundle; read it through the bundle files"
    )
    hash_command: str | None = Field(
        description="hash command from the manifest, placeholders only"
    )
    material_sha256: str = Field(description="sha256 of the reset script plus the hash command")


class SeedPage(BaseModel):
    items: list[Seed]
    next_cursor: str | None
    total: int | None


class SeedVerifyCreate(BaseModel):
    seed_id: UUID | None = Field(
        default=None, description="seed version to verify; the latest of the target when absent"
    )


class SeedResetCreate(BaseModel):
    seed_id: UUID | None = Field(
        default=None, description="seed version to reset to; the latest of the target when absent"
    )
    confirm_target_name: str = Field(
        max_length=TARGET_NAME_MAX_LENGTH,
        description="name of the target typed by the user; a mismatch is 422 confirmation_mismatch",
    )
