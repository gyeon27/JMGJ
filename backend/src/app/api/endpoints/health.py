import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter


router = APIRouter()


def get_asset_status(path_env: str, url_env: str) -> dict[str, Any]:
    path_value = os.getenv(path_env, "").strip()
    url_configured = bool(os.getenv(url_env, "").strip())

    if not path_value:
        return {
            "configured": False,
            "exists": False,
            "sizeBytes": None,
            "urlConfigured": url_configured,
        }

    path = Path(path_value)
    exists = path.exists() and path.is_file()
    return {
        "configured": True,
        "exists": exists,
        "sizeBytes": path.stat().st_size if exists else None,
        "urlConfigured": url_configured,
    }


@router.get("")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "assets": {
            "blackMarble": get_asset_status(
                "BLACK_MARBLE_H5_PATH",
                "BLACK_MARBLE_H5_URL",
            ),
            "dem": get_asset_status(
                "DEM_RASTER_PATH",
                "DEM_RASTER_URL",
            ),
        },
    }
