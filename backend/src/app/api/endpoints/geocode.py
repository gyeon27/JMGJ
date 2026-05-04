from fastapi import APIRouter, Query
import httpx

router = APIRouter()

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
    response = await client.get(
        "https://photon.komoot.io/api/",
        params={"q": query, "limit": 10},
        headers=headers,
    )
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


@router.get("/")
async def geocode(query: str = Query(..., min_length=2)):
    headers = {
        "Accept-Language": "ko,en",
        "User-Agent": "JMGJ-school-project/0.1",
    }

    collected: dict[str, tuple[dict, int]] = {}
    variants = build_query_variants(query)

    async with httpx.AsyncClient(timeout=5.0) as client:
        for index, variant in enumerate(variants):
            if is_broad_admin_query(query) and index == 0:
                photon_results = await fetch_photon_results(client, headers, variant)
                results = photon_results
                if not any(is_admin_office_result(result) for result in photon_results):
                    results = [
                        *photon_results,
                        *await fetch_nominatim_results(client, headers, variant),
                    ]
            else:
                results = [
                    *await fetch_photon_results(client, headers, variant),
                    *await fetch_nominatim_results(client, headers, variant),
                ]
            for result in results:
                key = result_key(result)
                if key not in collected:
                    collected[key] = (result, index)

            if is_broad_admin_query(query) and collected:
                break

    ranked = sorted(
        collected.values(),
        key=lambda item: rank_result(item[0], query, item[1]),
        reverse=True,
    )
    return [result for result, _ in ranked if is_acceptable_result(result, query)]


@router.get("/reverse")
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
):
    headers = {
        "Accept-Language": "ko,en",
        "User-Agent": "JMGJ-school-project/0.1",
    }

    async with httpx.AsyncClient(timeout=5.0) as client:
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

    if response.status_code != 200:
        return {}

    result = response.json()
    if not isinstance(result, dict):
        return {}

    return result
