import httpx
import asyncio
import os
import time
from fastapi import APIRouter, Query

router = APIRouter()

GEOCODE_TIMEOUT = httpx.Timeout(2.2, connect=0.8)
REVERSE_GEOCODE_TIMEOUT = httpx.Timeout(1.8, connect=0.8)
VWORLD_TIMEOUT = httpx.Timeout(2.0, connect=0.8)
GEOCODE_CACHE_SECONDS = 600
GEOCODE_MAX_VARIANTS = 4
GEOCODE_CACHE: dict[str, tuple[float, list[dict]]] = {}
REVERSE_GEOCODE_CACHE: dict[str, tuple[float, dict]] = {}

DETAILED_ADDRESS_TYPES = {
    "house_number",
    "house",
    "building",
    "entrance",
    "amenity",
    "school",
    "university",
    "office",
    "shop",
    "tourism",
}

BROAD_ADDRESS_TYPES = {
    "road",
    "street",
    "suburb",
    "quarter",
    "neighbourhood",
    "city",
    "town",
    "village",
    "municipality",
    "county",
    "state",
    "province",
    "region",
    "country",
}

ADMIN_OFFICE_TYPES = {"townhall", "city_hall", "public_building"}
PLACE_HINTS = {
    "학교",
    "초등학교",
    "중학교",
    "고등학교",
    "과학고",
    "대학교",
    "병원",
    "공원",
    "역",
    "터미널",
    "공항",
    "도서관",
    "박물관",
}

SCHOOL_SUFFIX_EXPANSIONS = {
    "초": "초등학교",
    "중": "중학교",
    "고": "고등학교",
}


def normalize_place_key(value: str) -> str:
    return "".join(char.lower() for char in value if char.isalnum())


def is_korean_query(query: str) -> bool:
    return any("가" <= char <= "힣" for char in query)


def is_likely_street_address(query: str) -> bool:
    key = query.strip().lower()
    return any(char.isdigit() for char in key) and any(
        token in key
        for token in ["로", "길", "번길", "대로", "street", "road", "ro", "gil"]
    )


def is_school_abbreviation(query: str) -> bool:
    normalized = query.strip()
    if not is_korean_query(normalized) or " " in normalized:
        return False
    return any(
        normalized.endswith(short_suffix) and len(normalized) > len(short_suffix)
        for short_suffix in SCHOOL_SUFFIX_EXPANSIONS
    )


def is_likely_specific_place(query: str) -> bool:
    normalized = query.strip()
    if is_likely_street_address(normalized):
        return True
    if is_school_abbreviation(normalized):
        return True
    return any(hint in normalized for hint in PLACE_HINTS)


def is_broad_admin_query(query: str) -> bool:
    normalized = query.strip()
    key = normalize_place_key(normalized)
    if not is_korean_query(normalized):
        return False
    if is_likely_specific_place(normalized):
        return False
    if " " in normalized:
        return False
    if len(key) > 5:
        return False
    return True


def build_school_query_variants(query: str) -> list[str]:
    normalized = query.strip()
    variants: list[str] = []
    if not is_korean_query(normalized) or " " in normalized:
        return variants

    for short_suffix, full_suffix in SCHOOL_SUFFIX_EXPANSIONS.items():
        if normalized.endswith(full_suffix):
            return variants
        if normalized.endswith(short_suffix) and len(normalized) > len(short_suffix):
            variants.append(f"{normalized[:-len(short_suffix)]}{full_suffix}")
            break

    return variants


def build_admin_query_variants(query: str) -> list[str]:
    normalized = query.strip()
    if not is_broad_admin_query(normalized):
        return []

    if normalized.endswith("도"):
        stem = normalized[:-1]
        return [f"{normalized}청", f"{stem}도청", normalized]
    elif normalized.endswith("시"):
        stem = normalized[:-1]
        return [f"{normalized}청", f"{stem}시청", normalized]
    elif normalized.endswith("군"):
        return [f"{normalized}청", normalized]
    elif normalized.endswith("구"):
        return [f"{normalized}청", normalized]

    return [f"{normalized}도청", f"{normalized}시청", normalized]


def build_query_variants(query: str) -> list[str]:
    normalized = " ".join(query.split())
    variants: list[str] = []

    variants.extend(build_school_query_variants(normalized))
    variants.extend(build_admin_query_variants(normalized))
    variants.append(normalized)

    if (
        not is_broad_admin_query(normalized)
        and "대한민국" not in normalized
        and "한국" not in normalized
    ):
        variants.extend([f"{variant} 대한민국" for variant in list(variants)])

    return list(dict.fromkeys(variants))


def result_key(result: dict) -> str:
    return str(
        result.get("osm_id")
        or result.get("place_id")
        or result.get("display_name")
        or f"{result.get('lat')},{result.get('lon')}"
    )


def get_cached(cache: dict, key: str):
    cached = cache.get(key)
    if not cached:
        return None

    expires_at, value = cached
    if expires_at < time.monotonic():
        cache.pop(key, None)
        return None

    return value


def set_cached(cache: dict, key: str, value):
    cache[key] = (time.monotonic() + GEOCODE_CACHE_SECONDS, value)


def get_vworld_api_key() -> str | None:
    value = os.getenv("VWORLD_API_KEY", "").strip()
    if not value or value == "your-vworld-api-key":
        return None
    return value


def get_vworld_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "JMGJ-school-project/0.1",
    }
    referer = os.getenv("VWORLD_API_REFERER", "").strip()
    if referer:
        headers["Referer"] = referer
    return headers


def parse_json_response(response: httpx.Response) -> dict | None:
    try:
        data = response.json()
    except ValueError:
        return None

    return data if isinstance(data, dict) else None


def text_snippet(response: httpx.Response, limit: int = 300) -> str:
    text = response.text.strip().replace("\r", " ").replace("\n", " ")
    return text[:limit]


def result_type(result: dict) -> str:
    return str(result.get("addresstype") or result.get("type") or "")


def rank_result(result: dict, query: str, variant_index: int) -> tuple[int, float]:
    address_type = result_type(result)
    result_class = str(result.get("class") or "")
    importance = float(result.get("importance") or 0)
    display_name = normalize_place_key(str(result.get("display_name") or ""))
    name = normalize_place_key(str(result.get("name") or ""))
    query_key = normalize_place_key(query)

    score = 100 - variant_index * 6
    if address_type in DETAILED_ADDRESS_TYPES:
        score += 80
    if address_type in BROAD_ADDRESS_TYPES:
        score -= 70
    if result_class == "boundary":
        score -= 70
    if display_name and query_key and query_key in display_name:
        score += 30
    if name and query_key and (name == query_key or name in query_key or query_key in name):
        score += 35
    if result.get("lat") and result.get("lon"):
        score += 10

    if is_broad_admin_query(query):
        if address_type in ADMIN_OFFICE_TYPES or "청" in str(result.get("display_name") or ""):
            score += 90
        if result_class in {"highway"} or address_type in {"bus_stop", "toilets"}:
            score -= 160
        if result_class == "boundary":
            score -= 100

    if is_likely_street_address(query):
        if address_type in {"road", "street"}:
            score -= 140
        if address_type in {"house_number", "house", "building", "entrance"}:
            score += 110

    return (score, importance)


def is_acceptable_result(result: dict, query: str) -> bool:
    if is_broad_admin_query(query):
        return is_admin_office_result(result)

    if not is_likely_street_address(query):
        return True

    address_type = result_type(result)
    if address_type in DETAILED_ADDRESS_TYPES:
        return True

    display_name = normalize_place_key(str(result.get("display_name") or ""))
    query_key = normalize_place_key(query)
    return bool(query_key and query_key in display_name)


def is_admin_office_result(result: dict) -> bool:
    address_type = result_type(result)
    result_class = str(result.get("class") or "")
    display_name = str(result.get("display_name") or "")
    display_name_lower = display_name.lower()
    return (
        address_type in ADMIN_OFFICE_TYPES
        or "청" in display_name
        or "city hall" in display_name_lower
        or "town hall" in display_name_lower
        or result_class in {"office", "amenity"}
        and "청" in display_name
        and address_type not in {"bus_stop", "toilets", "cafe"}
    )


async def fetch_nominatim_results(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    query: str,
) -> list[dict]:
    try:
        response = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "format": "json",
                "addressdetails": 1,
                "countrycodes": "kr",
                "dedupe": 0,
                "limit": 10,
                "q": query,
            },
            headers=headers,
        )
    except httpx.HTTPError:
        return []

    if response.status_code != 200:
        return []

    results = response.json()
    if not isinstance(results, list):
        return []

    return [result for result in results if isinstance(result, dict)]


async def fetch_photon_results(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    query: str,
) -> list[dict]:
    try:
        response = await client.get(
            "https://photon.komoot.io/api/",
            params={"q": query, "limit": 10},
            headers=headers,
        )
    except httpx.HTTPError:
        return []

    if response.status_code != 200:
        return []

    data = response.json()
    features = data.get("features") if isinstance(data, dict) else None
    if not isinstance(features, list):
        return []

    results: list[dict] = []
    for feature in features:
        if not isinstance(feature, dict):
            continue

        geometry = feature.get("geometry")
        properties = feature.get("properties")
        if not isinstance(geometry, dict) or not isinstance(properties, dict):
            continue

        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            continue

        country = str(properties.get("country") or "")
        if country and country not in {"대한민국", "South Korea", "Republic of Korea"}:
            continue

        name = str(properties.get("name") or query)
        region = str(
            properties.get("city")
            or properties.get("county")
            or properties.get("state")
            or ""
        )
        osm_key = str(properties.get("osm_key") or "")
        osm_value = str(properties.get("osm_value") or "")
        display_parts = [part for part in [name, region, country] if part]

        results.append(
            {
                "display_name": ", ".join(display_parts),
                "name": name,
                "lat": str(coordinates[1]),
                "lon": str(coordinates[0]),
                "class": osm_key,
                "type": osm_value,
                "addresstype": osm_value,
                "importance": 0.7,
            }
        )

    return results


def vworld_point_result(
    point: dict,
    display_name: str,
    query: str,
    address_type: str = "house_number",
) -> dict | None:
    longitude = point.get("x")
    latitude = point.get("y")
    if longitude is None or latitude is None:
        return None

    return {
        "display_name": display_name or query,
        "name": display_name or query,
        "lat": str(latitude),
        "lon": str(longitude),
        "class": "vworld",
        "type": address_type,
        "addresstype": address_type,
        "importance": 1,
        "source": "vworld",
    }


async def fetch_vworld_coord_result(
    client: httpx.AsyncClient,
    query: str,
    address_type: str,
    api_key: str,
) -> list[dict]:
    try:
        response = await client.get(
            "https://api.vworld.kr/req/address",
            params={
                "service": "address",
                "request": "getcoord",
                "version": "2.0",
                "crs": "EPSG:4326",
                "refine": "true",
                "simple": "false",
                "format": "json",
                "errorformat": "json",
                "type": address_type,
                "address": query,
                "key": api_key,
            },
            headers=get_vworld_headers(),
        )
    except httpx.HTTPError:
        return []

    if response.status_code != 200:
        return []

    data = parse_json_response(response)
    if not data:
        return []

    envelope = data.get("response") if isinstance(data, dict) else None
    if not isinstance(envelope, dict) or envelope.get("status") != "OK":
        return []

    result = envelope.get("result")
    if not isinstance(result, dict):
        return []

    point = result.get("point")
    if not isinstance(point, dict):
        return []

    refined = envelope.get("refined")
    display_name = query
    if isinstance(refined, dict):
        display_name = str(refined.get("text") or query)

    mapped = vworld_point_result(point, display_name, query)
    return [mapped] if mapped else []


async def fetch_vworld_search_results(
    client: httpx.AsyncClient,
    query: str,
    category: str,
    api_key: str,
) -> list[dict]:
    try:
        response = await client.get(
            "https://api.vworld.kr/req/search",
            params={
                "service": "search",
                "request": "search",
                "version": "2.0",
                "format": "json",
                "errorformat": "json",
                "type": "address",
                "category": category,
                "crs": "EPSG:4326",
                "size": 10,
                "page": 1,
                "query": query,
                "key": api_key,
            },
            headers=get_vworld_headers(),
        )
    except httpx.HTTPError:
        return []

    if response.status_code != 200:
        return []

    data = parse_json_response(response)
    if not data:
        return []

    envelope = data.get("response") if isinstance(data, dict) else None
    result = envelope.get("result") if isinstance(envelope, dict) else None
    items = result.get("items") if isinstance(result, dict) else None
    if not isinstance(items, list):
        return []

    mapped_results: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        point = item.get("point")
        if not isinstance(point, dict):
            continue

        address = item.get("address")
        display_name = str(item.get("title") or query)
        if isinstance(address, dict):
            display_name = str(
                address.get("road")
                or address.get("parcel")
                or item.get("title")
                or query
            )

        mapped = vworld_point_result(point, display_name, query)
        if mapped:
            mapped_results.append(mapped)

    return mapped_results


async def fetch_vworld_results(
    client: httpx.AsyncClient,
    query: str,
    api_key: str,
) -> list[dict]:
    road_coord, parcel_coord, road_search, parcel_search = await asyncio.gather(
        fetch_vworld_coord_result(client, query, "road", api_key),
        fetch_vworld_coord_result(client, query, "parcel", api_key),
        fetch_vworld_search_results(client, query, "road", api_key),
        fetch_vworld_search_results(client, query, "parcel", api_key),
    )
    return [*road_coord, *parcel_coord, *road_search, *parcel_search]


async def fetch_vworld_debug(
    client: httpx.AsyncClient,
    query: str,
    api_key: str,
) -> list[dict]:
    checks = [
        (
            "address_getcoord_road",
            "https://api.vworld.kr/req/address",
            {
                "service": "address",
                "request": "getcoord",
                "version": "2.0",
                "crs": "EPSG:4326",
                "refine": "true",
                "simple": "false",
                "format": "json",
                "errorformat": "json",
                "type": "road",
                "address": query,
                "key": api_key,
            },
        ),
        (
            "address_getcoord_parcel",
            "https://api.vworld.kr/req/address",
            {
                "service": "address",
                "request": "getcoord",
                "version": "2.0",
                "crs": "EPSG:4326",
                "refine": "true",
                "simple": "false",
                "format": "json",
                "errorformat": "json",
                "type": "parcel",
                "address": query,
                "key": api_key,
            },
        ),
        (
            "search_address_road",
            "https://api.vworld.kr/req/search",
            {
                "service": "search",
                "request": "search",
                "version": "2.0",
                "format": "json",
                "errorformat": "json",
                "type": "address",
                "category": "road",
                "crs": "EPSG:4326",
                "size": 3,
                "page": 1,
                "query": query,
                "key": api_key,
            },
        ),
    ]
    diagnostics: list[dict] = []

    for name, url, params in checks:
        safe_params = {key: value for key, value in params.items() if key != "key"}
        try:
            response = await client.get(
                url,
                params=params,
                headers=get_vworld_headers(),
            )
            data = parse_json_response(response)
            if not data:
                diagnostics.append(
                    {
                        "name": name,
                        "http_status": response.status_code,
                        "content_type": response.headers.get("content-type"),
                        "body": text_snippet(response),
                        "params": safe_params,
                    }
                )
                continue

            envelope = data.get("response") if isinstance(data, dict) else None
            result = envelope.get("result") if isinstance(envelope, dict) else None
            items = result.get("items") if isinstance(result, dict) else None
            diagnostics.append(
                {
                    "name": name,
                    "http_status": response.status_code,
                    "vworld_status": envelope.get("status") if isinstance(envelope, dict) else None,
                    "error": envelope.get("error") if isinstance(envelope, dict) else None,
                    "has_result": bool(result),
                    "item_count": len(items) if isinstance(items, list) else None,
                    "params": safe_params,
                }
            )
        except Exception as error:
            diagnostics.append(
                {
                    "name": name,
                    "error": type(error).__name__,
                    "params": safe_params,
                }
            )

    return diagnostics


async def fetch_vworld_reverse_result(
    client: httpx.AsyncClient,
    lat: float,
    lon: float,
    address_type: str,
    api_key: str,
) -> dict:
    try:
        response = await client.get(
            "https://api.vworld.kr/req/address",
            params={
                "service": "address",
                "request": "getaddress",
                "version": "2.0",
                "crs": "EPSG:4326",
                "type": address_type,
                "point": f"{lon},{lat}",
                "format": "json",
                "errorformat": "json",
                "key": api_key,
            },
            headers=get_vworld_headers(),
        )
    except httpx.HTTPError:
        return {}

    if response.status_code != 200:
        return {}

    data = parse_json_response(response)
    if not data:
        return {}

    envelope = data.get("response") if isinstance(data, dict) else None
    result = envelope.get("result") if isinstance(envelope, dict) else None
    if not isinstance(result, list) or not result:
        return {}

    first = result[0]
    if not isinstance(first, dict):
        return {}

    text = first.get("text") or first.get("zipcode") or ""
    return {
        "display_name": str(text),
        "name": str(text),
        "lat": str(lat),
        "lon": str(lon),
        "source": "vworld",
    }


async def fetch_variant_results(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    query: str,
    variant: str,
    index: int,
) -> tuple[int, list[dict]]:
    if is_broad_admin_query(query) and index == 0:
        photon_results = await fetch_photon_results(client, headers, variant)
        if any(is_admin_office_result(result) for result in photon_results):
            return index, photon_results

        nominatim_results = await fetch_nominatim_results(client, headers, variant)
        return index, [*photon_results, *nominatim_results]

    photon_results, nominatim_results = await asyncio.gather(
        fetch_photon_results(client, headers, variant),
        fetch_nominatim_results(client, headers, variant),
    )
    return index, [*photon_results, *nominatim_results]


@router.get("/")
async def geocode(
    query: str = Query(..., min_length=2),
    debug: bool = False,
):
    normalized_query = " ".join(query.split())
    cache_key = normalize_place_key(normalized_query)
    cached = get_cached(GEOCODE_CACHE, cache_key)
    if cached is not None:
        return cached

    headers = {
        "Accept-Language": "ko,en",
        "User-Agent": "JMGJ-school-project/0.1",
    }

    collected: dict[str, tuple[dict, int]] = {}
    variants = build_query_variants(normalized_query)[:GEOCODE_MAX_VARIANTS]
    vworld_api_key = get_vworld_api_key()

    if debug:
        diagnostics = []
        if vworld_api_key:
            async with httpx.AsyncClient(timeout=VWORLD_TIMEOUT) as client:
                diagnostics = await fetch_vworld_debug(
                    client,
                    normalized_query,
                    vworld_api_key,
                )
        return {
            "query": normalized_query,
            "variants": variants,
            "vworld_key_present": bool(vworld_api_key),
            "vworld_referer": os.getenv("VWORLD_API_REFERER", "").strip() or None,
            "vworld": diagnostics,
        }

    if vworld_api_key:
        async with httpx.AsyncClient(timeout=VWORLD_TIMEOUT) as client:
            vworld_variant_results = await asyncio.gather(
                *[
                    fetch_vworld_results(client, variant, vworld_api_key)
                    for variant in variants
                ]
            )

        for index, results in enumerate(vworld_variant_results):
            for result in results:
                key = result_key(result)
                if key not in collected:
                    collected[key] = (result, index)

        vworld_ranked = sorted(
            collected.values(),
            key=lambda item: rank_result(item[0], normalized_query, item[1]),
            reverse=True,
        )
        vworld_results = [
            result
            for result, _ in vworld_ranked
            if is_acceptable_result(result, normalized_query)
        ]
        if vworld_results:
            set_cached(GEOCODE_CACHE, cache_key, vworld_results)
            return vworld_results

    async with httpx.AsyncClient(timeout=GEOCODE_TIMEOUT) as client:
        variant_results = await asyncio.gather(
            *[
                fetch_variant_results(client, headers, normalized_query, variant, index)
                for index, variant in enumerate(variants)
            ]
        )

        for index, results in variant_results:
            for result in results:
                key = result_key(result)
                if key not in collected:
                    collected[key] = (result, index)

    ranked = sorted(
        collected.values(),
        key=lambda item: rank_result(item[0], normalized_query, item[1]),
        reverse=True,
    )
    results = [
        result
        for result, _ in ranked
        if is_acceptable_result(result, normalized_query)
    ]
    set_cached(GEOCODE_CACHE, cache_key, results)
    return results


@router.get("/reverse")
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
):
    cache_key = f"{lat:.5f},{lon:.5f}"
    cached = get_cached(REVERSE_GEOCODE_CACHE, cache_key)
    if cached is not None:
        return cached

    headers = {
        "Accept-Language": "ko,en",
        "User-Agent": "JMGJ-school-project/0.1",
    }
    vworld_api_key = get_vworld_api_key()

    if vworld_api_key:
        async with httpx.AsyncClient(timeout=REVERSE_GEOCODE_TIMEOUT) as client:
            road_result, parcel_result = await asyncio.gather(
                fetch_vworld_reverse_result(client, lat, lon, "road", vworld_api_key),
                fetch_vworld_reverse_result(client, lat, lon, "parcel", vworld_api_key),
            )
        result = road_result or parcel_result
        if result:
            set_cached(REVERSE_GEOCODE_CACHE, cache_key, result)
            return result

    async with httpx.AsyncClient(timeout=REVERSE_GEOCODE_TIMEOUT) as client:
        try:
            response = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "format": "json",
                    "addressdetails": 1,
                    "lat": lat,
                    "lon": lon,
                    "zoom": 18,
                },
                headers=headers,
            )
        except httpx.HTTPError:
            return {}

    if response.status_code != 200:
        return {}

    result = response.json()
    if not isinstance(result, dict):
        return {}

    set_cached(REVERSE_GEOCODE_CACHE, cache_key, result)
    return result
