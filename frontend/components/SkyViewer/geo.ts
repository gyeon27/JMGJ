import type { GeocodeResult, ObserverLocation } from "./types";

const GEOCODE_TIMEOUT_MS = 5500;
const REVERSE_GEOCODE_TIMEOUT_MS = 3500;
const GEOCODE_CACHE_MS = 10 * 60 * 1000;
const GEOCODE_BASE_URL =
  process.env.NEXT_PUBLIC_GEOCODE_BASE_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:8000/api/geocode"
    : "https://jmgj-backend.onrender.com/api/geocode");
const GEOCODE_RENDER_URL = "https://jmgj-backend.onrender.com/api/geocode";

const GEOCODE_URLS = Array.from(
  new Set(
    [
      GEOCODE_BASE_URL,
      process.env.NODE_ENV === "development" ? GEOCODE_RENDER_URL : null,
    ].filter((url): url is string => Boolean(url))
  )
);

const geocodeCache = new Map<
  string,
  { expiresAt: number; result: GeocodeResult | null }
>();
const reverseGeocodeCache = new Map<
  string,
  { expiresAt: number; result: string | null }
>();

type GeocodeRequestResult = {
  reached: boolean;
  result: GeocodeResult | null;
};

type ReverseGeocodeRequestResult = {
  reached: boolean;
  result: string | null;
};

function getCached<T>(
  cache: Map<string, { expiresAt: number; result: T }>,
  key: string
) {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return cached.result;
}

function setCached<T>(
  cache: Map<string, { expiresAt: number; result: T }>,
  key: string,
  result: T
) {
  cache.set(key, {
    expiresAt: Date.now() + GEOCODE_CACHE_MS,
    result,
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function firstResolved<T>(
  tasks: Array<Promise<{ reached: boolean; result: T | null }>>
) {
  return new Promise<{ reached: boolean; result: T | null }>((resolve) => {
    let pending = tasks.length;
    let settled = false;

    for (const task of tasks) {
      task
        .then((result) => {
          if (settled) return;
          if (result.result || result.reached) {
            settled = true;
            resolve(result);
            return;
        }

          pending -= 1;
          if (pending === 0) resolve({ reached: false, result: null });
        })
        .catch(() => {
          pending -= 1;
          if (!settled && pending === 0) {
            resolve({ reached: false, result: null });
          }
        });
    }
  });
}

export async function geocodeLocation(
  query: string
): Promise<GeocodeResult | null> {
  const key = query.trim().toLowerCase();
  const cached = getCached(geocodeCache, key);
  if (cached !== undefined) return cached;

  const response = await firstResolved(
    GEOCODE_URLS.map((baseUrl) => requestGeocodeLocation(baseUrl, query))
  );
  setCached(geocodeCache, key, response.result);
  return response.result;
}

async function requestGeocodeLocation(
  baseUrl: string,
  query: string
): Promise<GeocodeRequestResult> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}?query=${encodeURIComponent(query)}`,
      GEOCODE_TIMEOUT_MS
    );
    if (!response.ok) return { reached: true, result: null };

    const results = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
      name?: string;
    }>;
    const first = results[0];
    if (!first) return { reached: true, result: null };

    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (![latitude, longitude].every(Number.isFinite)) {
      return { reached: true, result: null };
    }

    return {
      reached: true,
      result: {
        latitude,
        longitude,
        name: first.display_name ?? first.name ?? query,
      },
    };
  } catch {
    return { reached: false, result: null };
  }
}

export async function reverseGeocodeLocation(location: ObserverLocation) {
  const key = `${location.latitude.toFixed(5)},${location.longitude.toFixed(5)}`;
  const cached = getCached(reverseGeocodeCache, key);
  if (cached !== undefined) return cached;

  const response = await firstResolved(
    GEOCODE_URLS.map((baseUrl) =>
      requestReverseGeocodeLocation(baseUrl, location)
    )
  );
  setCached(reverseGeocodeCache, key, response.result);
  return response.result;
}

async function requestReverseGeocodeLocation(
  baseUrl: string,
  location: ObserverLocation
): Promise<ReverseGeocodeRequestResult> {
  const params = new URLSearchParams({
    lat: String(location.latitude),
    lon: String(location.longitude),
  });
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/reverse?${params.toString()}`,
      REVERSE_GEOCODE_TIMEOUT_MS
    );
    if (!response.ok) return { reached: true, result: null };

    const result = (await response.json()) as {
      display_name?: string;
      name?: string;
    };

    return { reached: true, result: result.display_name ?? result.name ?? null };
  } catch {
    return { reached: false, result: null };
  }
}
