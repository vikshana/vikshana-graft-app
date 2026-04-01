"""Async SQLAlchemy engine, session factory, and base model for Orca."""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# Async engine — connection pool shared across all requests
async_engine = create_async_engine(
    settings.DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=False,
)

# Session factory — use this to create new sessions
AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    """Declarative base for all SQLAlchemy ORM models."""

    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session for use with FastAPI Depends().

    Yields:
        An AsyncSession that is automatically closed after use.
    """
    async with AsyncSessionLocal() as session:
        yield session

