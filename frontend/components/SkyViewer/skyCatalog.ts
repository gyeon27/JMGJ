import type {
  BrightStar,
  BrightStarCatalog,
  SearchSuggestion,
  StellariumEngine,
  SweObj,
} from "./types";

const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_RENDERED_STAR_MAG = 5.3;
const STAR_RENDER_BATCH_SIZE = 700;
const STAR_RENDER_STEPS = [
  { fovDegrees: 42, magnitude: 5.3 },
  { fovDegrees: 26, magnitude: 6.0 },
  { fovDegrees: 16, magnitude: 6.5 },
  { fovDegrees: 10, magnitude: 7.0 },
  { fovDegrees: 6, magnitude: 7.5 },
];

type RenderableStar = {
  star: BrightStar;
  obj: SweObj;
  vector: number[];
  label: string;
  rendered: boolean;
  clickTargetAdded: boolean;
};

export type BrightStarSupplement = {
  apparentMagnitude?: number;
  absoluteMagnitude?: number;
  distanceParsec?: number;
  objectType: string;
};

let starLayerState: {
  layer: SweObj;
  stars: RenderableStar[];
} | null = null;
const brightStarSupplementIndex = new Map<string, BrightStarSupplement>();

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

function getStarEngineId(star: BrightStar) {
  if (star.hr) return `hr-${star.hr}`;
  if (star.hip) return `hip-${star.hip}`;
  if (star.hd) return `hd-${star.hd}`;
  return `hyg-${star.id ?? normalizeSearchKey(star.name)}`;
}

function addBrightStarSupplementKey(key: string, info: BrightStarSupplement) {
  const normalized = normalizeSearchKey(key);
  if (normalized) brightStarSupplementIndex.set(normalized, info);
}

function indexBrightStarSupplement(star: BrightStar) {
  const info: BrightStarSupplement = {
    apparentMagnitude: star.vmag,
    absoluteMagnitude: star.absoluteMagnitude ?? undefined,
    distanceParsec: star.distanceParsec ?? undefined,
    objectType: "별",
  };

  for (const name of [star.name, ...star.names, ...buildStarDesignations(star)]) {
    addBrightStarSupplementKey(name, info);
    addBrightStarSupplementKey(name.replace(/^NAME\s+/i, ""), info);
  }

  if (star.id) addBrightStarSupplementKey(`HYG ${star.id}`, info);
  if (star.hip) addBrightStarSupplementKey(`HIP ${star.hip}`, info);
  if (star.hr) {
    addBrightStarSupplementKey(String(star.hr), info);
    addBrightStarSupplementKey(`HR ${star.hr}`, info);
  }
  if (star.hd) addBrightStarSupplementKey(`HD ${star.hd}`, info);
}

function indexBrightStarSupplements(stars: BrightStar[]) {
  brightStarSupplementIndex.clear();
  for (const star of stars) {
    indexBrightStarSupplement(star);
  }
}

export function findBrightStarSupplement(
  names: string[]
): BrightStarSupplement | null {
  for (const name of names) {
    const cleaned = name.replace(/^NAME\s+/i, "").replace(/\s+/g, " ").trim();
    const candidates = [name, cleaned];

    const engineIdMatch = cleaned.match(/^(?:bsc|hr|hip|hd|hyg)-(.+)$/i);
    if (engineIdMatch) {
      const [, value] = engineIdMatch;
      candidates.push(value);
      candidates.push(cleaned.replace("-", " "));
    }

    for (const candidate of candidates) {
      const info = brightStarSupplementIndex.get(normalizeSearchKey(candidate));
      if (info) return info;
    }
  }

  return null;
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

  const response = await fetch("/catalogs/hyg-star-catalog.json");
  if (!response.ok) {
    throw new Error(`Cannot load HYG star catalog: ${response.status}`);
  }

  const catalog = (await response.json()) as BrightStarCatalog;
  indexBrightStarSupplements(catalog.stars);

  const layer = engine.createLayer({
    id: "hyg-star-catalog",
    visible: true,
    z: 7,
  });
  if (!layer?.add) return 0;

  let added = 0;
  let processed = 0;
  const renderableStars: RenderableStar[] = [];
  for (const star of catalog.stars) {
    const designations = buildStarDesignations(star);
    const vector = starToIcrfVector(star);
    const displayName = getStarDisplayName(star);

    const obj = engine.createObj("star", {
      id: getStarEngineId(star),
      model: "star",
      model_data: {
        Vmag: star.vmag,
        vmag: star.vmag,
        absmag: star.absoluteMagnitude,
        dist: star.distanceParsec,
        de: star.dec,
        ra: star.ra,
        spect_t: star.spect,
        ci: star.colorIndex,
      },
      names: designations,
      name: displayName,
      label: displayName,
      short_name: displayName,
      types: ["*"],
    });

    if (!obj) continue;

    const renderableStar: RenderableStar = {
      star,
      obj,
      vector,
      label: displayName,
      rendered: false,
      clickTargetAdded: false,
    };
    renderableStars.push(renderableStar);

    if (star.vmag <= DEFAULT_RENDERED_STAR_MAG) {
      layer.add(obj);
      added += 1;
      renderableStar.rendered = true;
      renderableStar.clickTargetAdded = true;
    }

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
    if (star.id) searchIndex.set(normalizeSearchKey(`HYG ${star.id}`), obj);
    if (star.hip) searchIndex.set(normalizeSearchKey(`HIP ${star.hip}`), obj);
    if (star.hr) {
      searchIndex.set(normalizeSearchKey(String(star.hr)), obj);
      searchIndex.set(normalizeSearchKey(`HR ${star.hr}`), obj);
    }
    if (star.hd) searchIndex.set(normalizeSearchKey(`HD ${star.hd}`), obj);

    if (renderableStar.clickTargetAdded) {
      clickTargets.push({
        key: normalizeSearchKey(star.name),
        label: displayName,
        obj,
        vector,
      });
    }

    processed += 1;
    if (processed % 500 === 0) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  starLayerState = {
    layer,
    stars: renderableStars,
  };

  return added;
}

function getStarMagnitudeLimitForFov(fovRadians: number) {
  const fovDegrees = (fovRadians * 180) / Math.PI;
  let limit = DEFAULT_RENDERED_STAR_MAG;

  for (const step of STAR_RENDER_STEPS) {
    if (fovDegrees <= step.fovDegrees) {
      limit = Math.max(limit, step.magnitude);
    }
  }

  return limit;
}

export function updateVisibleStarCatalog(
  engine: StellariumEngine,
  clickTargets: SearchSuggestion[]
) {
  if (!starLayerState) return 0;

  const rawFov =
    typeof engine.getValue?.("fov") === "number"
      ? (engine.getValue("fov") as number)
      : typeof engine.getValue?.("zoom") === "number"
        ? (engine.getValue("zoom") as number)
        : Math.PI / 3;
  const fov = rawFov > Math.PI ? (rawFov * Math.PI) / 180 : rawFov;
  const magnitudeLimit = getStarMagnitudeLimitForFov(fov);

  let added = 0;
  for (const item of starLayerState.stars) {
    if (added >= STAR_RENDER_BATCH_SIZE) break;
    if (item.rendered || item.star.vmag > magnitudeLimit) continue;

    starLayerState.layer.add?.(item.obj);
    item.rendered = true;
    added += 1;

    if (!item.clickTargetAdded) {
      clickTargets.push({
        key: normalizeSearchKey(item.star.name),
        label: item.label,
        obj: item.obj,
        vector: item.vector,
      });
      item.clickTargetAdded = true;
    }
  }

  return added;
}
