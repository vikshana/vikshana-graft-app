import asyncio
import random

import structlog
from fastapi import APIRouter, HTTPException

from app.chaos import get_state

router = APIRouter(tags=["api"])
log = structlog.get_logger()

DUMMY_ORDERS = [
    {"id": "ord-001", "product": "Widget A", "quantity": 3, "status": "delivered"},
    {"id": "ord-002", "product": "Gadget B", "quantity": 1, "status": "shipped"},
    {"id": "ord-003", "product": "Gizmo C", "quantity": 5, "status": "pending"},
]

DUMMY_PRODUCTS = [
    {"id": "prod-001", "name": "Widget A", "price": 9.99, "stock": 150},
    {"id": "prod-002", "name": "Gadget B", "price": 49.99, "stock": 23},
    {"id": "prod-003", "name": "Gizmo C", "price": 14.99, "stock": 512},
]

DUMMY_USERS = [
    {"id": "user-001", "name": "Alice", "email": "alice@example.com"},
    {"id": "user-002", "name": "Bob", "email": "bob@example.com"},
    {"id": "user-003", "name": "Charlie", "email": "charlie@example.com"},
]


async def _apply_chaos(endpoint: str) -> None:
    """Inject the current chaos mode into a request, if enabled."""
    state = get_state()
    if not state.enabled:
        return
    log.warning("chaos.injected", endpoint=endpoint, mode=state.mode)
    if state.mode == "error":
        if random.random() < 0.6:  # 60% error rate
            raise HTTPException(status_code=500, detail="Chaos: simulated server error")
    elif state.mode == "latency":
        delay = random.uniform(1.0, 5.0)
        log.info("chaos.latency", delay_seconds=round(delay, 2))
        await asyncio.sleep(delay)
    elif state.mode == "exception":
        raise RuntimeError("Chaos: unhandled exception injected")


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/orders")
async def list_orders() -> list:
    await _apply_chaos("orders")
    log.info("orders.listed", count=len(DUMMY_ORDERS))
    return DUMMY_ORDERS


@router.get("/products")
async def list_products() -> list:
    await _apply_chaos("products")
    log.info("products.listed", count=len(DUMMY_PRODUCTS))
    return DUMMY_PRODUCTS


@router.get("/users")
async def list_users() -> list:
    await _apply_chaos("users")
    log.info("users.listed", count=len(DUMMY_USERS))
    return DUMMY_USERS
