import type { GeocodeResult, ObserverLocation } from "./types";

const GEOCODE_BASE_URL =
  process.env.NEXT_PUBLIC_GEOCODE_BASE_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:8000/api/geocode"
    : "https://jmgj-backend.onrender.com/api/geocode");

export async function geocodeLocation(
  query: string
): Promise<GeocodeResult | null> {
  const response = await fetch(
    `${GEOCODE_BASE_URL}?query=${encodeURIComponent(query)}`
  );
  if (!response.ok) return null;

  const results = (await response.json()) as Array<{
    lat?: string;
    lon?: string;
    display_name?: string;
    name?: string;
  }>;
  const first = results[0];
  if (!first) return null;

  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (![latitude, longitude].every(Number.isFinite)) return null;

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
