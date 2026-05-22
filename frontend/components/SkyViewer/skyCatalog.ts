import type {
  BrightStar,
  BrightStarCatalog,
  SearchSuggestion,
  StellariumEngine,
  SweObj,
} from "./types";

const DEG_TO_RAD = Math.PI / 180;
const MAX_RENDERED_STAR_MAG = 4.85;

export const FEATURED_STAR_NAMES = new Set(
  [
    "sirius",
    "canopus",
    "arcturus",
    "vega",
    "capella",
    "rigil kentaurus",
    "alpha centauri",
    "rigel",
    "procyon",
    "achernar",
    "betelgeuse",
    "hadar",
    "altair",
    "acrux",
    "aldebaran",
    "spica",
    "antares",
    "pollux",
    "fomalhaut",
    "deneb",
    "regulus",
    "adhara",
    "castor",
    "shaula",
    "bellatrix",
    "elnath",
    "miaplacidus",
    "alnilam",
    "polaris",
    "alnair",
    "alioth",
    "mirfak",
    "dubhe",
    "wezen",
    "kaus australis",
    "alnitak",
    "avior",
    "alkaid",
    "menkalinan",
    "atria",
    "alhena",
    "peacock",
    "alshain",
    "sadr",
    "caph",
    "kaff",
    "algol",
    "mizar",
    "kochab",
    "rasalhague",
    "nunki",
    "mirach",
    "hamal",
    "diphda",
    "mira",
  ].map(normalizeSearchKey)
);

const STAR_DISPLAY_NAME_OVERRIDES = new Map([
  ["hr 2061", "Betelgeuse"],
  ["58alp ori", "Betelgeuse"],
  ["dog star", "Sirius"],
  ["canicula", "Sirius"],
  ["aschere", "Sirius"],
]);

type HipStarCache = {
  stars: Array<{
    hip: number;
    ra: number;
    dec: number;
    vmag?: number;
  }>;
};

type SkycultureConstellation = {
  id: string;
  lines?: unknown[][];
  iau?: string;
  common_name?: {
    english?: string;
    native?: string;
  };
};

type SkycultureIndex = {
  constellations?: SkycultureConstellation[];
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      stroke: string;
      "stroke-opacity": number;
      "stroke-width": number;
      "stroke-glow"?: boolean;
      fill: string;
      "fill-opacity": number;
      title?: string;
      "text-anchor"?: string;
      "text-size"?: number;
      "text-offset"?: number[];
      "constellation-id"?: string;
    };
    geometry:
      | {
          type: "LineString";
          coordinates: number[][];
        }
      | {
          type: "Point";
          coordinates: number[];
        };
  }>;
};

const BAYER_CODES = new Map([
  ["Alp", "alf"],
  ["Bet", "bet"],
  ["Gam", "gam"],
  ["Del", "del"],
  ["Eps", "eps"],
  ["Zet", "zet"],
  ["Eta", "eta"],
  ["The", "tet"],
  ["Tet", "tet"],
  ["Iot", "iot"],
  ["Kap", "kap"],
  ["Lam", "lam"],
  ["Mu", "mu"],
  ["Nu", "nu"],
  ["Xi", "xi"],
  ["Omi", "omi"],
  ["Pi", "pi"],
  ["Rho", "rho"],
  ["Sig", "sig"],
  ["Tau", "tau"],
  ["Ups", "ups"],
  ["Phi", "phi"],
  ["Chi", "chi"],
  ["Psi", "psi"],
  ["Ome", "ome"],
]);


export function normalizeSearchKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

export function getDeepSkySearchCandidates(term: string) {
  const normalized = term.trim();
  const match = normalized.match(/^(m|messier|ngc|ic)\s*0*([0-9]+)$/i);
  if (!match) return [];

  const catalog = match[1].toLowerCase() === "messier" ? "M" : match[1].toUpperCase();
  const number = String(Number(match[2]));
  return [
    `${catalog} ${number}`,
    `${catalog}${number}`,
    `NAME ${catalog} ${number}`,
    `NAME ${catalog}${number}`,
  ];
}

export function titleCaseName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bHr\b/g, "HR")
    .replace(/\bHd\b/g, "HD");
}

function parseBayerDesignation(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(?:\d+)?([A-Z][a-z]{1,2})(\d*)\s*([A-Z][a-z]{2})$/);
  if (!match) return null;

  const code = BAYER_CODES.get(match[1]);
  if (!code) return null;

  return `* ${code}${match[2] ?? ""} ${match[3]}`;
}

function getBayerDesignations(star: BrightStar) {
  const designations = new Set<string>();
  const candidates = [star.name, ...star.names];

  for (const candidate of candidates) {
    const bayer = parseBayerDesignation(candidate);
    if (bayer) designations.add(bayer);
  }

  return [...designations];
}

export async function loadWesternSkyculture(): Promise<SkycultureIndex> {
  const skycultureResponse = await fetch("/stellarium/skycultures/western/index.json");
  if (!skycultureResponse.ok) {
    throw new Error("Cannot load western skyculture");
  }
  return (await skycultureResponse.json()) as SkycultureIndex;
}

async function loadConstellationHipStarCache(): Promise<HipStarCache> {
  const hipResponse = await fetch("/stellarium/skycultures/western/hip-stars.json");
  if (!hipResponse.ok) {
    throw new Error("Cannot load constellation HIP stars");
  }
  return (await hipResponse.json()) as HipStarCache;
}

export function sphericalToVector(coordinate: number[]) {
  const ra = coordinate[0] * DEG_TO_RAD;
  const dec = coordinate[1] * DEG_TO_RAD;
  const cosDec = Math.cos(dec);

  return [Math.cos(ra) * cosDec, Math.sin(ra) * cosDec, Math.sin(dec)];
}

function getAverageSkyCoordinate(coordinates: number[][]) {
  if (!coordinates.length) return null;

  const sum = coordinates.reduce(
    (acc, coordinate) => {
      const vector = sphericalToVector(coordinate);
      acc[0] += vector[0];
      acc[1] += vector[1];
      acc[2] += vector[2];
      return acc;
    },
    [0, 0, 0]
  );
  const length = Math.hypot(sum[0], sum[1], sum[2]);
  if (!length) return null;

  const x = sum[0] / length;
  const y = sum[1] / length;
  const z = sum[2] / length;
  const ra = (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
  const dec = Math.asin(z) / DEG_TO_RAD;

  return [ra, dec];
}

function getConstellationLabel(constellation: SkycultureConstellation) {
  return (
    constellation.common_name?.native ??
    constellation.iau ??
    constellation.common_name?.english ??
    constellation.id.replace(/^CON\s+western\s+/, "")
  );
}

export async function loadWesternConstellationGeoJson(): Promise<GeoJsonFeatureCollection> {
  const [skyculture, hipCache] = await Promise.all([
    loadWesternSkyculture(),
    loadConstellationHipStarCache(),
  ]);
  const hipCoordinates = new Map(
    hipCache.stars.map((star) => [star.hip, [star.ra, star.dec]])
  );
  const features: GeoJsonFeatureCollection["features"] = [];

  for (const constellation of skyculture.constellations ?? []) {
    const labelCoordinates: number[][] = [];

    for (const line of constellation.lines ?? []) {
      const coordinates = line
        .filter((value): value is number => typeof value === "number")
        .map((hip) => hipCoordinates.get(hip))
        .filter((coordinate): coordinate is number[] => Boolean(coordinate));

      if (coordinates.length < 2) continue;
      labelCoordinates.push(...coordinates);

      features.push({
        type: "Feature",
        properties: {
          stroke: "#a6ffff",
          "stroke-opacity": 0.55,
          "stroke-width": 1.2,
          "stroke-glow": false,
          fill: "#000000",
          "fill-opacity": 0,
          "constellation-id": constellation.id,
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      });
    }

    const labelCoordinate = getAverageSkyCoordinate(labelCoordinates);
    if (!labelCoordinate) continue;

    features.push({
      type: "Feature",
      properties: {
        stroke: "#69a7ff",
        "stroke-opacity": 0.95,
        "stroke-width": 0,
        fill: "#000000",
        "fill-opacity": 0,
        title: getConstellationLabel(constellation),
        "text-anchor": "center",
        "text-size": 19,
        "text-offset": [0, 0],
        "constellation-id": constellation.id,
      },
      geometry: {
        type: "Point",
        coordinates: labelCoordinate,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

export function getPreferredStarDisplayName(names: string[], fallback: string) {
  for (const name of names) {
    const override = STAR_DISPLAY_NAME_OVERRIDES.get(normalizeSearchKey(name));
    if (override) return override;
  }

  const properName =
    names.find(
      (name) => !/^HR\s/i.test(name) && !/^HD\s/i.test(name) && name !== fallback
    ) ?? fallback;

  return titleCaseName(properName.replace(/^NAME\s+/i, ""));
}

function getStarDisplayName(star: BrightStar) {
  return getPreferredStarDisplayName(star.names, star.name);
}

function buildStarDesignations(star: BrightStar) {
  const names = new Set<string>();
  const displayName = getStarDisplayName(star);
  const bayerDesignations = getBayerDesignations(star);
  const isFeatured =
    FEATURED_STAR_NAMES.has(normalizeSearchKey(displayName)) ||
    star.names.some((name) => FEATURED_STAR_NAMES.has(normalizeSearchKey(name)));

  if (isFeatured) {
    names.add(`NAME ${displayName}`);
    names.add(displayName);
  }

  for (const bayerDesignation of bayerDesignations) {
    names.add(bayerDesignation);
  }

  if (isFeatured) {
    for (const name of star.names) {
      const normalized = name.trim();
      if (!normalized) continue;
      names.add(normalized);
      if (!/^HR\s/i.test(normalized) && !/^HD\s/i.test(normalized)) {
        names.add(`NAME ${titleCaseName(normalized)}`);
      }
    }
  }

  return [...names];
}

function starToIcrfVector(star: BrightStar) {
  const ra = (star.ra * Math.PI) / 180;
  const dec = (star.dec * Math.PI) / 180;
  const cosDec = Math.cos(dec);

  return [Math.cos(ra) * cosDec, Math.sin(ra) * cosDec, Math.sin(dec)];
}

export async function loadBrightStarCatalog(
  engine: StellariumEngine,
  searchIndex: Map<string, SweObj>,
  suggestions: SearchSuggestion[],
  clickTargets: SearchSuggestion[]
) {
  if (!engine.createLayer || !engine.createObj) return 0;

  const response = await fetch("/catalogs/bright-star-catalog.json");
  if (!response.ok) {
    throw new Error(`Cannot load bright star catalog: ${response.status}`);
  }

  const catalog = (await response.json()) as BrightStarCatalog;
  const layer = engine.createLayer({
    id: "bright-star-catalog",
    visible: true,
    z: 7,
  });
  if (!layer?.add) return 0;

  let added = 0;
  for (const star of catalog.stars) {
    if (star.vmag > MAX_RENDERED_STAR_MAG) continue;

    const designations = buildStarDesignations(star);
    const vector = starToIcrfVector(star);
    const displayName = getStarDisplayName(star);

    const obj = engine.createObj("star", {
      id: `bsc-${star.hr}`,
      model: "star",
      model_data: {
        Vmag: star.vmag,
        vmag: star.vmag,
        de: star.dec,
        ra: star.ra,
        spect_t: star.spect,
      },
      names: designations,
      name: displayName,
      label: displayName,
      short_name: displayName,
      types: ["*"],
    });

    if (!obj) continue;
    layer.add(obj);
    added += 1;

    for (const name of star.names) {
      const key = normalizeSearchKey(name);
      if (key) searchIndex.set(key, obj);
      if (key && !/^hd\s/i.test(name) && !/^hr\s/i.test(name)) {
        suggestions.push({
          key,
          label: displayName,
          obj,
          vector,
          priority: normalizeSearchKey(displayName) === key ? 12 : 10,
        });
      }
    }
    searchIndex.set(normalizeSearchKey(String(star.hr)), obj);
    searchIndex.set(normalizeSearchKey(`HR ${star.hr}`), obj);
    if (star.hd) searchIndex.set(normalizeSearchKey(`HD ${star.hd}`), obj);

    clickTargets.push({
      key: normalizeSearchKey(star.name),
      label: displayName,
      obj,
      vector,
    });

    if (added % 500 === 0) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  return added;
}
