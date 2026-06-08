import {
  type DeepSkySupplementEntry,
  type DeepSkySupplementIndex,
  findDeepSkySupplement,
} from "./deepSkyCatalog";
import {
  calculateDifficultyDetails,
  type DifficultyObjectType,
} from "./difficulty";
import { findBrightStarSupplement } from "./skyCatalog";
import type { ObjectInfo, StellariumEngine, SweObj } from "./types";

let deepSkySupplementIndex: DeepSkySupplementIndex = new Map();

type ObjectInfoOptions = {
  skyBrightness?: number;
  telescopeApertureMm?: number;
  seeingArcsec?: number | null;
  daylight?: boolean;
};

const PLANET_TYPE_NAMES = new Set([
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "sun",
  "moon",
  "\uC218\uC131",
  "\uAE08\uC131",
  "\uD654\uC131",
  "\uBAA9\uC131",
  "\uD1A0\uC131",
  "\uCC9C\uC655\uC131",
  "\uD574\uC655\uC131",
  "\uD0DC\uC591",
  "\uB2EC",
]);

export function setDeepSkySupplementIndex(index: DeepSkySupplementIndex) {
  deepSkySupplementIndex = index;
}

export function getCoreNumber(
  engine: StellariumEngine,
  path: string,
  fallback: number
) {
  const value = engine.getValue?.(path);
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const direct = path.split(".").reduce<unknown>((target, key) => {
    if (!target || typeof target !== "object") return undefined;
    return (target as Record<string, unknown>)[key];
  }, engine.core);

  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (
    direct &&
    typeof direct === "object" &&
    typeof (direct as { v?: unknown }).v === "number" &&
    Number.isFinite((direct as { v: number }).v)
  ) {
    return (direct as { v: number }).v;
  }

  return fallback;
}

function getObserver(engine: StellariumEngine) {
  return engine.observer ?? (engine.core?.observer as SweObj | undefined);
}

function sphericalDegreesToVector(raDegrees: number, decDegrees: number) {
  const ra = (raDegrees * Math.PI) / 180;
  const dec = (decDegrees * Math.PI) / 180;
  const cosDec = Math.cos(dec);

  return [Math.cos(ra) * cosDec, Math.sin(ra) * cosDec, Math.sin(dec)];
}

export function getTargetVector(
  target: SweObj,
  observer: SweObj | undefined,
  fallback?: number[],
  options: { preferFallback?: boolean } = {}
) {
  if (options.preferFallback && fallback && fallback.length >= 3) {
    const vector = fallback.slice(0, 3).map(Number);
    if (vector.every(Number.isFinite)) return vector;
  }

  try {
    target.update?.();
  } catch {
    // Engine-native solar-system objects may update through the core frame only.
  }

  try {
    const info = target.getInfo?.("radec", observer);
    if (Array.isArray(info) && info.length >= 3) {
      const vector = info.slice(0, 3).map(Number);
      if (vector.every(Number.isFinite)) return vector;
    }
  } catch {
    // Some engine objects throw while ephemerides are still warming up.
  }

  try {
    if (Array.isArray(target.radec) && target.radec.length >= 3) {
      const vector = target.radec.slice(0, 3).map(Number);
      if (vector.every(Number.isFinite)) return vector;
    }
  } catch {
    // Fall back below.
  }

  try {
    const modelData = target.jsonData?.model_data;
    const ra = readNumber(modelData?.ra);
    const dec = readNumber(modelData?.de) ?? readNumber(modelData?.dec);
    if (ra !== null && dec !== null) {
      return sphericalDegreesToVector(ra, dec);
    }
  } catch {
    // Fall back below.
  }

  if (fallback && fallback.length >= 3) {
    const vector = fallback.slice(0, 3).map(Number);
    if (vector.every(Number.isFinite)) return vector;
  }

  return null;
}

export function projectTargetToScreen(
  engine: StellariumEngine,
  canvas: HTMLCanvasElement,
  target: SweObj,
  vector?: number[]
) {
  const observer = getObserver(engine);
  if (!observer || !engine.convertFrame) return null;

  const targetVector = getTargetVector(target, observer, vector, {
    preferFallback: true,
  });
  if (!targetVector) return null;

  const view = engine.convertFrame(observer, "ICRF", "VIEW", targetVector);
  if (!Array.isArray(view) || view.length < 3) return null;

  const [x, y, z] = view;
  if (![x, y, z].every(Number.isFinite)) return null;

  const rect = canvas.getBoundingClientRect();
  const rawFov = getCoreNumber(
    engine,
    "fov",
    getCoreNumber(engine, "zoom", Math.PI / 3)
  );
  const fov = rawFov > Math.PI ? (rawFov * Math.PI) / 180 : rawFov;
  const projection = getCoreNumber(engine, "projection", 0);
  const distance = Math.hypot(x, y);

  if (projection === 2) {
    const forward = -z;
    const angle = Math.atan2(distance, forward);
    const radius = angle * (rect.height / fov);
    const normalizedX = distance > 0 ? x / distance : 0;
    const normalizedY = distance > 0 ? y / distance : 0;

    return {
      x: rect.width / 2 + normalizedY * radius,
      y: rect.height / 2 + normalizedX * radius,
    };
  }

  const angle = Math.atan2(distance, z);
  const scale =
    projection === 1
      ? rect.height / 2 / Math.tan(fov / 4)
      : rect.height / 2 / Math.tan(fov / 2);
  const radius =
    projection === 1 ? Math.tan(angle / 2) * scale : Math.tan(angle) * scale;
  const normalizedX = distance > 0 ? x / distance : 0;
  const normalizedY = distance > 0 ? y / distance : 0;

  return {
    x: rect.width / 2 + normalizedX * radius,
    y: rect.height / 2 - normalizedY * radius,
  };
}

function vectorToSpherical(vector: number[]) {
  const [x, y, z] = vector;
  const radius = Math.hypot(x, y, z);
  if (!radius) return null;

  return {
    longitude: normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI),
    latitude: (Math.asin(z / radius) * 180) / Math.PI,
  };
}

function normalizeDegrees(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function formatDegrees(value: number, signed = false) {
  const sign = value < 0 ? "-" : signed ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(2)}\u00B0`;
}

function formatArcSeconds(value: number) {
  if (value >= 60) return `${(value / 60).toFixed(2)}\u2032`;
  return `${value.toFixed(1)}\u2033`;
}

function formatAngularSize(radians: number | null) {
  if (radians === null || radians <= 0) return "\uC815\uBCF4 \uC5C6\uC74C";

  const arcSeconds = (radians * 180 * 3600) / Math.PI;
  if (arcSeconds >= 3600) return `${(arcSeconds / 3600).toFixed(2)}\u00B0`;
  return formatArcSeconds(arcSeconds);
}

function formatAngularArea(radians: number | null) {
  if (radians === null || radians <= 0) return "\uC815\uBCF4 \uC5C6\uC74C";

  const diameterArcMinutes = (radians * 180 * 60) / Math.PI;
  const area = Math.PI * (diameterArcMinutes / 2) ** 2;
  if (area >= 1) return `${area.toFixed(2)} arcmin\u00B2`;
  return `${(area * 3600).toFixed(1)} arcsec\u00B2`;
}

function normalizeAngularSizeRadians(value: number | null) {
  if (value === null || value <= 0) return null;

  if (value > 360) return (value / 3600 / 180) * Math.PI;
  if (value > Math.PI * 2) return (value / 180) * Math.PI;
  return value;
}

function arcMinutesToRadians(value: number | null | undefined) {
  if (value === undefined || value === null || value <= 0) return null;
  return (value / 60 / 180) * Math.PI;
}

function formatCatalogArcMinutes(value: number) {
  if (value < 1) return `${(value * 60).toFixed(1)}\u2033`;
  if (value >= 60) return `${(value / 60).toFixed(2)}\u00B0`;
  return `${value.toFixed(1)}\u2032`;
}

function formatCatalogAngularSize(info: SupplementalObjectInfo | null) {
  const major = info?.majorAxisArcMinutes;
  const minor = info?.minorAxisArcMinutes;

  if (major !== undefined && minor !== undefined) {
    return `${formatCatalogArcMinutes(major)} × ${formatCatalogArcMinutes(minor)}`;
  }

  if (major !== undefined) return formatCatalogArcMinutes(major);
  if (minor !== undefined) return formatCatalogArcMinutes(minor);
  return null;
}

function formatCatalogAngularArea(info: SupplementalObjectInfo | null) {
  const major = info?.majorAxisArcMinutes;
  const minor = info?.minorAxisArcMinutes ?? major;
  if (major === undefined || minor === undefined) return null;

  const area = Math.PI * (major / 2) * (minor / 2);
  if (area >= 1) return `${area.toFixed(2)} arcmin²`;
  return `${(area * 3600).toFixed(1)} arcsec²`;
}

function formatRightAscension(degrees: number) {
  const totalSeconds = (normalizeDegrees(degrees) / 15) * 3600;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);

  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(
    seconds
  ).padStart(2, "0")}s`;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const match = value.trim().match(/^[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;

  const numericValue = Number(match[0]);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readInfoMap(target: SweObj, observer: SweObj) {
  for (const key of ["all", "ALL", "info", ""]) {
    try {
      const value = target.getInfo?.(key, observer);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Engine builds differ in accepted aggregate info formats.
    }
  }

  return null;
}

function normalizeInfoKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findInfoMapValue(
  infoMap: Record<string, unknown> | null,
  keys: string[]
) {
  if (!infoMap) return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(infoMap, key)) {
      return infoMap[key];
    }

    const normalizedKey = normalizeInfoKey(key);
    const matchedKey = Object.keys(infoMap).find(
      (candidate) => normalizeInfoKey(candidate) === normalizedKey
    );
    if (matchedKey) return infoMap[matchedKey];
  }

  return undefined;
}

function getInfoMapNumber(
  infoMap: Record<string, unknown> | null,
  keys: string[]
) {
  const value = findInfoMapValue(infoMap, keys);
  return readNumber(value);
}

function getInfoMapString(
  infoMap: Record<string, unknown> | null,
  keys: string[]
) {
  const value = findInfoMapValue(infoMap, keys);
  return readString(value);
}

type SupplementalObjectInfo = {
  distanceParsec?: number;
  absoluteMagnitude?: number;
  apparentMagnitude?: number;
  objectType?: string;
  angularSizeArcMinutes?: number;
  majorAxisArcMinutes?: number;
  minorAxisArcMinutes?: number;
  surfaceBrightness?: number;
  positionAngleDeg?: number;
  constellation?: string;
  hubbleType?: string;
};

const SUPPLEMENTAL_OBJECT_INFO: Record<string, SupplementalObjectInfo> = {
  "great orion nebula": {
    distanceParsec: 412,
    angularSizeArcMinutes: 65,
    objectType: "성운",
  },
  "orion nebula": {
    distanceParsec: 412,
    angularSizeArcMinutes: 65,
    objectType: "성운",
  },
  "m 42": {
    distanceParsec: 412,
    angularSizeArcMinutes: 65,
    objectType: "성운",
  },
  "messier 42": {
    distanceParsec: 412,
    angularSizeArcMinutes: 65,
    objectType: "성운",
  },
  "ngc 1976": {
    distanceParsec: 412,
    angularSizeArcMinutes: 65,
    objectType: "성운",
  },
  "beehive cluster": {
    distanceParsec: 187,
    angularSizeArcMinutes: 95,
    objectType: "산개성단",
  },
  praesepe: {
    distanceParsec: 187,
    angularSizeArcMinutes: 95,
    objectType: "산개성단",
  },
  "m 44": {
    distanceParsec: 187,
    angularSizeArcMinutes: 95,
    objectType: "산개성단",
  },
  "messier 44": {
    distanceParsec: 187,
    angularSizeArcMinutes: 95,
    objectType: "산개성단",
  },
  "ngc 2632": {
    distanceParsec: 187,
    angularSizeArcMinutes: 95,
    objectType: "산개성단",
  },
  pleiades: {
    distanceParsec: 136,
    angularSizeArcMinutes: 110,
    objectType: "산개성단",
  },
  "m 45": {
    distanceParsec: 136,
    angularSizeArcMinutes: 110,
    objectType: "산개성단",
  },
  "messier 45": {
    distanceParsec: 136,
    angularSizeArcMinutes: 110,
    objectType: "산개성단",
  },
  "andromeda galaxy": {
    distanceParsec: 765_000,
    angularSizeArcMinutes: 190,
    objectType: "은하",
  },
  "m 31": {
    distanceParsec: 765_000,
    angularSizeArcMinutes: 190,
    objectType: "은하",
  },
  "messier 31": {
    distanceParsec: 765_000,
    angularSizeArcMinutes: 190,
    objectType: "은하",
  },
  "m 3": {
    distanceParsec: 10_400,
    objectType: "구상성단",
  },
  "messier 3": {
    distanceParsec: 10_400,
    objectType: "구상성단",
  },
  "ngc 5272": {
    distanceParsec: 10_400,
    objectType: "구상성단",
  },
  sirius: {
    distanceParsec: 2.64,
    absoluteMagnitude: 1.42,
    objectType: "별",
  },
  canopus: {
    distanceParsec: 95.9,
    absoluteMagnitude: -5.71,
    objectType: "별",
  },
  arcturus: {
    distanceParsec: 11.26,
    absoluteMagnitude: -0.31,
    objectType: "별",
  },
  vega: {
    distanceParsec: 7.68,
    absoluteMagnitude: 0.58,
    objectType: "별",
  },
  capella: {
    distanceParsec: 12.9,
    absoluteMagnitude: -0.48,
    objectType: "별",
  },
  rigel: {
    distanceParsec: 264,
    absoluteMagnitude: -6.7,
    objectType: "별",
  },
  procyon: {
    distanceParsec: 3.51,
    absoluteMagnitude: 2.66,
    objectType: "별",
  },
  betelgeuse: {
    distanceParsec: 168,
    absoluteMagnitude: -5.6,
    objectType: "별",
  },
  altair: {
    distanceParsec: 5.13,
    absoluteMagnitude: 2.21,
    objectType: "별",
  },
  aldebaran: {
    distanceParsec: 20.43,
    absoluteMagnitude: -0.64,
    objectType: "별",
  },
  spica: {
    distanceParsec: 77,
    absoluteMagnitude: -3.55,
    objectType: "별",
  },
  antares: {
    distanceParsec: 170,
    absoluteMagnitude: -5.28,
    objectType: "별",
  },
  pollux: {
    distanceParsec: 10.36,
    absoluteMagnitude: 1.07,
    objectType: "별",
  },
  fomalhaut: {
    distanceParsec: 7.7,
    absoluteMagnitude: 1.72,
    objectType: "별",
  },
  deneb: {
    distanceParsec: 802,
    absoluteMagnitude: -8.38,
    objectType: "별",
  },
  regulus: {
    distanceParsec: 24.3,
    absoluteMagnitude: -0.52,
    objectType: "별",
  },
  castor: {
    distanceParsec: 15.6,
    absoluteMagnitude: 0.59,
    objectType: "별",
  },
  polaris: {
    distanceParsec: 132.6,
    absoluteMagnitude: -3.64,
    objectType: "별",
  },
  algol: {
    distanceParsec: 27.6,
    absoluteMagnitude: -0.15,
    objectType: "별",
  },
  mizar: {
    distanceParsec: 25.1,
    absoluteMagnitude: 0.33,
    objectType: "별",
  },
};

function getInfoNumber(
  target: SweObj,
  observer: SweObj,
  keys: string[],
  infoMap: Record<string, unknown> | null = null
) {
  const mappedValue = getInfoMapNumber(infoMap, keys);
  if (mappedValue !== null) return mappedValue;

  for (const key of keys) {
    try {
      const value = target.getInfo?.(key, observer);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      // Info availability differs by object type.
    }
  }

  return null;
}

function getInfoString(
  target: SweObj,
  observer: SweObj,
  keys: string[],
  infoMap: Record<string, unknown> | null = null
) {
  const mappedValue = getInfoMapString(infoMap, keys);
  if (mappedValue) return mappedValue;

  for (const key of keys) {
    try {
      const value = readString(target.getInfo?.(key, observer));
      if (value) return value;
    } catch {
      // Info availability differs by object type.
    }
  }

  return null;
}

function formatMagnitude(value: number | null) {
  return value === null ? "\uC815\uBCF4 \uC5C6\uC74C" : value.toFixed(2);
}

function formatSignedDegreesFromRadians(value: number | null) {
  return value === null
    ? "\uC815\uBCF4 \uC5C6\uC74C"
    : formatDegrees((value * 180) / Math.PI, true);
}

function formatDegreesFromRadians(value: number | null) {
  return value === null ? "\uC815\uBCF4 \uC5C6\uC74C" : formatDegrees((value * 180) / Math.PI);
}

function formatPercent(value: number | null) {
  if (value === null) return "\uC815\uBCF4 \uC5C6\uC74C";
  const percent = value <= 1 ? value * 100 : value;
  return `${percent.toFixed(1)}%`;
}

function normalizePhaseFraction(value: number | null) {
  if (value === null) return null;
  const fraction = value > 1 ? value / 100 : value;
  if (!Number.isFinite(fraction)) return null;
  return Math.min(1, Math.max(0, fraction));
}

function formatAngleFromEngine(
  engineText: string | null,
  radians: number | null,
  signed = false
) {
  if (engineText) return engineText;
  return signed
    ? formatSignedDegreesFromRadians(radians)
    : formatDegreesFromRadians(radians);
}

function formatDistance(value: number | null) {
  if (value === null || value <= 0) return "\uC815\uBCF4 \uC5C6\uC74C";
  if (value < 0.001) return `${(value * 149_597_870.7).toFixed(0)} km`;
  if (value < 10_000) return `${value.toFixed(3)} AU`;
  return `${value.toExponential(3)} AU`;
}

function formatParsecDistance(value: number | null) {
  if (value === null || value <= 0) return "\uC815\uBCF4 \uC5C6\uC74C";
  const lightYears = value * 3.26156;
  if (value < 1000) {
    return `${value.toFixed(2)} pc (${lightYears.toFixed(1)} ly)`;
  }
  if (lightYears >= 10_000) return `${(lightYears / 1000).toFixed(1)} kly`;
  if (lightYears >= 1000) return `${(lightYears / 1000).toFixed(2)} kly`;
  return `${lightYears.toFixed(0)} ly`;
}

function cleanDesignation(value: string) {
  return value.replace(/^NAME\s+/i, "").replace(/\s+/g, " ").trim();
}

function collectSupplementalNames(target: SweObj, primaryName: string) {
  const names = new Set<string>([primaryName]);

  for (const value of [target.name, target.id, target.path, target.getPath?.()]) {
    if (value) names.add(cleanDesignation(value));
  }

  try {
    for (const designation of target.designations?.() ?? []) {
      names.add(cleanDesignation(designation));
    }
  } catch {
    // Engine-native objects can throw while building designation strings.
  }

  return [...names].filter(Boolean);
}

function getAliases(target: SweObj, primaryName: string) {
  try {
    const primaryKey = primaryName.toLowerCase();
    const seen = new Set<string>();
    return (target.designations?.() ?? [])
      .map(cleanDesignation)
      .filter((name) => {
        const key = name.toLowerCase();
        if (!name || key === primaryKey || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
  } catch {
    return [];
  }
}

function deepSkyEntryToSupplemental(
  entry: DeepSkySupplementEntry | null
): SupplementalObjectInfo | null {
  if (!entry) return null;

  return {
    apparentMagnitude: entry.magnitude,
    objectType: entry.objectType,
    angularSizeArcMinutes: entry.majorAxisArcmin ?? entry.minorAxisArcmin,
    majorAxisArcMinutes: entry.majorAxisArcmin,
    minorAxisArcMinutes: entry.minorAxisArcmin,
    surfaceBrightness: entry.surfaceBrightness,
    positionAngleDeg: entry.positionAngleDeg,
    constellation: entry.constellation,
    hubbleType: entry.hubbleType,
  };
}

function getSupplementalObjectInfo(
  target: SweObj,
  primaryName: string
): SupplementalObjectInfo | null {
  const rawNames = collectSupplementalNames(target, primaryName);
  const deepSkyInfo = deepSkyEntryToSupplemental(
    findDeepSkySupplement(deepSkySupplementIndex, rawNames)
  );
  const brightStarInfo = findBrightStarSupplement(rawNames);
  const names = rawNames.map((name) => cleanDesignation(name).toLowerCase());

  for (const name of names) {
    const info = SUPPLEMENTAL_OBJECT_INFO[name];
    if (info) return { ...brightStarInfo, ...info, ...deepSkyInfo };
  }

  return deepSkyInfo ?? brightStarInfo;
}

function getObjectType(
  target: SweObj,
  modelData: Record<string, unknown> | undefined,
  supplementalInfo: SupplementalObjectInfo | null,
  primaryName: string
) {
  if (supplementalInfo?.objectType) return supplementalInfo.objectType;

  const types = modelData?.types;
  if (Array.isArray(types) && types.includes("*")) return "\uBCC4";
  if (
    target.id?.startsWith("bsc-") ||
    target.id?.startsWith("hr-") ||
    target.id?.startsWith("hip-") ||
    target.id?.startsWith("hd-") ||
    target.id?.startsWith("hyg-")
  ) {
    return "\uBCC4";
  }

  const names = collectSupplementalNames(target, primaryName).map((name) =>
    cleanDesignation(name).toLowerCase()
  );
  if (names.some((name) => SUPPLEMENTAL_OBJECT_INFO[name]?.objectType === "\uBCC4")) {
    return "\uBCC4";
  }
  if (findBrightStarSupplement(collectSupplementalNames(target, primaryName))) {
    return "\uBCC4";
  }

  return target.id?.replace(/^NAME\s+/i, "") ?? "\uC815\uBCF4 \uC5C6\uC74C";
}

function getDifficultyObjectType(objectType: string): DifficultyObjectType {
  const normalized = objectType.toLowerCase();
  if (PLANET_TYPE_NAMES.has(normalized)) {
    return "planet";
  }
  if (normalized.includes("\uC740\uD558") || normalized.includes("galaxy")) {
    return "galaxy";
  }
  if (normalized.includes("\uAD6C\uC0C1") || normalized.includes("globular")) {
    return "globular cluster";
  }
  if (normalized.includes("\uC0B0\uAC1C") || normalized.includes("open cluster")) {
    return "open cluster";
  }
  if (normalized.includes("\uC131\uC6B4") || normalized.includes("nebula")) {
    return "nebula";
  }
  if (normalized.includes("\uBCC4") || normalized.includes("star")) {
    return "star";
  }
  return "unknown";
}

function hasInfo(value: string) {
  return value !== "\uC815\uBCF4 \uC5C6\uC74C";
}

function buildPhysicalFields({
  apparentMagnitude,
  absoluteMagnitude,
  distanceText,
  distanceModulus,
  objectType,
  phase,
  phaseAngle,
  elongation,
  angularSize,
  angularArea,
  surfaceBrightness,
  constellation,
  hubbleType,
  positionAngle,
  difficultyText,
  difficultyDescription,
  skyBrightnessText,
  telescopeLimitText,
}: {
  apparentMagnitude: string;
  absoluteMagnitude: string;
  distanceText: string;
  distanceModulus: string;
  objectType: string;
  phase: string;
  phaseAngle: string;
  elongation: string;
  angularSize: string;
  angularArea: string;
  surfaceBrightness: string;
  constellation: string;
  hubbleType: string;
  positionAngle: string;
  difficultyText: string;
  difficultyDescription: string;
  skyBrightnessText: string;
  telescopeLimitText: string;
}) {
  const fields: Array<[string, string]> = [];

  if (hasInfo(apparentMagnitude)) fields.push(["\uAC89\uBCF4\uAE30 \uB4F1\uAE09", apparentMagnitude]);
  if (hasInfo(absoluteMagnitude)) fields.push(["\uC808\uB300 \uB4F1\uAE09", absoluteMagnitude]);
  if (hasInfo(distanceText)) fields.push(["\uAC70\uB9AC", distanceText]);
  if (hasInfo(distanceModulus)) fields.push(["\uAC70\uB9AC\uACC4\uC218", distanceModulus]);
  if (hasInfo(angularSize)) fields.push(["\uAC89\uBCF4\uAE30 \uD06C\uAE30", angularSize]);
  if (hasInfo(angularArea)) fields.push(["\uC2DC\uBA74\uC801", angularArea]);
  if (hasInfo(surfaceBrightness)) fields.push(["\uD45C\uBA74\uBC1D\uAE30", surfaceBrightness]);
  if (hasInfo(constellation)) fields.push(["\uBCC4\uC790\uB9AC", constellation]);
  if (hasInfo(hubbleType)) fields.push(["\uD5C8\uBE14\uD615", hubbleType]);
  if (hasInfo(positionAngle)) fields.push(["\uC704\uCE58\uAC01", positionAngle]);
  if (hasInfo(difficultyText)) fields.push(["관측 난이도", difficultyText]);
  if (hasInfo(difficultyDescription)) fields.push(["난이도 설명", difficultyDescription]);
  if (hasInfo(skyBrightnessText)) fields.push(["사용된 하늘 밝기", skyBrightnessText]);
  if (hasInfo(telescopeLimitText)) fields.push(["망원경 한계 등급", telescopeLimitText]);
  if (hasInfo(elongation)) fields.push(["\uD0DC\uC591 \uC774\uAC01", elongation]);
  if (hasInfo(phaseAngle)) fields.push(["\uC704\uC0C1\uAC01", phaseAngle]);
  if (hasInfo(phase)) fields.push(["\uC870\uBA85\uB960", phase]);
  if (hasInfo(objectType)) fields.push(["\uBD84\uB958", objectType]);

  return fields;
}
export function getObjectInfo(
  engine: StellariumEngine,
  target: SweObj,
  label: string,
  vector?: number[],
  options: ObjectInfoOptions = {}
): ObjectInfo | null {
  const observer = getObserver(engine);
  if (!observer || !engine.convertFrame) return null;

  const icrfVector = getTargetVector(target, observer, vector, {
    preferFallback: Boolean(vector?.length),
  });
  if (!icrfVector) return null;

  const apparentEquatorialVector = engine.convertFrame(
    observer,
    "ICRF",
    "JNOW",
    icrfVector
  );
  const equatorial = vectorToSpherical(apparentEquatorialVector);
  const observedVector = engine.convertFrame(
    observer,
    "ICRF",
    "OBSERVED",
    icrfVector
  );
  const horizontal = vectorToSpherical(observedVector);

  if (!equatorial || !horizontal) return null;

  const modelData = target.jsonData?.model_data;
  const infoMap = readInfoMap(target, observer);
  const supplementalInfo = getSupplementalObjectInfo(target, label);
  const apparentMagnitude =
    getInfoNumber(target, observer, ["VMAG", "vmag", "magnitude"], infoMap) ??
    readNumber(modelData?.Vmag) ??
    readNumber(modelData?.vmag) ??
    readNumber(modelData?.Bmag) ??
    supplementalInfo?.apparentMagnitude ??
    null;
  const distanceAu = getInfoNumber(
    target,
    observer,
    ["DISTANCE", "distance"],
    infoMap
  );
  const distanceParsec =
    supplementalInfo?.distanceParsec ?? readNumber(modelData?.dist) ?? null;
  const absoluteMagnitude =
    supplementalInfo?.absoluteMagnitude ??
    readNumber(modelData?.absmag) ??
    (apparentMagnitude !== null && distanceParsec !== null && distanceParsec > 0
      ? apparentMagnitude - 5 * Math.log10(distanceParsec / 10)
      : null);
  const distanceModulus =
    apparentMagnitude !== null && absoluteMagnitude !== null
      ? apparentMagnitude - absoluteMagnitude
      : null;
  const distanceText =
    distanceParsec !== null
      ? formatParsecDistance(distanceParsec)
      : formatDistance(distanceAu);
  const objectType = getObjectType(target, modelData, supplementalInfo, label);
  const apparentMagnitudeText = formatMagnitude(apparentMagnitude);
  const absoluteMagnitudeText = formatMagnitude(absoluteMagnitude);
  const distanceModulusText = formatMagnitude(distanceModulus);
  const phaseValue = getInfoNumber(
    target,
    observer,
    ["illumination", "ILLUMINATION", "phase", "PHASE", "illuminated"],
    infoMap
  );
  const phaseText = formatPercent(phaseValue);
  const phaseFraction = normalizePhaseFraction(phaseValue);
  const phaseAngle = getInfoNumber(
    target,
    observer,
    ["phase-angle", "PHASE_ANGLE", "phase_angle", "phaseAngle"],
    infoMap
  );
  const phaseAngleText = formatAngleFromEngine(
    getInfoString(
      target,
      observer,
      ["phase-angle-deg", "phase-angle-dms"],
      infoMap
    ),
    phaseAngle,
    true
  );
  const elongation = getInfoNumber(
    target,
    observer,
    ["elongation", "ELONGATION"],
    infoMap
  );
  const elongationText = formatAngleFromEngine(
    getInfoString(
      target,
      observer,
      ["elongation-deg", "elongation-dms"],
      infoMap
    ),
    elongation
  );
  const angularSizeRadians = normalizeAngularSizeRadians(
    getInfoNumber(
      target,
      observer,
      [
        "angular-size",
        "angular_size",
        "angularDiameter",
        "angular_diameter",
        "sdiam",
        "diameter",
        "size",
      ],
      infoMap
    )
  ) ?? arcMinutesToRadians(supplementalInfo?.angularSizeArcMinutes);
  const angularSizeText =
    formatCatalogAngularSize(supplementalInfo) ?? formatAngularSize(angularSizeRadians);
  const angularAreaText =
    formatCatalogAngularArea(supplementalInfo) ?? formatAngularArea(angularSizeRadians);
  const surfaceBrightnessText =
    supplementalInfo?.surfaceBrightness !== undefined
      ? `${supplementalInfo.surfaceBrightness.toFixed(2)} mag/arcmin\u00B2`
      : "\uC815\uBCF4 \uC5C6\uC74C";
  const constellationText = supplementalInfo?.constellation ?? "\uC815\uBCF4 \uC5C6\uC74C";
  const hubbleTypeText = supplementalInfo?.hubbleType ?? "\uC815\uBCF4 \uC5C6\uC74C";
  const positionAngleText =
    supplementalInfo?.positionAngleDeg !== undefined
      ? `${supplementalInfo.positionAngleDeg.toFixed(0)}\u00B0`
      : "\uC815\uBCF4 \uC5C6\uC74C";
  const fallbackAngularSizeArcmin =
    angularSizeRadians !== null ? (angularSizeRadians * 180 * 60) / Math.PI : null;
  const baseDifficultyObjectType = getDifficultyObjectType(objectType);
  const difficultyObjectType =
    baseDifficultyObjectType === "unknown" &&
    apparentMagnitude !== null &&
    supplementalInfo?.majorAxisArcMinutes === undefined &&
    supplementalInfo?.minorAxisArcMinutes === undefined &&
    supplementalInfo?.angularSizeArcMinutes === undefined &&
    fallbackAngularSizeArcmin === null
      ? "star"
      : baseDifficultyObjectType;
  const difficulty = calculateDifficultyDetails(
    {
      type: difficultyObjectType,
      magnitude: apparentMagnitude,
      altitude: horizontal.latitude,
      majorAxisArcmin:
        supplementalInfo?.majorAxisArcMinutes ??
        supplementalInfo?.angularSizeArcMinutes ??
        fallbackAngularSizeArcmin,
      minorAxisArcmin:
        supplementalInfo?.minorAxisArcMinutes ??
        supplementalInfo?.majorAxisArcMinutes ??
        supplementalInfo?.angularSizeArcMinutes ??
        fallbackAngularSizeArcmin,
      emissionNebula:
        objectType.toLowerCase().includes("emission") ||
        objectType.includes("방출") ||
        objectType.toLowerCase().includes("h ii"),
      daylight: options.daylight,
      daylightExempt: label.toLowerCase() === "sun" || objectType.toLowerCase() === "sun",
    },
    options.skyBrightness ?? 21.3,
    options.telescopeApertureMm ?? 100
  );
  const difficultyText = `${difficulty.difficulty}단계`;
  const skyBrightnessText = `${difficulty.skyBrightness.toFixed(2)} mag/arcsec\u00B2`;
  const telescopeLimitText = `${difficulty.telescopeLimitMagnitude.toFixed(2)} mag`;
  const difficultyDisplayText = `${difficulty.difficulty}\uB2E8\uACC4`;
  const seeingText =
    options.seeingArcsec !== null &&
    options.seeingArcsec !== undefined &&
    Number.isFinite(options.seeingArcsec)
      ? `${options.seeingArcsec.toFixed(2)}"`
      : "\uC815\uBCF4 \uC5C6\uC74C";
  const calculationFields: Array<[string, string]> = [
    ["\uAD00\uCE21 \uB09C\uC774\uB3C4", difficultyDisplayText],
    ["\uB09C\uC774\uB3C4 \uC124\uBA85", difficulty.description],
    ["\uC0AC\uC6A9\uB41C \uD558\uB298 \uBC1D\uAE30", skyBrightnessText],
    ["\uB9DD\uC6D0\uACBD \uD55C\uACC4 \uB4F1\uAE09", telescopeLimitText],
    ["\uC2DC\uC0C1", seeingText],
  ];

  return {
    name: label,
    aliases: getAliases(target, label),
    altitude: formatDegrees(horizontal.latitude, true),
    azimuth: formatDegrees(horizontal.longitude),
    altitudeDegrees: horizontal.latitude,
    azimuthDegrees: ((horizontal.longitude % 360) + 360) % 360,
    rightAscension: formatRightAscension(equatorial.longitude),
    declination: formatDegrees(equatorial.latitude, true),
    apparentMagnitude: apparentMagnitudeText,
    absoluteMagnitude: absoluteMagnitudeText,
    distance: distanceText,
    distanceModulus: distanceModulusText,
    objectType,
    phaseFraction,
    calculationFields,
    physicalFields: buildPhysicalFields({
      apparentMagnitude: apparentMagnitudeText,
      absoluteMagnitude: absoluteMagnitudeText,
      distanceText,
      distanceModulus: distanceModulusText,
      objectType,
      phase: phaseText,
      phaseAngle: phaseAngleText,
      elongation: elongationText,
      angularSize: angularSizeText,
      angularArea: angularAreaText,
      surfaceBrightness: surfaceBrightnessText,
      constellation: constellationText,
      hubbleType: hubbleTypeText,
      positionAngle: positionAngleText,
      difficultyText,
      difficultyDescription: difficulty.description,
      skyBrightnessText,
      telescopeLimitText,
    }),
  };
}
