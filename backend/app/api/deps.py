"""Shared FastAPI dependencies for API routes."""

from __future__ import annotations

from fastapi import Request

from app.config import Settings


def get_settings(request: Request) -> Settings:
    """Return the settings resolved at application startup."""
    settings: Settings = request.app.state.settings
    return settings
