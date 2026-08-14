from uuid import UUID

from pydantic import BaseModel, Field

FAIL_ORACLE_RESULT = "fail_oracle_result"


class FailOracleResultInput(BaseModel):
    oracle_result_id: UUID
    message: str = Field(max_length=1000, description="redacted reason the run could not finish")
