export type ObservationDifficulty = 1 | 2 | 3 | 4 | 5;

export type DifficultyObjectType =
  | "star"
  | "galaxy"
  | "globular cluster"
  | "open cluster"
  | "nebula"
  | "planetary nebula"
  | "planet"
  | "unknown";

export type DifficultyObjectData = {
  type: DifficultyObjectType | string;
  magnitude: number | null;
  altitude: number;
  majorAxisArcmin?: number | null;
  minorAxisArcmin?: number | null;
  emissionNebula?: boolean;
  daylight?: boolean;
  daylightExempt?: boolean;
};

export type DifficultyResult = {
  difficulty: ObservationDifficulty;
  description: string;
  skyBrightness: number;
  telescopeLimitMagnitude: number;
  objectSurfaceBrightness: number | null;
};

export type SkyBrightnessDetails = {
  sqm: number;
  seeingArcsec: number | null;
  source?: string | null;
};

export type SkyBrightnessDirection = {
  altitude?: number | null;
  azimuth?: number | null;
};

const DEFAULT_TELESCOPE_APERTURE_MM = 100;
const DEFAULT_SKY_BRIGHTNESS = 21.3;
const DIFFICULTY_THRESHOLD_EPSILON = 1e-6;

const BORTLE_TO_SQM: Record<number, number> = {
  1: 22.0,
  2: 21.7,
  3: 21.3,
  4: 20.8,
  5: 20.1,
  6: 19.4,
  7: 18.7,
  8: 18.0,
  9: 17.4,
};

let skyBrightnessApiUnavailable = false;
const SKY_BRIGHTNESS_BASE_URL =
  process.env.NEXT_PUBLIC_SKY_BRIGHTNESS_BASE_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:8000/api/difficulty"
    : "https://jmgj-backend.onrender.com/api/difficulty");
const SKY_BRIGHTNESS_CLIENT_CACHE_MS = 5 * 60 * 1000;
const skyBrightnessClientCache = new Map<
  string,
  {
    expiresAt: number;
    value?: SkyBrightnessDetails;
    promise?: Promise<SkyBrightnessDetails>;
  }
>();

function finiteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAperture(apertureMm: number) {
  const aperture = finiteNumber(apertureMm);
  return aperture && aperture > 0 ? aperture : DEFAULT_TELESCOPE_APERTURE_MM;
}

function normalizeSkyBrightness(skyBrightness: number) {
  const sqm = finiteNumber(skyBrightness);
  return sqm ? clamp(sqm, 8, 23) : DEFAULT_SKY_BRIGHTNESS;
}

function normalizeType(type: string) {
  return type.toLowerCase().replace(/[_-]+/g, " ").trim();
}

function isStarLike(type: string) {
  const normalized = normalizeType(type);
  return normalized === "planet" || normalized === "star" || normalized === "\uBCC4";
}

function isExtendedObject(type: string) {
  return !isStarLike(type);
}

function needsSpecialEquipment(objectData: DifficultyObjectData) {
  const type = normalizeType(objectData.type);
  return (
    Boolean(objectData.emissionNebula) ||
    type.includes("emission") ||
    type.includes("h ii") ||
    type.includes("h-alpha") ||
    type.includes("narrowband") ||
    type.includes("방출") ||
    type.includes("h ii")
  );
}

/**
 * Calculates the telescope limiting magnitude from aperture.
 *
 * Report formula:
 * `m_lim = 1.78 + 5 * log10(D)`, where `D` is telescope aperture in mm.
 * Invalid aperture values fall back to 100 mm to prevent NaN propagation.
 */
export function calculateTelescopeLimitMagnitude(telescopeAperture: number) {
  const aperture = normalizeAperture(telescopeAperture);
  return 1.78 + 5 * Math.log10(aperture);
}

/**
 * Calculates deep-sky surface brightness in mag/arcsec².
 *
 * Report formula:
 * `mu_obj = m + 2.5 * log10(A)`.
 *
 * When both major/minor axes are available, the visible area is treated as an
 * ellipse: `A = π * (major / 2) * (minor / 2)`. OpenNGC gives axes in arcmin,
 * so they are converted to arcsec before calculating area.
 */
export function calculateObjectSurfaceBrightness(
  magnitude: number,
  majorAxisArcmin?: number | null,
  minorAxisArcmin?: number | null
) {
  const mag = finiteNumber(magnitude);
  const majorArcmin = finiteNumber(majorAxisArcmin);
  const minorArcmin = finiteNumber(minorAxisArcmin) ?? majorArcmin;

  if (mag === null || majorArcmin === null || minorArcmin === null) {
    return null;
  }

  if (majorArcmin <= 0 || minorArcmin <= 0) return null;

  const majorArcsec = majorArcmin * 60;
  const minorArcsec = minorArcmin * 60;
  const areaArcsecSquared = Math.PI * (majorArcsec / 2) * (minorArcsec / 2);

  if (!Number.isFinite(areaArcsecSquared) || areaArcsecSquared <= 0) {
    return null;
  }

  return mag + 2.5 * Math.log10(areaArcsecSquared);
}


function passesDifficultyThreshold(value: number, threshold: number) {
  return value <= threshold + DIFFICULTY_THRESHOLD_EPSILON;
}

function passesVisualTelescopeThreshold({
  objectData,
  magnitude,
  observableMetric,
  muSky,
  telescopeLimitMagnitude,
}: {
  objectData: DifficultyObjectData;
  magnitude: number | null;
  observableMetric: number | null;
  muSky: number;
  telescopeLimitMagnitude: number;
}) {
  if (observableMetric === null) return false;

  if (!isExtendedObject(objectData.type)) {
    return passesDifficultyThreshold(
      observableMetric,
      muSky + telescopeLimitMagnitude - 22
    );
  }

  if (
    magnitude === null ||
    !passesDifficultyThreshold(magnitude, telescopeLimitMagnitude)
  ) {
    return false;
  }

  // Extended objects are judged by surface brightness for contrast, but visual
  // telescope reach still depends on the object's integrated magnitude. Without
  // this guard, bright clusters and large Messier objects almost never reach
  // difficulty 2 because their arcsec² surface brightness is numerically faint.
  return passesDifficultyThreshold(observableMetric, muSky + 6.5);
}
function difficultyDescription(difficulty: ObservationDifficulty): string {
  if (difficulty === 1) return "\uC548\uC2DC \uAD00\uCE21 \uAC00\uB2A5";
  if (difficulty === 2) return "\uB9DD\uC6D0\uACBD \uC548\uC2DC \uAD00\uCE21 \uAC00\uB2A5";
  if (difficulty === 3) return "\uB9DD\uC6D0\uACBD \uCD2C\uC601\uC73C\uB85C \uAD00\uCE21 \uAC00\uB2A5";
  if (difficulty === 4) return "\uD2B9\uC218 \uC7A5\uBE44 \uD544\uC694";
  if (difficulty === 5) return "\uAD00\uCE21 \uBD88\uAC00";
  switch (difficulty) {
    default:
      return "\uAD00\uCE21 \uBD88\uAC00";
    case 1:
      return "육안 관측 가능";
    case 2:
      return "망원경 안시 관측 가능";
    case 3:
      return "망원경 촬영으로 관측 가능";
    case 4:
      return "특수 장비 필요";
    case 5:
      return "관측 불가";
  }
}

/**
 * Classifies observation difficulty using the report's five-level criteria.
 *
 * Order is intentionally strict:
 * 1. Objects below the horizon are impossible (`difficulty 5`).
 * 2. Emission/narrowband/H-alpha targets require special equipment
 *    (`difficulty 4`).
 * 3. Stars use apparent magnitude directly; extended deep-sky objects use
 *    surface brightness from apparent magnitude and angular area.
 * 4. If neither naked-eye nor visual telescope thresholds pass, the target is
 *    treated as photographically observable (`difficulty 3`).
 */
export function calculateDifficulty(
  objectData: DifficultyObjectData,
  skyBrightness: number,
  telescopeAperture: number
): ObservationDifficulty {
  return calculateDifficultyDetails(
    objectData,
    skyBrightness,
    telescopeAperture
  ).difficulty;
}

export function calculateDifficultyDetails(
  objectData: DifficultyObjectData,
  skyBrightness: number,
  telescopeAperture: number
): DifficultyResult {
  const altitude = finiteNumber(objectData.altitude);
  const muSky = normalizeSkyBrightness(skyBrightness);
  const telescopeLimitMagnitude =
    calculateTelescopeLimitMagnitude(telescopeAperture);
  const magnitude = finiteNumber(objectData.magnitude);
  const objectSurfaceBrightness = isStarLike(objectData.type)
    ? null
    : magnitude === null
      ? null
      : calculateObjectSurfaceBrightness(
          magnitude,
          objectData.majorAxisArcmin,
          objectData.minorAxisArcmin
        );

  let difficulty: ObservationDifficulty;
  const observableMetric = isStarLike(objectData.type)
    ? magnitude
    : objectSurfaceBrightness;

  if (objectData.daylight && !objectData.daylightExempt) {
    difficulty = 5;
  } else if (altitude === null || altitude <= 0) {
    difficulty = 5;
  } else if (needsSpecialEquipment(objectData)) {
    difficulty = 4;
  } else if (
    observableMetric !== null &&
    passesDifficultyThreshold(observableMetric, muSky - 15.5)
  ) {
    difficulty = 1;
  } else if (
    passesVisualTelescopeThreshold({
      objectData,
      magnitude,
      observableMetric,
      muSky,
      telescopeLimitMagnitude,
    })
  ) {
    difficulty = 2;
  } else {
    difficulty = 3;
  }

  return {
    difficulty,
    description: difficultyDescription(difficulty),
    skyBrightness: muSky,
    telescopeLimitMagnitude,
    objectSurfaceBrightness,
  };
}

function estimateBortleFromLocation(latitude: number, longitude: number) {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat === null || lon === null) return 3;

  const nearSeoul =
    Math.abs(lat - 37.5665) < 0.8 && Math.abs(lon - 126.978) < 0.9;
  if (nearSeoul) return 8;

  return 3;
}

function sqmFromBortle(bortle: number) {
  const rounded = clamp(Math.round(bortle), 1, 9);
  return BORTLE_TO_SQM[rounded] ?? DEFAULT_SKY_BRIGHTNESS;
}

/**
 * Resolves sky brightness as SQM-like `mag/arcsec²`.
 *
 * The project does not currently ship a stable public light-pollution API key.
 * This utility therefore first attempts local/backend endpoints that future PRs
 * can provide, then safely falls back to a Bortle-derived SQM estimate. The
 * fallback keeps the difficulty calculation deterministic and prevents network
 * failures from breaking the sky viewer.
 */
export async function getSkyBrightness(
  latitude: number,
  longitude: number,
  datetime: Date
): Promise<number> {
  return getSkyBrightnessDetails(latitude, longitude, datetime).then(
    (details) => details.sqm
  );
}

export async function getSkyBrightnessDetails(
  latitude: number,
  longitude: number,
  datetime: Date,
  direction?: SkyBrightnessDirection
): Promise<SkyBrightnessDetails> {
  const fallback = sqmFromBortle(estimateBortleFromLocation(latitude, longitude));
  const fallbackDetails: SkyBrightnessDetails = {
    sqm: fallback,
    seeingArcsec: null,
    source: "bortle-fallback",
  };
  if (skyBrightnessApiUnavailable) return fallbackDetails;

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    datetime: datetime.toISOString(),
  });
  const altitude = finiteNumber(direction?.altitude);
  const azimuth = finiteNumber(direction?.azimuth);
  if (altitude !== null && azimuth !== null) {
    params.set("altitude", String(altitude));
    params.set("azimuth", String(((azimuth % 360) + 360) % 360));
  }

  for (const endpoint of [`${SKY_BRIGHTNESS_BASE_URL}/sky-brightness?${params}`]) {
    const now = Date.now();
    const cached = skyBrightnessClientCache.get(endpoint);
    if (cached && cached.expiresAt > now) {
      if (cached.value) return cached.value;
      if (cached.promise) return cached.promise;
    }

    const request = fetch(endpoint)
      .then(async (response) => {
        if (response.status === 404) {
          skyBrightnessApiUnavailable = true;
          return fallbackDetails;
        }
        if (!response.ok) return fallbackDetails;

        const payload = (await response.json()) as {
          sqm?: unknown;
          skyBrightness?: unknown;
          muSky?: unknown;
          bortle?: unknown;
          seeingArcsec?: unknown;
          source?: unknown;
        };
        const sqm =
          finiteNumber(Number(payload.sqm)) ??
          finiteNumber(Number(payload.skyBrightness)) ??
          finiteNumber(Number(payload.muSky));
        if (sqm !== null) {
          return {
            sqm: normalizeSkyBrightness(sqm),
            seeingArcsec: finiteNumber(Number(payload.seeingArcsec)),
            source: typeof payload.source === "string" ? payload.source : null,
          };
        }

        const bortle = finiteNumber(Number(payload.bortle));
        if (bortle !== null) {
          return {
            sqm: sqmFromBortle(bortle),
            seeingArcsec: finiteNumber(Number(payload.seeingArcsec)),
            source: typeof payload.source === "string" ? payload.source : null,
          };
        }

        return fallbackDetails;
      })
      .catch(() => fallbackDetails);

    skyBrightnessClientCache.set(endpoint, {
      expiresAt: now + SKY_BRIGHTNESS_CLIENT_CACHE_MS,
      promise: request,
    });

    try {
      const details = await request;
      skyBrightnessClientCache.set(endpoint, {
        expiresAt: Date.now() + SKY_BRIGHTNESS_CLIENT_CACHE_MS,
        value: details,
      });
      return details;
    } catch {
      // Network/API failures are expected until a real SQM or pollution API is configured.
    }
  }

  return fallbackDetails;
}

export function getFallbackSkyBrightness(latitude: number, longitude: number) {
  return sqmFromBortle(estimateBortleFromLocation(latitude, longitude));
}
