"""Logging setup.

Policy: logs must never contain source-code content of the
researched project unless explicitly required for a diagnostic message. Keep
log records to identifiers, paths, statuses, and parameter values.
"""

from __future__ import annotations

import logging
import sys

LOGGER_NAME = "ese"

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

_configured = False


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    """Configure the application logger and return it.

    Idempotent: repeated calls do not add duplicate handlers.
    """
    global _configured
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False
    if not _configured:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(_FORMAT))
        logger.addHandler(handler)
        _configured = True
    return logger


def get_logger(name: str) -> logging.Logger:
    """Return a child logger of the application logger."""
    return logging.getLogger(f"{LOGGER_NAME}.{name}")
