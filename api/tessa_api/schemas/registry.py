from pydantic import BaseModel


class SchemaIndexEntry(BaseModel):
    name: str
    version: int
    url: str
    sha256: str
    stage: int


class SchemaIndex(BaseModel):
    schemas: list[SchemaIndexEntry]
