from fastapi import APIRouter

from app.chaos import ChaosMode, disable, enable, get_state

router = APIRouter(tags=["chaos"])


@router.post("/chaos/enable")
async def enable_chaos(type: ChaosMode) -> dict:
    enable(type)
    return {"active": True, "mode": type}


@router.post("/chaos/disable")
async def disable_chaos() -> dict:
    disable()
    return {"active": False, "mode": None}


@router.get("/chaos/status")
async def chaos_status() -> dict:
    state = get_state()
    return {"active": state.enabled, "mode": state.mode}
