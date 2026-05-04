import type { GeocodeResult, ObserverLocation } from "./types";

const GEOCODE_BASE_URL = "https://jmgj-backend.onrender.com/api/geocode";

const KNOWN_LOCATIONS: GeocodeResult[] = [
  {
    name: "제주과학고등학교, 산록북로, 오라동, 제주시, 제주특별자치도",
    latitude: 33.4258,
    longitude: 126.5308,
  },
  {
    name: "제주특별자치도 제주시 오라로 27, 오라삼동",
    latitude: 33.49802912754,
    longitude: 126.50761034467,
  },
];

const ADMINISTRATIVE_LOCATIONS: GeocodeResult[] = [
  {
    name: "서울특별시청, 세종대로, 중구, 서울특별시",
    latitude: 37.5662952,
    longitude: 126.9779451,
  },
  {
    name: "제주특별자치도청, 문연로, 제주시, 제주특별자치도",
    latitude: 33.4890113,
    longitude: 126.4983023,
  },
];

const ADMINISTRATIVE_LOCATION_ALIASES = new Map(
  (
    [
    ["서울", ADMINISTRATIVE_LOCATIONS[0]],
    ["서울시", ADMINISTRATIVE_LOCATIONS[0]],
    ["서울특별시", ADMINISTRATIVE_LOCATIONS[0]],
    ["제주", ADMINISTRATIVE_LOCATIONS[1]],
    ["제주도", ADMINISTRATIVE_LOCATIONS[1]],
    ["제주특별자치도", ADMINISTRATIVE_LOCATIONS[1]],
    ] satisfies Array<[string, GeocodeResult]>
  ).map(([alias, location]) => [normalizePlaceKey(alias), location])
);

const KNOWN_LOCATION_ALIASES = new Map<string, GeocodeResult>(
  [
    ...buildLocationAliasEntries(
      [
        "제주과학고등학교",
        "제주과학고",
        "제주 과학고등학교",
        "제주 과학고",
        "제주도 제주시 산록북로 421-1",
        "제주특별자치도 제주시 산록북로 421-1",
        "제주시 산록북로 421-1",
        "산록북로 421-1",
        "산록북로421-1",
        "jeju science high school",
        "jeju science highschool",
      ],
      KNOWN_LOCATIONS[0]
    ),
    ...buildLocationAliasEntries(
      [
        "제주특별자치도 제주시 오라로 27",
        "제주시 오라로 27",
        "오라로 27",
        "오라로27",
        "제주 오라로 27",
        "27, Ora-ro, Jeju-si, Jeju-do",
      ],
      KNOWN_LOCATIONS[1]
    ),
  ]
);

function normalizePlaceKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
}

function buildLocationAliasEntries(aliases: string[], location: GeocodeResult) {
  return aliases.map(
    (alias) => [normalizePlaceKey(alias), location] satisfies [string, GeocodeResult]
  );
}

function findAdministrativeLocation(query: string) {
  const key = normalizePlaceKey(query);
  return ADMINISTRATIVE_LOCATION_ALIASES.get(key) ?? null;
}

function findKnownLocation(query: string) {
  const key = normalizePlaceKey(query);
  return KNOWN_LOCATION_ALIASES.get(key) ?? null;
}

function isLikelyStreetAddress(query: string) {
  const normalized = query.trim();
  return /\d/.test(normalized) && /(로|길|번길|대로|street|road|ro|gil)/i.test(normalized);
}

function scorePhotonFeature(
  feature: {
    properties?: {
      name?: string;
      country?: string;
      osm_key?: string;
      osm_value?: string;
    };
  },
  query: string
) {
  const properties = feature.properties ?? {};
  const name = normalizePlaceKey(properties.name ?? "");
  const key = normalizePlaceKey(query);
  let score = 0;

  if (name === key) score += 100;
  else if (name.includes(key) || key.includes(name)) score += 50;

  if (properties.country === "대한민국" || properties.country === "South Korea") {
    score += 30;
  }

  if (properties.osm_key === "amenity") score += 10;
  if (properties.osm_value === "school" || properties.osm_value === "university") {
    score += 10;
  }

  return score;
}

async function photonGeocodeLocation(
  query: string
): Promise<GeocodeResult | null> {
  const response = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8`
  );
  if (!response.ok) return null;

  const data = (await response.json()) as {
    features?: Array<{
      geometry?: {
        coordinates?: [number, number];
      };
      properties?: {
        name?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
        osm_key?: string;
        osm_value?: string;
      };
    }>;
  };

  const feature = (data.features ?? [])
    .filter((item) => {
      const coordinates = item.geometry?.coordinates;
      const country = item.properties?.country;
      return (
        Array.isArray(coordinates) &&
        coordinates.length >= 2 &&
        (!country || country === "대한민국" || country === "South Korea")
      );
    })
    .sort((a, b) => scorePhotonFeature(b, query) - scorePhotonFeature(a, query))[0];

  const coordinates = feature?.geometry?.coordinates;
  if (!feature || !coordinates) return null;

  const [longitude, latitude] = coordinates;
  if (![latitude, longitude].every(Number.isFinite)) return null;

  const properties = feature.properties ?? {};
  const name = properties.name ?? query;
  const region = properties.city ?? properties.county ?? properties.state;
  const country = properties.country;

  return {
    latitude,
    longitude,
    name: [name, region, country].filter(Boolean).join(", "),
  };
}

export async function geocodeLocation(
  query: string
): Promise<GeocodeResult | null> {
  const administrativeLocation = findAdministrativeLocation(query);
  if (administrativeLocation) return administrativeLocation;

  const knownLocation = findKnownLocation(query);
  if (knownLocation) return knownLocation;

  if (isLikelyStreetAddress(query)) {
    const backendLocation = await backendGeocodeLocation(query);
    if (backendLocation) return backendLocation;
  }

  const photonLocation = await photonGeocodeLocation(query);
  if (photonLocation) return photonLocation;

  return backendGeocodeLocation(query);
}

async function backendGeocodeLocation(
  query: string
): Promise<GeocodeResult | null> {
  const response = await fetch(
    `${GEOCODE_BASE_URL}?query=${encodeURIComponent(query)}`
  );
  if (!response.ok) {
    return findKnownLocation(query);
  }

  const results = (await response.json()) as Array<{
    lat?: string;
    lon?: string;
    display_name?: string;
    name?: string;
  }>;
  const first = results[0];
  if (!first) {
    return findKnownLocation(query);
  }

  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (![latitude, longitude].every(Number.isFinite)) {
    return findKnownLocation(query);
  }

  return {
    latitude,
    longitude,
    name: first.display_name ?? first.name ?? query,
  };
}

export async function reverseGeocodeLocation(location: ObserverLocation) {
  const params = new URLSearchParams({
    lat: String(location.latitude),
    lon: String(location.longitude),
  });
  const response = await fetch(`${GEOCODE_BASE_URL}/reverse?${params.toString()}`);
  if (!response.ok) return null;

  const result = (await response.json()) as {
    display_name?: string;
    name?: string;
  };

  return result.display_name ?? result.name ?? null;
}
