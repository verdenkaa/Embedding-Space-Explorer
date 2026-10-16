"""Exporters (TZ §10.1, §13.17): file builders for user-chosen data.

Pure functions over prepared rows — the HTTP layer gathers data, exporters
format it. CSV carries a UTF-8 BOM so Excel on Windows reads Cyrillic
correctly; every export includes the identifiers and parameters needed to
interpret it (TZ §18.15). Scene images (PNG) are captured client-side from
the live canvas — the backend never re-renders a "screenshot".
"""

from app.exporters.builders import fragments_csv, points_csv, relations_csv

__all__ = ["fragments_csv", "points_csv", "relations_csv"]
