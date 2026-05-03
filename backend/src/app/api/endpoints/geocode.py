from fastapi import APIRouter, Query
import httpx

router = APIRouter()

@router.get("/")
async def geocode(query: str = Query(..., min_length=2)):
    url = "https://nominatim.openstreetmap.org/search"

    params = {
        "format": "json",
        "limit": 1,
        "q": query,
    }

    headers = {
        "User-Agent": "JMGJ-school-project/0.1"
    }

    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(url, params=params, headers=headers)

    if response.status_code != 200:
        return []

    return response.json()