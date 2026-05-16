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

  const info = target.getInfo?.("radec", observer);
  if (Array.isArray(info) && info.length >= 3) {
    const vector = info.slice(0, 3).map(Number);
    if (vector.every(Number.isFinite)) return vector;
  }

  if (Array.isArray(target.radec) && target.radec.length >= 3) {
    const vector = target.radec.slice(0, 3).map(Number);
    if (vector.every(Number.isFinite)) return vector;
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

export function getObjectInfo(
  engine: StellariumEngine,
  target: SweObj,
  label: string,
  vector?: number[]
): ObjectInfo | null {
  const observer = getObserver(engine);
  if (!observer || !engine.convertFrame) return null;

  const icrfVector = getTargetVector(target, observer, vector);
  if (!icrfVector) return null;

  const equatorial = vectorToSpherical(icrfVector);
  const observedVector = engine.convertFrame(
    observer,
    "ICRF",
    "OBSERVED",
    icrfVector
  );
  const horizontal = vectorToSpherical(observedVector);

  if (!equatorial || !horizontal) return null;

  return {
    name: label,
    altitude: formatDegrees(horizontal.latitude, true),
    azimuth: formatDegrees(horizontal.longitude),
    rightAscension: formatRightAscension(equatorial.longitude),
    declination: formatDegrees(equatorial.latitude, true),
  };
}
