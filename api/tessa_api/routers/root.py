from fastapi import APIRouter

from tessa_api.schemas.health import RootInfo

router = APIRouter(tags=["root"])


@router.get("/", response_model=RootInfo, summary="Service banner")
async def read_root() -> RootInfo:
    return RootInfo(name="Tessa API", status="ready")
