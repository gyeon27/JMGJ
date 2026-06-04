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
  return `${sign}${Math.abs(value).toFixed(2)}°`;
}

function formatArcSeconds(value: number) {
  if (value >= 60) return `${(value / 60).toFixed(2)}'`;
  return `${value.toFixed(1)}"`;
}

function formatAngularSize(radians: number | null) {
  if (radians === null || radians <= 0) return "정보 없음";

  const arcSeconds = (radians * 180 * 3600) / Math.PI;
  if (arcSeconds >= 3600) return `${(arcSeconds / 3600).toFixed(2)}°`;
  return formatArcSeconds(arcSeconds);
}

function formatAngularArea(radians: number | null) {
  if (radians === null || radians <= 0) return "정보 없음";

  const diameterArcMinutes = (radians * 180 * 60) / Math.PI;
  const area = Math.PI * (diameterArcMinutes / 2) ** 2;
  if (area >= 1) return `${area.toFixed(2)} arcmin²`;
  return `${(area * 3600).toFixed(1)} arcsec²`;
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
  objectType?: string;
  angularSizeArcMinutes?: number;
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
  return value === null ? "정보 없음" : value.toFixed(2);
}

function formatSignedDegreesFromRadians(value: number | null) {
  return value === null
    ? "정보 없음"
    : formatDegrees((value * 180) / Math.PI, true);
}

function formatDegreesFromRadians(value: number | null) {
  return value === null ? "정보 없음" : formatDegrees((value * 180) / Math.PI);
}

function formatPercent(value: number | null) {
  if (value === null) return "정보 없음";
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
  if (value === null || value <= 0) return "정보 없음";
  if (value < 0.001) return `${(value * 149_597_870.7).toFixed(0)} km`;
  if (value < 10_000) return `${value.toFixed(3)} AU`;
  return `${value.toExponential(3)} AU`;
}

function formatParsecDistance(value: number | null) {
  if (value === null || value <= 0) return "정보 없음";
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

function getObjectType(
  target: SweObj,
  modelData: Record<string, unknown> | undefined,
  supplementalInfo: SupplementalObjectInfo | null
) {
  if (supplementalInfo?.objectType) return supplementalInfo.objectType;

  const types = modelData?.types;
  if (Array.isArray(types) && types.includes("*")) return "별";
  if (target.id?.startsWith("bsc-")) return "별";

  return target.id?.replace(/^NAME\s+/i, "") ?? "정보 없음";
}

function hasInfo(value: string) {
  return value !== "정보 없음";
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
}) {
  const fields: Array<[string, string]> = [];

  if (hasInfo(apparentMagnitude)) fields.push(["겉보기 등급", apparentMagnitude]);
  if (hasInfo(absoluteMagnitude)) fields.push(["절대 등급", absoluteMagnitude]);
  if (hasInfo(distanceText)) fields.push(["거리", distanceText]);
  if (hasInfo(distanceModulus)) fields.push(["거리계수", distanceModulus]);
  if (hasInfo(angularSize)) fields.push(["겉보기 크기", angularSize]);
  if (hasInfo(angularArea)) fields.push(["시면적", angularArea]);
  if (hasInfo(elongation)) fields.push(["태양 이각", elongation]);
  if (hasInfo(phaseAngle)) fields.push(["위상각", phaseAngle]);
  if (hasInfo(phase)) fields.push(["조명률", phase]);
  if (hasInfo(objectType)) fields.push(["분류", objectType]);

  return fields;
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
  const infoMap = readInfoMap(target, observer);
  const supplementalInfo = getSupplementalObjectInfo(target, label);
  const apparentMagnitude =
    getInfoNumber(target, observer, ["VMAG", "vmag", "magnitude"], infoMap) ??
    readNumber(modelData?.Vmag) ??
    readNumber(modelData?.vmag) ??
    readNumber(modelData?.Bmag);
  const distanceAu = getInfoNumber(
    target,
    observer,
    ["DISTANCE", "distance"],
    infoMap
  );
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
    distanceParsec !== null
      ? formatParsecDistance(distanceParsec)
      : formatDistance(distanceAu);
  const objectType = getObjectType(target, modelData, supplementalInfo);
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
  const angularSizeText = formatAngularSize(angularSizeRadians);
  const angularAreaText = formatAngularArea(angularSizeRadians);

  return {
    name: label,
    aliases: getAliases(target, label),
    altitude: formatDegrees(horizontal.latitude, true),
    azimuth: formatDegrees(horizontal.longitude),
    rightAscension: formatRightAscension(equatorial.longitude),
    declination: formatDegrees(equatorial.latitude, true),
    apparentMagnitude: apparentMagnitudeText,
    absoluteMagnitude: absoluteMagnitudeText,
    distance: distanceText,
    distanceModulus: distanceModulusText,
    objectType,
    phaseFraction,
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
    }),
  };
}
