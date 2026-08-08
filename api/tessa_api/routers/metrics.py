from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse

from tessa_api.deps import SettingsDep, service_key_dependency
from tessa_api.errors import not_found
from tessa_api.metrics import PROMETHEUS_MEDIA_TYPE, ApiMetrics

router = APIRouter(
    tags=["metrics"],
    include_in_schema=False,
    dependencies=[service_key_dependency],
)


def get_api_metrics(request: Request) -> ApiMetrics:
    metrics: ApiMetrics = request.app.state.metrics
    return metrics


ApiMetricsDep = Annotated[ApiMetrics, Depends(get_api_metrics)]


@router.get(
    "/metrics",
    response_class=PlainTextResponse,
    summary="Prometheus text exposition of the api process",
)
async def read_metrics(settings: SettingsDep, metrics: ApiMetricsDep) -> PlainTextResponse:
    if not settings.metrics_enabled:
        raise not_found("Metrics are disabled")
    return PlainTextResponse(metrics.render(), media_type=PROMETHEUS_MEDIA_TYPE)
