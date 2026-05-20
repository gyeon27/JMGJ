import type { ObjectInfo, StellariumEngine, SweObj } from "./types";

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
  return `${sign}${Math.abs(value).toFixed(2)}°`;
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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type SupplementalObjectInfo = {
  distanceParsec?: number;
  absoluteMagnitude?: number;
  objectType?: string;
};

const SUPPLEMENTAL_OBJECT_INFO: Record<string, SupplementalObjectInfo> = {
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
};

function getInfoNumber(target: SweObj, observer: SweObj, keys: string[]) {
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

function formatMagnitude(value: number | null) {
  return value === null ? "정보 없음" : value.toFixed(2);
}

function formatDistance(value: number | null) {
  if (value === null || value <= 0) return "정보 없음";
  if (value < 0.001) return `${(value * 149_597_870.7).toFixed(0)} km`;
  if (value < 10_000) return `${value.toFixed(3)} AU`;
  return `${value.toExponential(3)} AU`;
}

function formatParsecDistance(value: number | null) {
  if (value === null || value <= 0) return "정보 없음";
  const lightYears = value * 3.26156;
  if (lightYears >= 10_000) return `${(lightYears / 1000).toFixed(1)} kly`;
  if (lightYears >= 1000) return `${(lightYears / 1000).toFixed(2)} kly`;
  return `${lightYears.toFixed(0)} ly`;
}

function formatDimensions(modelData: Record<string, unknown> | undefined) {
  const dimX = readNumber(modelData?.dimx);
  const dimY = readNumber(modelData?.dimy);
  if (dimX === null && dimY === null) return "정보 없음";
  if (dimX !== null && dimY !== null) {
    return `${dimX.toFixed(1)}′ × ${dimY.toFixed(1)}′`;
  }
  return `${(dimX ?? dimY)?.toFixed(1)}′`;
}

function cleanDesignation(value: string) {
  return value.replace(/^NAME\s+/i, "").replace(/\s+/g, " ").trim();
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

function getSupplementalObjectInfo(
  target: SweObj,
  primaryName: string
): SupplementalObjectInfo | null {
  const names = [primaryName, ...(target.designations?.() ?? [])].map((name) =>
    cleanDesignation(name).toLowerCase()
  );

  for (const name of names) {
    const info = SUPPLEMENTAL_OBJECT_INFO[name];
    if (info) return info;
  }

  return null;
}

export function getObjectInfo(
  engine: StellariumEngine,
  target: SweObj,
  label: string,
  vector?: number[]
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
  const supplementalInfo = getSupplementalObjectInfo(target, label);
  const apparentMagnitude =
    getInfoNumber(target, observer, ["VMAG", "vmag"]) ??
    readNumber(modelData?.Vmag) ??
    readNumber(modelData?.vmag) ??
    readNumber(modelData?.Bmag);
  const distanceAu = getInfoNumber(target, observer, ["DISTANCE", "distance"]);
  const distanceParsec = supplementalInfo?.distanceParsec ?? null;
  const absoluteMagnitude =
    supplementalInfo?.absoluteMagnitude ??
    (apparentMagnitude !== null && distanceParsec !== null && distanceParsec > 0
      ? apparentMagnitude - 5 * Math.log10(distanceParsec / 10)
      : null);
  const distanceModulus =
    apparentMagnitude !== null && absoluteMagnitude !== null
      ? apparentMagnitude - absoluteMagnitude
      : null;
  const distanceText =
    distanceParsec !== null ? formatParsecDistance(distanceParsec) : formatDistance(distanceAu);

  return {
    name: label,
    aliases: getAliases(target, label),
    altitude: formatDegrees(horizontal.latitude, true),
    azimuth: formatDegrees(horizontal.longitude),
    rightAscension: formatRightAscension(equatorial.longitude),
    declination: formatDegrees(equatorial.latitude, true),
    apparentMagnitude: formatMagnitude(apparentMagnitude),
    absoluteMagnitude: formatMagnitude(absoluteMagnitude),
    distance: distanceText,
    distanceModulus: formatMagnitude(distanceModulus),
    objectType:
      supplementalInfo?.objectType ?? target.id?.replace(/^NAME\s+/i, "") ?? "정보 없음",
    dimensions: formatDimensions(modelData),
    spectrum: typeof modelData?.spect_t === "string" ? modelData.spect_t : "정보 없음",
  };
}
