import re
from typing import Self
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from tessa_api.schemas.bundle import COMMIT_PATTERN
from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import Confidence, ExplanationOpinion, ExplanationSource

ROOT_CAUSE_MAX_LENGTH = 2000
EXPLANATION_MAX_FILES = 30
LINE_RANGE_PATTERN = r"^[0-9]{1,7}(-[0-9]{1,7})?$"
UNSAFE_PATH_PATTERN = re.compile(r"(^|/)\.\.(/|$)|^/|^~|^[A-Za-z]:|\\|[\x00-\x1f]")


class ExplanationFile(BaseModel):
    path: str = Field(
        min_length=1,
        max_length=300,
        description="path from the repository root with forward slashes, never absolute",
    )
    lines: str | None = Field(
        default=None,
        pattern=LINE_RANGE_PATTERN,
        description="line or range of lines, such as 12 or 12-40",
    )

    @field_validator("path")
    @classmethod
    def require_repository_relative_path(cls, value: str) -> str:
        if UNSAFE_PATH_PATTERN.search(value):
            raise ValueError(
                "path must be relative to the repository root, use forward slashes and hold no .."
            )
        return value

    @model_validator(mode="after")
    def require_ordered_range(self) -> Self:
        if self.lines is not None and "-" in self.lines:
            first, _, last = self.lines.partition("-")
            if int(first) > int(last):
                raise ValueError("lines must run from the smaller to the larger number")
        return self


class ExplanationStructured(BaseModel):
    opinion: ExplanationOpinion = Field(
        description="what the evidence says is wrong: the app, the scenario, the harness, or "
        "unknown when the code does not settle it"
    )
    root_cause: str = Field(
        min_length=1,
        max_length=ROOT_CAUSE_MAX_LENGTH,
        description="the cause in a few sentences",
    )
    files: list[ExplanationFile] = Field(
        default_factory=list,
        max_length=EXPLANATION_MAX_FILES,
        description="files and lines the cause lives in",
    )
    commit: str | None = Field(
        default=None,
        pattern=COMMIT_PATTERN,
        description="commit that introduced the defect, when known, as 7 to 40 hex digits",
    )
    fix_branch: str | None = Field(
        default=None,
        max_length=200,
        pattern=r"^\S+$",
        description="branch that holds a fix, when one was made",
    )
    confidence: Confidence = Field(description="how sure the explanation is")

    @field_validator("root_cause")
    @classmethod
    def reject_blank_root_cause(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("root_cause must not be blank")
        return value


class ExplanationCreate(BaseModel):
    text: str = Field(
        min_length=1,
        description="explanation pasted back from Claude Code; the upper bound is "
        "LimitsRead.explanation_max_chars and is enforced as 422 string_too_long",
    )
    structured: ExplanationStructured | None = Field(
        default=None,
        description="the same explanation as fields, so the board can show the opinion, the "
        "files and the commit without reading the text",
    )

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must not be blank")
        return value


class Explanation(BaseModel):
    id: UUID
    finding_id: UUID
    text: str
    source: ExplanationSource
    created_by: UUID
    created_at: Timestamp
    structured: ExplanationStructured | None = None


class ExplanationPage(BaseModel):
    items: list[Explanation]
    next_cursor: str | None
    total: int | None
