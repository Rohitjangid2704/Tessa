from uuid import UUID

from pydantic import BaseModel


class BuildStepEvidenceInput(BaseModel):
    step_id: UUID
