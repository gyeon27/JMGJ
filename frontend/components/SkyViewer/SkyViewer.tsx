import {
  FormEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./SkyViewer.module.css";
import {
  getCoreNumber,
  getObjectInfo,
  getTargetVector,
  projectTargetToScreen,
} from "./coordinates";
import { LocationPicker } from "./LocationPicker";
import { ObjectInfoPanel } from "./ObjectInfoPanel";
import type {
  BrightStar,
  BrightStarCatalog,
  EngineStatus,
  ObjectInfo,
  ObserverLocation,
  SearchSuggestion,
  SelectedTarget,
  StellariumEngine,
  StellariumFactory,
  SweObj,
} from "./types";

declare global {
  interface Window {
    StelWebEngine?: StellariumFactory;
  }
}

const SEOUL = {
  name: "서울",
  latitude: 37.5665,
  longitude: 126.978,
  elevation: 0,
};

const MAX_RENDERED_STAR_MAG = 4.85;
const SKY_TIME_UPDATE_INTERVAL_MS = 100;
const TIME_DISPLAY_UPDATE_INTERVAL_MS = 250;
const DEG_TO_RAD = Math.PI / 180;
const FEATURED_STAR_NAMES = new Set(
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
    "castor",
    "bellatrix",
    "elnath",
    "alnilam",
    "polaris",
    "caph",
    "kaff",
  ].map(normalizeSearchKey)
);

const TOGGLE_PATHS = {
  horizontalCoordinates: ["lines.azimuthal.visible"],
  constellationLines: [
    "constellations.lines_visible",
    "constellations.visible",
    "skycultures.lines_visible",
    "skycultures.constellation_lines_visible",
    "skycultures.constellations_lines_visible",
    "skycultures.constellations_visible",
    "skycultures.visible",
    "skycultures.enabled",
    "lines.constellations.visible",
    "lines.constellation.visible",
  ],
  atmosphere: ["atmosphere.visible"],
  ground: ["landscapes.visible"],
};

const TIME_SPEEDS = [
  { label: "1x", multiplier: 1 },
  { label: "5x", multiplier: 5 },
  { label: "10x", multiplier: 10 },
  { label: "100x", multiplier: 100 },
  { label: "1000x", multiplier: 1000 },
];

const SOLAR_SYSTEM_ALIASES = new Map(
  [
    ["태양", "Sun"],
    ["해", "Sun"],
    ["달", "Moon"],
    ["월", "Moon"],
    ["수성", "Mercury"],
    ["금성", "Venus"],
    ["화성", "Mars"],
    ["목성", "Jupiter"],
    ["토성", "Saturn"],
    ["천왕성", "Uranus"],
    ["해왕성", "Neptune"],
  ].map(([alias, target]) => [normalizeSearchKey(alias), target])
);

const SOLAR_SYSTEM_LABELS = new Map([
  ["Sun", "Sun"],
  ["Moon", "Moon"],
  ["Mercury", "Mercury"],
  ["Venus", "Venus"],
  ["Mars", "Mars"],
  ["Jupiter", "Jupiter"],
  ["Saturn", "Saturn"],
  ["Uranus", "Uranus"],
  ["Neptune", "Neptune"],
]);

const STAR_DISPLAY_NAME_OVERRIDES = new Map([
  ["hr 2061", "Betelgeuse"],
  ["58alp ori", "Betelgeuse"],
  ["dog star", "Sirius"],
  ["canicula", "Sirius"],
  ["aschere", "Sirius"],
]);

type ToolbarIconName =
  | "constellation"
  | "horizontal"
  | "atmosphere"
  | "ground"
  | "deepSky";

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

const BAYER_GREEK_SYMBOLS = new Map([
  ["Alp", "α"],
  ["Bet", "β"],
  ["Gam", "γ"],
  ["Del", "δ"],
  ["Eps", "ε"],
  ["Zet", "ζ"],
  ["Eta", "η"],
  ["The", "θ"],
  ["Iot", "ι"],
  ["Kap", "κ"],
  ["Lam", "λ"],
  ["Mu", "μ"],
  ["Nu", "ν"],
  ["Xi", "ξ"],
  ["Omi", "ο"],
  ["Pi", "π"],
  ["Rho", "ρ"],
  ["Sig", "σ"],
  ["Tau", "τ"],
  ["Ups", "υ"],
  ["Phi", "φ"],
  ["Chi", "χ"],
  ["Psi", "ψ"],
  ["Ome", "ω"],
]);

function parseBayerDesignation(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(?:\d+)?([A-Z][a-z]{1,2})(\d*)\s*([A-Z][a-z]{2})$/);
  if (!match) return null;

  const symbol = BAYER_GREEK_SYMBOLS.get(match[1]);
  if (!symbol) return null;

  return `${symbol}${match[2] ?? ""} ${match[3]}`;
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

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  if (name === "constellation") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M9 36 17 12 32 18 39 35 23 39Z" />
        <circle cx="9" cy="36" r="4" />
        <circle cx="17" cy="12" r="4" />
        <circle cx="32" cy="18" r="4" />
        <circle cx="39" cy="35" r="4" />
        <circle cx="23" cy="39" r="4" />
      </svg>
    );
  }

  if (name === "horizontal") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="18" />
        <path d="M6 24h36M24 6c5 5 7.5 11 7.5 18S29 37 24 42M24 6c-5 5-7.5 11-7.5 18S19 37 24 42M10.5 14.5h27M10.5 33.5h27" />
      </svg>
    );
  }

  if (name === "atmosphere") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 34h23a8 8 0 0 0 0-16 12 12 0 0 0-23-3 9.5 9.5 0 0 0 0 19Z" />
      </svg>
    );
  }

  if (name === "ground") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M5 35c7-10 13-13 19-8 5-8 12-10 19 8" />
        <path d="M7 36h34" />
        <circle cx="34" cy="15" r="5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M39 14c-5-7-17-8-25-1 8-2 13 0 16 4-7-3-17 0-21 9 6-5 13-5 18-2-7 0-14 6-14 15 4-6 10-9 17-8 7 1 12-3 14-9-4 4-8 5-13 4 6-2 9-6 8-12Z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </svg>
  );
}

async function loadWesternSkyculture(): Promise<SkycultureIndex> {
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

function sphericalToVector(coordinate: number[]) {
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
    constellation.common_name?.english ??
    constellation.common_name?.native ??
    constellation.iau ??
    constellation.id.replace(/^CON\s+western\s+/, "")
  );
}

async function loadWesternConstellationGeoJson(): Promise<GeoJsonFeatureCollection> {
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

function toDateTimeLocalValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

const DEFAULT_TIME = toDateTimeLocalValue(new Date());
const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function parseDateTimeLocalValue(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function formatDisplayDateTime(value: string) {
  const date = parseDateTimeLocalValue(value);
  return `${date.getFullYear()}년 ${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}월 ${String(date.getDate()).padStart(2, "0")}일 ${String(
    date.getHours()
  ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds()
  ).padStart(2, "0")}`;
}

function getCalendarDays(monthDate: Date) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const start = new Date(firstDay);
  start.setDate(firstDay.getDate() - firstDay.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function loadStellariumScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.StelWebEngine) {
      resolve();
      return;
    }

    const existing = document.querySelector(
      'script[data-stellarium="1"]'
    ) as HTMLScriptElement | null;

    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.dataset.stellarium = "1";
    script.src = "/stellarium/stellarium-web-engine.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Stellarium engine failed to load"));
    document.body.appendChild(script);
  });
}

function setNestedCoreValue(
  engine: StellariumEngine,
  path: string,
  value: unknown
) {
  const parts = path.split(".");
  const attr = parts.pop();
  let target: unknown = engine.core;

  for (const part of parts) {
    if (!target || typeof target !== "object") return false;
    target = (target as Record<string, unknown>)[part];
  }

  if (!attr || !target || typeof target !== "object") return false;
  (target as Record<string, unknown>)[attr] = value;
  return true;
}

function trySetValue(engine: StellariumEngine, paths: string[], value: unknown) {
  for (const path of paths) {
    try {
      if (setNestedCoreValue(engine, path, value)) {
        return path;
      }
    } catch {
      // Some generated getters throw before all helper functions are attached.
    }

    try {
      engine.setValue?.(path, value);
      return path;
    } catch {
      // Different engine builds expose slightly different module paths.
    }
  }

  return null;
}

function trySetAllValues(
  engine: StellariumEngine,
  paths: string[],
  value: unknown
) {
  return paths
    .map((path) => trySetValue(engine, [path], value))
    .filter((path): path is string => Boolean(path));
}

function patchWasmMemoryHelpers(engine: StellariumEngine) {
  if (!engine._free && engine.asm?.Ga) {
    engine._free = (ptr: number) => {
      engine.asm?.Ga(Number(ptr) || 0);
    };
  }

  if (!engine._malloc && engine.asm?.Wa) {
    engine._malloc = (size: number) => engine.asm?.Wa(size) ?? 0;
  }
}

function getEngineModule(engine: StellariumEngine, name: string) {
  return (
    (engine.core?.[name] as SweObj | undefined) ??
    engine.getModule?.(name) ??
    engine.getModule?.(`core.${name}`) ??
    undefined
  );
}

function addDataSource(module: SweObj | undefined, url: string, key: string) {
  try {
    module?.addDataSource?.({ url, key });
  } catch (error) {
    console.warn(`Could not add Stellarium data source: ${key}`, error);
  }
}

function addOfficialPlanetDataSources(engine: StellariumEngine) {
  const dsos = engine.core?.dsos as SweObj | undefined;
  const planets = engine.core?.planets as SweObj | undefined;
  const stars = getEngineModule(engine, "stars");
  const skycultures = getEngineModule(engine, "skycultures");
  const constellations = getEngineModule(engine, "constellations");

  const baseUrl = "/stellarium/skydata/";
  const skycultureId = "western";
  const skycultureUrl = "/stellarium/skycultures/western";
  addDataSource(dsos, `${baseUrl}dso`, "dso");
  addDataSource(
    stars,
    "http://stelladata.noctua-software.com/surveys/stars",
    "stars"
  );
  addDataSource(planets, `${baseUrl}surveys/sso/moon`, "moon");
  addDataSource(planets, `${baseUrl}surveys/sso/sun`, "sun");
  addDataSource(skycultures, skycultureUrl, skycultureId);
  trySetValue(engine, ["skycultures.current"], skycultureId);
  trySetValue(engine, ["skycultures.current_id"], skycultureId);
  trySetValue(engine, ["skycultures.current_skyculture"], skycultureId);
  trySetValue(engine, ["skycultures.skyculture"], skycultureId);
  trySetValue(engine, ["constellations.current"], skycultureId);
  trySetValue(engine, ["constellations.current_id"], skycultureId);
  skycultures?.update?.();
  constellations?.update?.();

  const planetarySurveys = [
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
  ];

  for (const planet of planetarySurveys) {
    addDataSource(planets, `https://data.stellarium.org/surveys/${planet}`, planet);
  }
}

async function createConstellationLineObjects(engine: StellariumEngine) {
  const data = await loadWesternConstellationGeoJson();
  const objects: SweObj[] = [];
  const groupedFeatures = new Map<string, GeoJsonFeatureCollection["features"]>();

  for (const feature of data.features) {
    const constellationId = feature.properties["constellation-id"] ?? "misc";
    const group = groupedFeatures.get(constellationId) ?? [];
    group.push(feature);
    groupedFeatures.set(constellationId, group);
  }

  // Use the engine object's JSON property setter. The JS helper `setData`
  // only handles polygons, while the native C parser supports LineString.
  for (const features of groupedFeatures.values()) {
    const geoJson = engine.createObj?.("geojson", {});
    if (!geoJson) continue;

    geoJson.data = {
      type: "FeatureCollection",
      features,
    };
    geoJson.z = 16;
    objects.push(geoJson);
  }

  return objects;
}

function setConstellationLineObjectVisible(
  engine: StellariumEngine,
  lineObjects: SweObj[],
  visible: boolean,
  addedRef: { current: boolean }
) {
  const core = engine.core as SweObj | undefined;
  if (!core || lineObjects.length === 0) return;

  if (visible && !addedRef.current) {
    for (const lineObject of lineObjects) {
      core.add?.(lineObject);
    }
    addedRef.current = true;
  } else if (!visible && addedRef.current) {
    for (const lineObject of lineObjects) {
      core.remove?.(lineObject);
    }
    addedRef.current = false;
  }

  core.update?.();
  engine._core_update?.();
}

function updateObserverFrame(engine: StellariumEngine, fast = false) {
  const observer = engine.observer ?? (engine.core?.observer as SweObj | undefined);
  if (!observer) return;

  try {
    engine._observer_update?.(observer.v, fast);
  } catch {
    observer.update?.();
  }
}

function updateDynamicSkyModules(engine: StellariumEngine) {
  const dynamicModules = [
    engine.core?.planets,
    engine.core?.stars,
    getEngineModule(engine, "skycultures"),
    getEngineModule(engine, "constellations"),
    engine.core?.landscapes,
    engine.core?.atmosphere,
  ] as Array<SweObj | undefined>;

  for (const skyModule of dynamicModules) {
    try {
      skyModule?.update?.();
    } catch {
      // Some modules are render-only in this engine build.
    }
  }
}

function setObservationTime(engine: StellariumEngine, value: string | Date) {
  const timestamp =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;

  // 1. Unix time -> Modified Julian Date for Stellarium's astronomical core.
  const modifiedJulianDate = engine.date2MJD?.(timestamp);
  if (typeof modifiedJulianDate === "number") {
    const observer = engine.core?.observer as
      | (SweObj & { utc?: number })
      | undefined;

    if (observer) {
      observer.utc = modifiedJulianDate;
    }
    trySetValue(engine, ["observer.utc"], modifiedJulianDate);
    engine._core_set_time?.(modifiedJulianDate, 0);

    // 2. Recompute sidereal/precession/observer transforms for the new date.
    updateObserverFrame(engine, false);
    updateDynamicSkyModules(engine);
    engine._core_update?.();
    return true;
  }

  return false;
}

function applyNightSkyDefaults(engine: StellariumEngine) {
  trySetValue(engine, ["lock"], null);
  trySetValue(engine, ["stars.visible"], true);
  trySetValue(engine, ["planets.visible"], true);
  trySetAllValues(engine, TOGGLE_PATHS.horizontalCoordinates, false);
  trySetAllValues(engine, TOGGLE_PATHS.constellationLines, false);
  trySetValue(engine, ["constellations.show_only_pointed"], false);
  trySetValue(engine, ["constellations.labels_visible"], false);
  trySetValue(engine, ["constellations.images_visible"], false);
  trySetValue(engine, ["constellations.bounds_visible"], false);
  trySetValue(engine, TOGGLE_PATHS.atmosphere, false);
  trySetValue(engine, TOGGLE_PATHS.ground, true);
  trySetValue(engine, ["planets.scale_moon"], false);
  trySetValue(
    engine,
    [
      "planets.halo_visible",
      "planets.glare_visible",
      "planets.flare_visible",
      "planets.point_halo_visible",
    ],
    true
  );
  trySetValue(engine, ["stars.hints_visible"], true);
  trySetValue(engine, ["stars.hints_mag_offset"], 2.6);
  trySetValue(engine, ["stars.labels_visible"], true);
  trySetValue(engine, ["dsos.visible"], false);
  trySetValue(engine, ["planets.hints_visible"], true);
  trySetValue(engine, ["planets.labels_visible"], true);
  trySetValue(engine, ["planets.hints_mag_offset"], 0);
  trySetValue(engine, ["dsos.hints_visible"], true);
  trySetValue(engine, ["dsos.hints_mag_offset"], -1);
  trySetValue(engine, ["pointer.visible"], true);
  trySetValue(engine, ["display_limit_mag"], 5.5);
  trySetValue(engine, ["star_relative_scale"], 1.62);
  trySetValue(engine, ["star_linear_scale"], 0.11);
  trySetValue(engine, ["bortle_index"], 1);
}

function applyDeepSkyMode(engine: StellariumEngine, enabled: boolean) {
  trySetValue(engine, ["dsos.visible"], enabled);
  trySetValue(engine, ["dsos.hints_visible"], enabled);
  trySetValue(engine, ["dsos.hints_mag_offset"], enabled ? 3 : -1);
  trySetValue(engine, ["display_limit_mag"], enabled ? 8.5 : 5.5);
  trySetValue(engine, ["star_relative_scale"], enabled ? 1.25 : 1.62);
  trySetValue(engine, ["star_linear_scale"], enabled ? 0.08 : 0.11);
}

function normalizeSearchKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function getDeepSkySearchCandidates(term: string) {
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

function titleCaseName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bHr\b/g, "HR")
    .replace(/\bHd\b/g, "HD");
}

function getPreferredStarDisplayName(names: string[], fallback: string) {
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

  for (const bayerDesignation of bayerDesignations) {
    names.add(bayerDesignation);
    names.add(`NAME ${bayerDesignation}`);
  }

  if (isFeatured) {
    names.add(displayName);
    names.add(`NAME ${displayName}`);

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

async function loadBrightStarCatalog(
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

function findEngineObject(engine: StellariumEngine, term: string) {
  const alias = SOLAR_SYSTEM_ALIASES.get(normalizeSearchKey(term));
  const candidates = [
    alias,
    ...getDeepSkySearchCandidates(term),
    term,
    `NAME ${term}`,
    term.toUpperCase(),
    term.toLowerCase(),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const target = engine.getObj?.(candidate);
      if (target) return target;
    } catch {
      // Search is best-effort because engine builds differ in accepted names.
    }
  }

  return null;
}

function addSolarSystemTargets(
  engine: StellariumEngine,
  searchSuggestions: SearchSuggestion[],
  clickTargets: SearchSuggestion[]
) {
  for (const [name, label] of SOLAR_SYSTEM_LABELS) {
    const obj = findEngineObject(engine, name);
    if (!obj) continue;

    const suggestion = {
      key: normalizeSearchKey(name),
      label,
      obj,
      priority: 30,
    };

    searchSuggestions.push(suggestion);
    clickTargets.push(suggestion);
  }
}

function addFeaturedEngineClickTargets(
  engine: StellariumEngine,
  clickTargets: SearchSuggestion[]
) {
  for (const key of FEATURED_STAR_NAMES) {
    const label = titleCaseName(key);
    const obj = findEngineObject(engine, label);
    if (!obj) continue;

    clickTargets.push({
      key,
      label,
      obj,
      priority: 8,
    });
  }
}

function setObserverLocation(
  engine: StellariumEngine,
  latitude: number,
  longitude: number,
  elevation = 0
) {
  const observer = engine.core?.observer as
    | (SweObj & {
        latitude?: number;
        longitude?: number;
        elevation?: number;
      })
    | undefined;

  if (observer) {
    observer.latitude = latitude * DEG_TO_RAD;
    observer.longitude = longitude * DEG_TO_RAD;
    observer.elevation = elevation;
    updateObserverFrame(engine, false);
    return true;
  }

  const values = [
    trySetValue(engine, ["observer.latitude", "observer.lat"], latitude * DEG_TO_RAD),
    trySetValue(engine, ["observer.longitude", "observer.lon"], longitude * DEG_TO_RAD),
    trySetValue(engine, ["observer.elevation", "observer.altitude"], elevation),
  ];

  return values.some(Boolean);
}

function getClickSelectionRadius(engine: StellariumEngine) {
  const rawFov = getCoreNumber(
    engine,
    "fov",
    getCoreNumber(engine, "zoom", Math.PI / 3)
  );
  const fov = rawFov > Math.PI ? (rawFov * Math.PI) / 180 : rawFov;

  return Math.min(46, Math.max(22, 18 + fov * 13));
}

function isSweObj(value: unknown): value is SweObj {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { v?: unknown }).v === "number" &&
    (value as { v: number }).v !== 0
  );
}

function getEngineSelection(engine: StellariumEngine) {
  const direct = engine.core?.selection;
  if (isSweObj(direct)) return direct;

  const value = engine.getValue?.("selection");
  if (isSweObj(value)) return value;

  return null;
}

function labelForObject(
  target: SweObj,
  fallback: string,
  clickTargets: SearchSuggestion[]
) {
  const matched = clickTargets.find((item) => item.obj.v === target.v);
  if (matched?.label) return matched.label;

  try {
    const designations = target.designations?.() ?? [];
    if (designations.length > 0) {
      return getPreferredStarDisplayName(designations, fallback);
    }
  } catch {
    // Some engine-native objects do not expose designations safely.
  }

  if (target.name) {
    return getPreferredStarDisplayName([target.name], target.name);
  }
  if (target.id) {
    return getPreferredStarDisplayName([target.id], target.id);
  }

  return fallback;
}

function getSafeObjectInfo(
  engine: StellariumEngine,
  target: SweObj,
  label: string,
  vector?: number[]
) {
  try {
    return getObjectInfo(engine, target, label, vector);
  } catch (error) {
    console.warn("Could not read object info", error);
    return null;
  }
}

function releaseTracking(engine: StellariumEngine) {
  trySetAllValues(
    engine,
    [
      "tracking",
      "selection_tracking",
      "selection_lock",
      "observer.tracking",
    ],
    false
  );
  trySetValue(engine, ["lock"], null);
}

function centerTarget(
  engine: StellariumEngine,
  target: SweObj,
  vector?: number[],
  duration = 1.2,
  release = true
) {
  try {
    if (release) {
      releaseTracking(engine);
    }

    const observer = engine.observer ?? (engine.core?.observer as SweObj | undefined);
    if (!observer) return;

    const targetVector = getTargetVector(target, observer, vector, {
      preferFallback: Boolean(vector?.length),
    });
    if (!targetVector) return;

    const observedVector = engine.convertFrame?.(
      observer,
      "ICRF",
      "OBSERVED",
      targetVector
    );
    if (!Array.isArray(observedVector) || observedVector.length < 3) return;

    const lookVector = observedVector.slice(0, 3).map(Number);
    if (!lookVector.every(Number.isFinite)) return;

    engine.lookAt?.(lookVector as [number, number, number], duration);
  } catch (error) {
    console.warn("Could not center target", error);
  }
}

function centerTargetOnce(
  engine: StellariumEngine,
  target: SweObj,
  vector?: number[]
) {
  centerTarget(engine, target, vector, 1.2, true);
}

export default function SkyViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<StellariumEngine | null>(null);
  const catalogSearchRef = useRef(new Map<string, SweObj>());
  const searchSuggestionsRef = useRef<SearchSuggestion[]>([]);
  const clickTargetsRef = useRef<SearchSuggestion[]>([]);
  const selectedTargetRef = useRef<SelectedTarget | null>(null);
  const trackingTargetRef = useRef<SelectedTarget | null>(null);
  const trackingActivationTimeoutRef = useRef<number | null>(null);
  const constellationLineObjectsRef = useRef<SweObj[]>([]);
  const isConstellationLineObjectAddedRef = useRef(false);
  const simulatedTimeRef = useRef(new Date());
  const lastTickRef = useRef<number | null>(null);
  const lastSkyUpdateRef = useRef<number | null>(null);
  const lastTimeDisplayUpdateRef = useRef<number | null>(null);
  const dragStateRef = useRef({
    x: 0,
    y: 0,
  });
  const initialTimeRef = useRef(DEFAULT_TIME);
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [query, setQuery] = useState("Saturn");
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [selectedInfo, setSelectedInfo] = useState<ObjectInfo | null>(null);
  const [timeDraft, setTimeDraft] = useState(DEFAULT_TIME);
  const [timePickerDraft, setTimePickerDraft] = useState(DEFAULT_TIME);
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [isTimePickerOpen, setIsTimePickerOpen] = useState(false);
  const [isTimePaused, setIsTimePaused] = useState(false);
  const [timePickerMonth, setTimePickerMonth] = useState(
    () => parseDateTimeLocalValue(DEFAULT_TIME)
  );
  const [timeSpeedIndex, setTimeSpeedIndex] = useState(0);
  const [deepSkyMode, setDeepSkyMode] = useState(false);
  const [locationQuery, setLocationQuery] = useState(SEOUL.name);
  const [observerLocation, setObserverLocationState] =
    useState<ObserverLocation>({
      latitude: SEOUL.latitude,
      longitude: SEOUL.longitude,
    });
  const [toggles, setToggles] = useState({
    horizontalCoordinates: false,
    constellationLines: false,
    atmosphere: false,
    ground: true,
  });

  const statusText = useMemo(() => {
    if (status === "ready") return "엔진 연결됨";
    if (status === "error") return "엔진 오류";
    return "불러오는 중";
  }, [status]);
  const timeDraftDate = useMemo(
    () => parseDateTimeLocalValue(timePickerDraft),
    [timePickerDraft]
  );
  const calendarDays = useMemo(
    () => getCalendarDays(timePickerMonth),
    [timePickerMonth]
  );

  useEffect(() => {
    let disposed = false;

    async function start() {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;

        await loadStellariumScript();

        const createEngine = window.StelWebEngine;
        if (!createEngine) {
          throw new Error("StelWebEngine was not registered on window");
        }

        const engine = await createEngine({
          canvasElement: canvas,
          res: ["http://stelladata.noctua-software.com/surveys/stars/info.json"],
          wasmFile: "/stellarium/stellarium-web-engine.wasm",
        });

        if (disposed) return;

        engineRef.current = engine;
        patchWasmMemoryHelpers(engine);
        addOfficialPlanetDataSources(engine);
        setObserverLocation(
          engine,
          SEOUL.latitude,
          SEOUL.longitude,
          SEOUL.elevation
        );
        setObservationTime(engine, initialTimeRef.current);
        applyNightSkyDefaults(engine);
        applyDeepSkyMode(engine, false);
        addSolarSystemTargets(
          engine,
          searchSuggestionsRef.current,
          clickTargetsRef.current
        );
        setStatus("ready");

        await loadBrightStarCatalog(
          engine,
          catalogSearchRef.current,
          searchSuggestionsRef.current,
          clickTargetsRef.current
        );
        addFeaturedEngineClickTargets(engine, clickTargetsRef.current);
        if (disposed) return;
      } catch (error) {
        console.error(error);
        if (!disposed) {
          setStatus("error");
        }
      }
    }

    void start();

    return () => {
      disposed = true;
      engineRef.current = null;
      constellationLineObjectsRef.current = [];
      isConstellationLineObjectAddedRef.current = false;
      if (trackingActivationTimeoutRef.current !== null) {
        window.clearTimeout(trackingActivationTimeoutRef.current);
        trackingActivationTimeoutRef.current = null;
      }
    };
  }, []);

  function updateQuery(value: string) {
    setQuery(value);

    const key = normalizeSearchKey(value);
    if (!key || key.length < 2) {
      setSuggestions([]);
      return;
    }

    const engine = engineRef.current;
    const deepSkyCandidates = getDeepSkySearchCandidates(value);
    const deepSkySuggestions = [];
    if (engine && deepSkyCandidates.length > 0) {
      const deepSkyTarget = findEngineObject(engine, value);
      if (deepSkyTarget) {
        deepSkySuggestions.push({
          key,
          label: deepSkyCandidates[0],
          obj: deepSkyTarget,
          priority: 80,
        });
      }
    }
    const deepSkyOnly = deepSkyCandidates.length > 0;

    setSuggestions(
      [...deepSkySuggestions, ...searchSuggestionsRef.current]
        .filter((item) =>
          deepSkyOnly
            ? item.key === key || item.key.startsWith(key)
            : item.key.startsWith(key) || item.key.includes(key)
        )
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, 8)
    );
  }

  function focusTarget(target: SweObj, label: string, vector?: number[]) {
    const engine = engineRef.current;
    if (!engine) return;

    const nextTarget = { label, obj: target, vector };
    selectedTargetRef.current = nextTarget;
    trackingTargetRef.current = null;
    if (trackingActivationTimeoutRef.current !== null) {
      window.clearTimeout(trackingActivationTimeoutRef.current);
    }
    setQuery(label);
    setSelectedInfo(getSafeObjectInfo(engine, target, label, vector));
    centerTargetOnce(engine, target, vector);
    trackingActivationTimeoutRef.current = window.setTimeout(() => {
      trackingTargetRef.current = nextTarget;
      trackingActivationTimeoutRef.current = null;
    }, 1250);
    setSuggestions([]);
  }

  function selectTarget(target: SweObj, label: string, vector?: number[]) {
    const engine = engineRef.current;
    if (!engine) return;

    selectedTargetRef.current = { label, obj: target, vector };
    cancelTargetTracking();
    setQuery(label);
    setSelectedInfo(getSafeObjectInfo(engine, target, label, vector));
    setSuggestions([]);
  }

  function cancelTargetTracking() {
    trackingTargetRef.current = null;
    if (trackingActivationTimeoutRef.current !== null) {
      window.clearTimeout(trackingActivationTimeoutRef.current);
      trackingActivationTimeoutRef.current = null;
    }
  }

  function handleCanvasMouseDown(event: MouseEvent<HTMLCanvasElement>) {
    dragStateRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }

  function handleCanvasMouseMove(event: MouseEvent<HTMLCanvasElement>) {
    if (!trackingTargetRef.current && trackingActivationTimeoutRef.current === null) return;
    if ((event.buttons & 1) !== 1) return;

    const dragDistance = Math.hypot(
      event.clientX - dragStateRef.current.x,
      event.clientY - dragStateRef.current.y
    );

    if (dragDistance > 4) {
      cancelTargetTracking();
    }
  }

  function handleCanvasWheel() {
    cancelTargetTracking();
  }

  function handleCanvasClick(event: MouseEvent<HTMLCanvasElement>) {
    const dragDistance = Math.hypot(
      event.clientX - dragStateRef.current.x,
      event.clientY - dragStateRef.current.y
    );

    if (dragDistance > 6) {
      cancelTargetTracking();
      return;
    }

    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas || clickTargetsRef.current.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;

    window.setTimeout(() => {
      const nativeSelection = getEngineSelection(engine);
      if (nativeSelection) {
        const label = labelForObject(
          nativeSelection,
          "Selected object",
          clickTargetsRef.current
        );
        selectTarget(nativeSelection, label);
        return;
      }

      const selectionRadius = getClickSelectionRadius(engine);
      const solarSelectionRadius = Math.max(selectionRadius, 70);
      let closest: SearchSuggestion | null = null;
      let closestScore = Number.POSITIVE_INFINITY;

      for (const suggestion of clickTargetsRef.current) {
        const point = projectTargetToScreen(
          engine,
          canvas,
          suggestion.obj,
          suggestion.vector
        );
        if (!point) continue;
        if (
          point.x < -selectionRadius ||
          point.x > rect.width + selectionRadius ||
          point.y < -selectionRadius ||
          point.y > rect.height + selectionRadius
        ) {
          continue;
        }

        const distance = Math.hypot(point.x - clickX, point.y - clickY);
        const allowedRadius = suggestion.priority ? solarSelectionRadius : selectionRadius;
        if (distance > allowedRadius) continue;

        const score = distance / (suggestion.priority ?? 1);
        if (score < closestScore) {
          closest = suggestion;
          closestScore = score;
        }
      }

      if (closest) {
        selectTarget(closest.obj, closest.label, closest.vector);
      }
    }, 0);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const engine = engineRef.current;
    const term = query.trim();
    if (!engine || !term) return;

    try {
      const normalizedTerm = normalizeSearchKey(term);
      const selectedTarget =
        selectedTargetRef.current &&
        normalizeSearchKey(selectedTargetRef.current.label) === normalizedTerm
          ? selectedTargetRef.current
          : null;
      const exactSuggestion =
        suggestions.find((item) => item.key === normalizedTerm) ??
        searchSuggestionsRef.current.find((item) => item.key === normalizedTerm);
      const engineTarget = findEngineObject(engine, term);
      const target =
        selectedTarget?.obj ??
        exactSuggestion?.obj ??
        engineTarget ??
        catalogSearchRef.current.get(normalizeSearchKey(term)) ??
        suggestions[0]?.obj ??
        null;
      if (!target) {
        return;
      }

      if (getDeepSkySearchCandidates(term).length > 0) {
        setDeepSkyMode(true);
        applyDeepSkyMode(engine, true);
      }

      const matchedClickTarget = clickTargetsRef.current.find(
        (item) => item.obj.v === target.v
      );
      focusTarget(
        target,
        selectedTarget?.label ??
          exactSuggestion?.label ??
          matchedClickTarget?.label ??
          (suggestions[0]?.obj === target ? suggestions[0].label : undefined) ??
          labelForObject(target, term, clickTargetsRef.current),
        selectedTarget?.obj === target
          ? selectedTarget.vector
          : exactSuggestion?.obj === target
          ? exactSuggestion.vector
          : matchedClickTarget?.vector
          ? matchedClickTarget.vector
          : suggestions[0]?.obj === target
            ? suggestions[0].vector
            : undefined
      );
    } catch (error) {
      console.error(error);
    }
  }

  const applyObservationTime = useCallback((value: string | Date) => {
    const engine = engineRef.current;
    if (!engine) return false;

    if (setObservationTime(engine, value)) {
      const selected = selectedTargetRef.current;
      if (selected) {
        setSelectedInfo(
          getSafeObjectInfo(engine, selected.obj, selected.label, selected.vector)
        );
      }
      return true;
    }

    return false;
  }, []);

  useEffect(() => {
    if (status !== "ready") return;

    let frameId = 0;

    const tick = () => {
      const now = performance.now();
      const lastTick = lastTickRef.current ?? now;
      const elapsedSeconds = (now - lastTick) / 1000;
      lastTickRef.current = now;

      if (isTimePaused) {
        frameId = window.requestAnimationFrame(tick);
        return;
      }

      const speed = TIME_SPEEDS[timeSpeedIndex] ?? TIME_SPEEDS[0];
      simulatedTimeRef.current = new Date(
        simulatedTimeRef.current.getTime() +
          elapsedSeconds * speed.multiplier * 1000
      );

      const lastSkyUpdate = lastSkyUpdateRef.current ?? 0;
      if (now - lastSkyUpdate >= SKY_TIME_UPDATE_INTERVAL_MS) {
        lastSkyUpdateRef.current = now;
        applyObservationTime(simulatedTimeRef.current);
        const trackingTarget = trackingTargetRef.current;
        const engine = engineRef.current;
        if (engine && trackingTarget) {
          centerTarget(engine, trackingTarget.obj, trackingTarget.vector, 0, false);
        }
      }

      const lastTimeDisplayUpdate = lastTimeDisplayUpdateRef.current ?? 0;
      if (
        !isEditingTime &&
        now - lastTimeDisplayUpdate >= TIME_DISPLAY_UPDATE_INTERVAL_MS
      ) {
        lastTimeDisplayUpdateRef.current = now;
        const nextTime = toDateTimeLocalValue(simulatedTimeRef.current);
        setTimeDraft(nextTime);
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      lastTickRef.current = null;
      lastSkyUpdateRef.current = null;
      lastTimeDisplayUpdateRef.current = null;
      window.cancelAnimationFrame(frameId);
    };
  }, [
    applyObservationTime,
    isEditingTime,
    isTimePaused,
    observerLocation,
    status,
    timeSpeedIndex,
  ]);

  function handleTimeChange(value: string) {
    setTimePickerDraft(value);
    setIsEditingTime(true);
  }

  function openTimePicker() {
    const draft = parseDateTimeLocalValue(timeDraft);
    setTimePickerDraft(timeDraft);
    setTimePickerMonth(new Date(draft.getFullYear(), draft.getMonth(), 1));
    setIsEditingTime(true);
    setIsTimePickerOpen(true);
  }

  function updateDraftDate(nextDate: Date) {
    const current = parseDateTimeLocalValue(timePickerDraft);
    const updated = new Date(nextDate);
    updated.setHours(current.getHours(), current.getMinutes(), 0, 0);
    handleTimeChange(toDateTimeLocalValue(updated));
  }

  function updateDraftTime(part: "hour" | "minute", value: string) {
    const current = parseDateTimeLocalValue(timePickerDraft);
    const nextValue = Number(value);
    if (!Number.isFinite(nextValue)) return;

    if (part === "hour") {
      current.setHours(nextValue);
    } else {
      current.setMinutes(nextValue);
    }
    current.setSeconds(0, 0);
    handleTimeChange(toDateTimeLocalValue(current));
  }

  function handleApplyTime() {
    const selectedTime = new Date(timePickerDraft);
    if (!Number.isFinite(selectedTime.getTime())) return;

    const appliedTime = toDateTimeLocalValue(selectedTime);
    simulatedTimeRef.current = selectedTime;
    lastTickRef.current = performance.now();
    setIsEditingTime(false);
    setIsTimePickerOpen(false);
    setTimeDraft(appliedTime);
    applyObservationTime(selectedTime);
  }

  function handleUseCurrentTime() {
    const now = new Date();
    simulatedTimeRef.current = now;
    lastTickRef.current = performance.now();
    const current = toDateTimeLocalValue(now);
    setIsEditingTime(false);
    setIsTimePickerOpen(false);
    setTimeDraft(current);
    setTimePickerDraft(current);
    applyObservationTime(now);
  }

  async function handleToggle(name: keyof typeof TOGGLE_PATHS) {
    const engine = engineRef.current;
    const nextValue = !toggles[name];
    setToggles((current) => ({ ...current, [name]: nextValue }));

    if (!engine) return;

    trySetAllValues(engine, TOGGLE_PATHS[name], nextValue);
    if (name === "constellationLines") {
      trySetValue(engine, ["constellations.show_only_pointed"], false);
      getEngineModule(engine, "skycultures")?.update?.();
      getEngineModule(engine, "constellations")?.update?.();
      if (nextValue && constellationLineObjectsRef.current.length === 0) {
        constellationLineObjectsRef.current =
          await createConstellationLineObjects(engine);
      }
      setConstellationLineObjectVisible(
        engine,
        constellationLineObjectsRef.current,
        nextValue,
        isConstellationLineObjectAddedRef
      );
    }
  }

  function handleDeepSkyModeToggle() {
    const engine = engineRef.current;
    const nextValue = !deepSkyMode;
    setDeepSkyMode(nextValue);
    if (engine) {
      applyDeepSkyMode(engine, nextValue);
    }
  }

  return (
    <main className={styles.shell}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onMouseDown={handleCanvasMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onWheel={handleCanvasWheel}
        onClick={handleCanvasClick}
      />

      <section className={styles.panel} aria-label="Stellarium controls">
        <div className={styles.header}>
          <div>
            <p className={styles.kicker}>Stellarium Web Engine</p>
            <h1>관측 하늘</h1>
          </div>
          <span className={`${styles.status} ${styles[status]}`}>
            {statusText}
          </span>
        </div>

        <form className={styles.search} onSubmit={handleSearch}>
          <div className={styles.searchBox}>
            <input
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Vega, Sirius, HR 7001..."
              aria-label="천체 검색"
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <div className={styles.suggestionList}>
                {suggestions.map((item) => (
                  <button
                    key={`${item.key}-${item.label}`}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setQuery(item.label);
                      selectTarget(item.obj, item.label, item.vector);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="submit" disabled={status !== "ready"}>
            이동
          </button>
        </form>

        <div className={styles.field}>
          <span>시간</span>
          <div className={styles.timeField}>
            <button
              type="button"
              className={styles.timeInputButton}
              onClick={openTimePicker}
              disabled={status !== "ready"}
            >
              <CalendarIcon />
              <span>{formatDisplayDateTime(timeDraft)}</span>
            </button>
            <button
              type="button"
              onClick={handleUseCurrentTime}
              disabled={status !== "ready"}
            >
              현재시간
            </button>
          </div>
          {isTimePickerOpen && (
            <section className={styles.timePicker} aria-label="시간 선택">
              <div className={styles.timePickerHeader}>
                <button
                  type="button"
                  onClick={() =>
                    setTimePickerMonth(
                      new Date(
                        timePickerMonth.getFullYear(),
                        timePickerMonth.getMonth() - 1,
                        1
                      )
                    )
                  }
                >
                  이전
                </button>
                <strong>
                  {timePickerMonth.getFullYear()}년{" "}
                  {String(timePickerMonth.getMonth() + 1).padStart(2, "0")}월
                </strong>
                <button
                  type="button"
                  onClick={() =>
                    setTimePickerMonth(
                      new Date(
                        timePickerMonth.getFullYear(),
                        timePickerMonth.getMonth() + 1,
                        1
                      )
                    )
                  }
                >
                  다음
                </button>
              </div>
              <div className={styles.calendarWeekdays}>
                {WEEKDAY_LABELS.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <div className={styles.calendarGrid}>
                {calendarDays.map((date) => {
                  const isCurrentMonth =
                    date.getMonth() === timePickerMonth.getMonth();
                  const isSelected =
                    date.getFullYear() === timeDraftDate.getFullYear() &&
                    date.getMonth() === timeDraftDate.getMonth() &&
                    date.getDate() === timeDraftDate.getDate();

                  return (
                    <button
                      key={date.toISOString()}
                      type="button"
                      className={[
                        isCurrentMonth ? "" : styles.outsideMonth,
                        isSelected ? styles.selectedDay : "",
                      ].join(" ")}
                      onClick={() => updateDraftDate(date)}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
              <div className={styles.timePickerClock}>
                <select
                  value={timeDraftDate.getHours()}
                  onChange={(event) => updateDraftTime("hour", event.target.value)}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}시
                    </option>
                  ))}
                </select>
                <select
                  value={timeDraftDate.getMinutes()}
                  onChange={(event) =>
                    updateDraftTime("minute", event.target.value)
                  }
                >
                  {Array.from({ length: 60 }, (_, minute) => (
                    <option key={minute} value={minute}>
                      {String(minute).padStart(2, "0")}분
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.timePickerActions}>
                <button type="button" onClick={handleApplyTime}>
                  확인
                </button>
              </div>
            </section>
          )}
        </div>

        <div className={styles.timeControls} aria-label="시간 흐름 제어">
          <label className={styles.speedField}>
            <span>배속</span>
            <select
              value={timeSpeedIndex}
              onChange={(event) => setTimeSpeedIndex(Number(event.target.value))}
              disabled={status !== "ready"}
            >
              {TIME_SPEEDS.map((speed, index) => (
                <option key={speed.label} value={index}>
                  {speed.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={[styles.timePauseButton, isTimePaused ? styles.active : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => {
              lastTickRef.current = performance.now();
              setIsTimePaused((current) => !current);
            }}
            disabled={status !== "ready"}
            aria-label={isTimePaused ? "시간 재생" : "시간 멈춤"}
            aria-pressed={isTimePaused}
            title={isTimePaused ? "시간 재생" : "시간 멈춤"}
          >
            <span
              className={isTimePaused ? styles.playIcon : styles.pauseIcon}
              aria-hidden="true"
            />
          </button>
        </div>

      <LocationPicker
        status={status}
        locationName={locationQuery}
        observerLocation={observerLocation}
        onApply={(location, name) => {
          const engine = engineRef.current;
          if (!engine) return false;

          if (!setObserverLocation(engine, location.latitude, location.longitude)) {
            return false;
          }

          setObserverLocationState(location);
          setLocationQuery(name ?? "선택한 위치");
          applyObservationTime(simulatedTimeRef.current);

          const selected = selectedTargetRef.current;
          if (selected) {
            setSelectedInfo(
              getSafeObjectInfo(engine, selected.obj, selected.label, selected.vector)
            );
          }

          return true;
        }}
      />

        <div className={styles.buttonGrid} aria-label="Display toggles">
          <button
            type="button"
            className={toggles.horizontalCoordinates ? styles.active : ""}
            onClick={() => handleToggle("horizontalCoordinates")}
            aria-pressed={toggles.horizontalCoordinates}
          >
            지평좌표 {toggles.horizontalCoordinates ? "켜짐" : "꺼짐"}
          </button>
          <button
            type="button"
            className={toggles.constellationLines ? styles.active : ""}
            onClick={() => handleToggle("constellationLines")}
            aria-pressed={toggles.constellationLines}
          >
            별자리선 {toggles.constellationLines ? "켜짐" : "꺼짐"}
          </button>
          <button
            type="button"
            className={toggles.atmosphere ? styles.active : ""}
            onClick={() => handleToggle("atmosphere")}
            aria-pressed={toggles.atmosphere}
          >
            대기 {toggles.atmosphere ? "켜짐" : "꺼짐"}
          </button>
          <button
            type="button"
            className={toggles.ground ? styles.active : ""}
            onClick={() => handleToggle("ground")}
            aria-pressed={toggles.ground}
          >
            지평 {toggles.ground ? "켜짐" : "꺼짐"}
          </button>
          <button
            type="button"
            className={deepSkyMode ? styles.active : ""}
            onClick={handleDeepSkyModeToggle}
            aria-pressed={deepSkyMode}
          >
            딥스카이 {deepSkyMode ? "켜짐" : "꺼짐"}
          </button>
        </div>
      </section>

      <div className={styles.bottomToolbar} aria-label="Display toggles">
        <button
          type="button"
          className={toggles.constellationLines ? styles.active : ""}
          onClick={() => handleToggle("constellationLines")}
          aria-label={`별자리선 ${toggles.constellationLines ? "끄기" : "켜기"}`}
          aria-pressed={toggles.constellationLines}
          title={`별자리선 ${toggles.constellationLines ? "끄기" : "켜기"}`}
        >
          <ToolbarIcon name="constellation" />
        </button>
        <button
          type="button"
          className={toggles.horizontalCoordinates ? styles.active : ""}
          onClick={() => handleToggle("horizontalCoordinates")}
          aria-label={`지평좌표 ${toggles.horizontalCoordinates ? "끄기" : "켜기"}`}
          aria-pressed={toggles.horizontalCoordinates}
          title={`지평좌표 ${toggles.horizontalCoordinates ? "끄기" : "켜기"}`}
        >
          <ToolbarIcon name="horizontal" />
        </button>
        <button
          type="button"
          className={toggles.atmosphere ? styles.active : ""}
          onClick={() => handleToggle("atmosphere")}
          aria-label={`대기 ${toggles.atmosphere ? "끄기" : "켜기"}`}
          aria-pressed={toggles.atmosphere}
          title={`대기 ${toggles.atmosphere ? "끄기" : "켜기"}`}
        >
          <ToolbarIcon name="atmosphere" />
        </button>
        <button
          type="button"
          className={toggles.ground ? styles.active : ""}
          onClick={() => handleToggle("ground")}
          aria-label={`지평 ${toggles.ground ? "끄기" : "켜기"}`}
          aria-pressed={toggles.ground}
          title={`지평 ${toggles.ground ? "끄기" : "켜기"}`}
        >
          <ToolbarIcon name="ground" />
        </button>
        <button
          type="button"
          className={deepSkyMode ? styles.active : ""}
          onClick={handleDeepSkyModeToggle}
          aria-label={`딥스카이 ${deepSkyMode ? "끄기" : "켜기"}`}
          aria-pressed={deepSkyMode}
          title={`딥스카이 ${deepSkyMode ? "끄기" : "켜기"}`}
        >
          <ToolbarIcon name="deepSky" />
        </button>
      </div>

      <ObjectInfoPanel info={selectedInfo} />
    </main>
  );
}
