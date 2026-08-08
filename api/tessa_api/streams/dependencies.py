from typing import Annotated

from fastapi import Depends, Request

from tessa_api.streams.hub import Hub


def get_hub(request: Request) -> Hub:
    hub: Hub = request.app.state.hub
    return hub


HubDep = Annotated[Hub, Depends(get_hub)]
