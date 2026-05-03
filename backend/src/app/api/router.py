from fastapi import APIRouter
from app.api.endpoints import geocode

api_router = APIRouter()

api_router.include_router(geocode.router, prefix="/geocode", tags=["geocode"])