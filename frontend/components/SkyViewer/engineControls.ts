import { loadWesternConstellationGeoJson } from "./skyCatalog";
import type { StellariumEngine, StellariumFactory, SweObj } from "./types";

declare global {
  interface Window {
    StelWebEngine?: StellariumFactory;
  }
}

export const DEG_TO_RAD = Math.PI / 180;
const DSS_SURVEY_URL = "https://alasky.cds.unistra.fr/DSS/DSSColor";

export const TOGGLE_PATHS = {
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

let stellariumScriptPromise: Promise<void> | null = null;

export function loadStellariumScript() {
  if (window.StelWebEngine) {
    return Promise.resolve();
  }

  if (stellariumScriptPromise) {
    return stellariumScriptPromise;
  }

  stellariumScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      'script[data-stellarium="1"]'
    ) as HTMLScriptElement | null;

    const script = existing ?? document.createElement("script");
    script.dataset.stellarium = "1";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        stellariumScriptPromise = null;
        reject(new Error("Stellarium engine failed to load"));
      },
      { once: true }
    );

    if (!existing) {
      script.src = "/stellarium/stellarium-web-engine.js";
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return stellariumScriptPromise;
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

export function trySetValue(
  engine: StellariumEngine,
  paths: string[],
  value: unknown
) {
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

export function trySetAllValues(
  engine: StellariumEngine,
  paths: string[],
  value: unknown
) {
  return paths
    .map((path) => trySetValue(engine, [path], value))
    .filter((path): path is string => Boolean(path));
}

export function patchWasmMemoryHelpers(engine: StellariumEngine) {
  if (!engine._free && engine.asm?.Ga) {
    engine._free = (ptr: number) => {
      engine.asm?.Ga(Number(ptr) || 0);
    };
  }

  if (!engine._malloc && engine.asm?.Wa) {
    engine._malloc = (size: number) => engine.asm?.Wa(size) ?? 0;
  }
}

export function getEngineModule(engine: StellariumEngine, name: string) {
  return (
    (engine.core?.[name] as SweObj | undefined) ??
    engine.getModule?.(name) ??
    engine.getModule?.(`core.${name}`) ??
    undefined
  );
}

export function addDataSource(
  module: SweObj | undefined,
  url: string,
  key: string
) {
  try {
    module?.addDataSource?.({ url, key });
  } catch (error) {
    console.warn(`Could not add Stellarium data source: ${key}`, error);
  }
}

export function addOfficialPlanetDataSources(engine: StellariumEngine) {
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

  for (const planet of [
    "mercury",
    "venus",
    "mars",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
  ]) {
    addDataSource(planets, `https://data.stellarium.org/surveys/${planet}`, planet);
  }

  trySetValue(engine, ["skycultures.current"], skycultureId);
  trySetValue(engine, ["skycultures.current_id"], skycultureId);
  trySetValue(engine, ["skycultures.current_skyculture"], skycultureId);
  trySetValue(engine, ["skycultures.skyculture"], skycultureId);
  trySetValue(engine, ["constellations.current"], skycultureId);
  trySetValue(engine, ["constellations.current_id"], skycultureId);
  skycultures?.update?.();
  constellations?.update?.();
}

export function ensureDssDataSource(
  engine: StellariumEngine,
  loadedSurveys: Set<string>
) {
  if (loadedSurveys.has("dss")) return true;

  const dss = getEngineModule(engine, "dss");
  if (!dss) return false;

  addDataSource(dss, DSS_SURVEY_URL, "dss");
  loadedSurveys.add("dss");
  dss.update?.();
  engine._core_update?.();
  return true;
}

export function configureEngineLandscape(engine: StellariumEngine) {
  const landscapes = getEngineModule(engine, "landscapes");
  if (!landscapes) return;

  addDataSource(landscapes, "/stellarium/landscapes/zero", "zero");
  trySetValue(engine, ["landscapes.current_id"], "zero");
  trySetValue(engine, ["landscapes.visible"], true);
  trySetValue(engine, ["landscapes.fog_visible"], false);
  landscapes.update?.();
}

export function setInitialHorizonView(engine: StellariumEngine) {
  const altitude = 18 * DEG_TO_RAD;
  const lookVector: [number, number, number] = [
    0,
    Math.cos(altitude),
    Math.sin(altitude),
  ];
  engine.lookAt?.(lookVector, 0);
}

export async function createConstellationLineObjects(
  engine: StellariumEngine
) {
  const data = await loadWesternConstellationGeoJson();
  const objects: SweObj[] = [];
  const groupedFeatures = new Map<string, (typeof data.features)>();

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

export function setConstellationLineObjectVisible(
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

export function updateObserverFrame(
  engine: StellariumEngine,
  fast = false
) {
  const observer = engine.observer ?? (engine.core?.observer as SweObj | undefined);
  if (!observer) return;

  try {
    engine._observer_update?.(observer.v, fast);
  } catch {
    observer.update?.();
  }
}

export function setObservationTime(
  engine: StellariumEngine,
  value: string | Date
) {
  const timestamp =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;

  // Unix time -> Modified Julian Date for Stellarium's astronomical core.
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

    updateObserverFrame(engine, false);
    engine._core_update?.();
    return true;
  }

  return false;
}

export function applyNightSkyDefaults(engine: StellariumEngine) {
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
  trySetValue(engine, ["dsos.visible"], false);
  trySetValue(engine, ["planets.hints_visible"], true);
  trySetValue(engine, ["planets.labels_visible"], true);
  trySetValue(engine, ["planets.hints_mag_offset"], 0);
  trySetValue(engine, ["dsos.hints_visible"], false);
  trySetValue(engine, ["dsos.hints_mag_offset"], -1);
  trySetValue(engine, ["dss.visible"], false);
  trySetValue(engine, ["pointer.visible"], true);
  trySetValue(engine, ["display_limit_mag"], 5.5);
  trySetValue(engine, ["star_relative_scale"], 1.62);
  trySetValue(engine, ["star_linear_scale"], 0.11);
  trySetValue(engine, ["bortle_index"], 1);
}

export function applyDeepSkyMode(engine: StellariumEngine, enabled: boolean) {
  const dss = getEngineModule(engine, "dss");
  trySetValue(engine, ["dsos.visible"], enabled);
  trySetValue(engine, ["dsos.hints_visible"], enabled);
  trySetValue(engine, ["dsos.hints_mag_offset"], enabled ? 3 : -1);
  trySetValue(engine, ["dss.visible"], enabled);
  trySetValue(engine, ["display_limit_mag"], enabled ? 16 : 5.5);
  trySetValue(engine, ["star_relative_scale"], enabled ? 1.25 : 1.62);
  trySetValue(engine, ["star_linear_scale"], enabled ? 0.08 : 0.11);
  dss?.update?.();
  engine._core_update?.();
}

export function setObserverLocation(
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
