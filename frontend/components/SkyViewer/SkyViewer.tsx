import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import styles from "./SkyViewer.module.css";
import {
  getCoreNumber,
  getObjectInfo,
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

const MAX_RENDERED_STAR_MAG = 5.8;

const SOLAR_SYSTEM_TARGETS = [
  "Sun",
  "Moon",
  "Mercury",
  "Venus",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
];

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
  atmosphere: ["atmosphere.visible"],
  ground: ["landscapes.visible"],
};

function toDateTimeLocalValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function getDefaultNightTime() {
  const date = new Date();
  date.setHours(22, 0, 0, 0);
  return toDateTimeLocalValue(date);
}

const DEFAULT_TIME = getDefaultNightTime();

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

function setObservationTime(engine: StellariumEngine, value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;

  const mjd = engine.date2MJD?.(timestamp);
  if (typeof mjd === "number") {
    engine._core_set_time?.(mjd);
    return true;
  }

  return false;
}

function applyNightSkyDefaults(engine: StellariumEngine) {
  trySetValue(engine, ["stars.visible"], true);
  trySetValue(engine, ["planets.visible"], true);
  trySetAllValues(engine, TOGGLE_PATHS.horizontalCoordinates, false);
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
    false
  );
  trySetValue(engine, ["stars.hints_visible"], false);
  trySetValue(engine, ["stars.labels_visible"], false);
  trySetValue(engine, ["planets.hints_visible"], true);
  trySetValue(engine, ["planets.hints_mag_offset"], 0);
  trySetValue(engine, ["dsos.hints_visible"], true);
  trySetValue(engine, ["dsos.hints_mag_offset"], -1);
  trySetValue(engine, ["pointer.visible"], true);
  trySetValue(engine, ["display_limit_mag"], 6.2);
  trySetValue(engine, ["star_relative_scale"], 1.62);
  trySetValue(engine, ["star_linear_scale"], 0.11);
  trySetValue(engine, ["bortle_index"], 1);
}

function normalizeSearchKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleCaseName(value: string) {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/\bHr\b/g, "HR")
    .replace(/\bHd\b/g, "HD");
}

function buildStarDesignations(star: BrightStar) {
  const names = new Set<string>();
  for (const name of star.names) {
    const normalized = name.trim();
    if (!normalized) continue;
    names.add(normalized);
    if (!/^HR\s/i.test(normalized) && !/^HD\s/i.test(normalized)) {
      names.add(`NAME ${titleCaseName(normalized)}`);
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
    const properName =
      star.names.find((name) => !/^HR\s/i.test(name) && !/^HD\s/i.test(name) && name !== star.name) ??
      star.name;
    const featuredName =
      star.names.find((name) => FEATURED_STAR_NAMES.has(normalizeSearchKey(name))) ??
      (FEATURED_STAR_NAMES.has(normalizeSearchKey(properName)) ? properName : null);
    const displayName = featuredName ? titleCaseName(featuredName) : titleCaseName(properName);

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
      short_name: featuredName ? displayName : "",
      types: ["*"],
    });

    if (!obj) continue;
    layer.add(obj);
    added += 1;

    const suggestionLabels = new Set<string>();
    for (const name of star.names) {
      const key = normalizeSearchKey(name);
      if (key) searchIndex.set(key, obj);
      if (key && !/^hd\s/i.test(name)) {
        suggestionLabels.add(titleCaseName(name.replace(/^NAME\s+/i, "")));
      }
    }
    searchIndex.set(normalizeSearchKey(String(star.hr)), obj);
    searchIndex.set(normalizeSearchKey(`HR ${star.hr}`), obj);
    if (star.hd) searchIndex.set(normalizeSearchKey(`HD ${star.hd}`), obj);

    clickTargets.push({
      key: normalizeSearchKey(star.name),
      label: titleCaseName(properName),
      obj,
      vector,
    });

    for (const label of suggestionLabels) {
      suggestions.push({
        key: normalizeSearchKey(label),
        label,
        obj,
        vector,
      });
    }

    if (added % 500 === 0) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  return added;
}

function findEngineObject(engine: StellariumEngine, term: string) {
  const candidates = [term, `NAME ${term}`, term.toUpperCase(), term.toLowerCase()];
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

function addSolarSystemClickTargets(
  engine: StellariumEngine,
  searchSuggestions: SearchSuggestion[],
  clickTargets: SearchSuggestion[]
) {
  for (const label of SOLAR_SYSTEM_TARGETS) {
    const obj = findEngineObject(engine, label);
    if (!obj) continue;

    const suggestion = {
      key: normalizeSearchKey(label),
      label,
      obj,
      vector: [],
      priority: 10,
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
      vector: [],
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
  const values = [
    trySetValue(engine, ["observer.latitude", "observer.lat"], latitude),
    trySetValue(engine, ["observer.longitude", "observer.lon"], longitude),
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

  if (target.name) return titleCaseName(target.name);
  if (target.id) return titleCaseName(target.id.replace(/^NAME\s+/i, ""));

  try {
    const designations = target.designations?.() ?? [];
    const name =
      designations.find((item) => /^NAME\s/i.test(item)) ??
      designations.find((item) => !/^HR\s/i.test(item) && !/^HD\s/i.test(item)) ??
      designations[0];

    if (name) return titleCaseName(name.replace(/^NAME\s+/i, ""));
  } catch {
    // Some engine-native objects do not expose designations safely.
  }

  return fallback;
}

function selectEngineTarget(engine: StellariumEngine, target: SweObj) {
  trySetValue(engine, ["selection"], target);
  trySetValue(engine, ["pointer.visible"], true);
}

function lockEngineTarget(
  engine: StellariumEngine,
  target: SweObj
) {
  selectEngineTarget(engine, target);
  engine.pointAndLock?.(target, 1.8);
}

export default function SkyViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<StellariumEngine | null>(null);
  const catalogSearchRef = useRef(new Map<string, SweObj>());
  const searchSuggestionsRef = useRef<SearchSuggestion[]>([]);
  const clickTargetsRef = useRef<SearchSuggestion[]>([]);
  const selectedTargetRef = useRef<SelectedTarget | null>(null);
  const dragStateRef = useRef({
    x: 0,
    y: 0,
  });
  const initialTimeRef = useRef(DEFAULT_TIME);
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [query, setQuery] = useState("Saturn");
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [selectedInfo, setSelectedInfo] = useState<ObjectInfo | null>(null);
  const [time, setTime] = useState(DEFAULT_TIME);
  const [locationQuery, setLocationQuery] = useState(SEOUL.name);
  const [observerLocation, setObserverLocationState] =
    useState<ObserverLocation>({
      latitude: SEOUL.latitude,
      longitude: SEOUL.longitude,
    });
  const [toggles, setToggles] = useState({
    horizontalCoordinates: false,
    atmosphere: false,
    ground: true,
  });

  const statusText = useMemo(() => {
    if (status === "ready") return "엔진 연결됨";
    if (status === "error") return "엔진 오류";
    return "불러오는 중";
  }, [status]);

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
          wasmFile: "/stellarium/stellarium-web-engine.wasm",
        });

        if (disposed) return;

        engineRef.current = engine;
        patchWasmMemoryHelpers(engine);
        setObservationTime(engine, initialTimeRef.current);
        setObserverLocation(
          engine,
          SEOUL.latitude,
          SEOUL.longitude,
          SEOUL.elevation
        );
        applyNightSkyDefaults(engine);
        setStatus("ready");

        await loadBrightStarCatalog(
          engine,
          catalogSearchRef.current,
          searchSuggestionsRef.current,
          clickTargetsRef.current
        );
        addSolarSystemClickTargets(
          engine,
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
    };
  }, []);

  function updateQuery(value: string) {
    setQuery(value);

    const key = normalizeSearchKey(value);
    if (!key || key.length < 2) {
      setSuggestions([]);
      return;
    }

    setSuggestions(
      searchSuggestionsRef.current
        .filter((item) => item.key.startsWith(key) || item.key.includes(key))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, 8)
    );
  }

  function focusTarget(target: SweObj, label: string, vector?: number[]) {
    const engine = engineRef.current;
    if (!engine) return;

    selectedTargetRef.current = { label, obj: target, vector };
    setQuery(label);
    setSelectedInfo(getObjectInfo(engine, target, label, vector));
    lockEngineTarget(engine, target);
    setSuggestions([]);
  }

  function selectTarget(target: SweObj, label: string, vector?: number[]) {
    const engine = engineRef.current;
    if (!engine) return;

    selectedTargetRef.current = { label, obj: target, vector };
    setQuery(label);
    setSelectedInfo(getObjectInfo(engine, target, label, vector));
    selectEngineTarget(engine, target);
    setSuggestions([]);
  }

  function handleCanvasMouseDown(event: MouseEvent<HTMLCanvasElement>) {
    dragStateRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }

  function handleCanvasClick(event: MouseEvent<HTMLCanvasElement>) {
    const dragDistance = Math.hypot(
      event.clientX - dragStateRef.current.x,
      event.clientY - dragStateRef.current.y
    );

    if (dragDistance > 6) {
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
      const engineTarget = findEngineObject(engine, term);
      const normalizedTerm = normalizeSearchKey(term);
      const exactSuggestion =
        suggestions.find((item) => item.key === normalizedTerm) ??
        searchSuggestionsRef.current.find((item) => item.key === normalizedTerm);
      const target =
        engineTarget ??
        exactSuggestion?.obj ??
        catalogSearchRef.current.get(normalizeSearchKey(term)) ??
        suggestions[0]?.obj ??
        null;
      if (!target) {
        return;
      }

      focusTarget(
        target,
        exactSuggestion?.label ?? suggestions[0]?.label ?? term,
        engineTarget ? undefined : exactSuggestion?.vector ?? suggestions[0]?.vector
      );
    } catch (error) {
      console.error(error);
    }
  }

  function handleTimeChange(value: string) {
    setTime(value);
    const engine = engineRef.current;
    if (!engine) return;

    if (setObservationTime(engine, value)) {
      const selected = selectedTargetRef.current;
      if (selected) {
        setSelectedInfo(
          getObjectInfo(engine, selected.obj, selected.label, selected.vector)
        );
      }
    }
  }

  function handleToggle(name: keyof typeof TOGGLE_PATHS) {
    const engine = engineRef.current;
    const nextValue = !toggles[name];
    setToggles((current) => ({ ...current, [name]: nextValue }));

    if (!engine) return;

    trySetAllValues(engine, TOGGLE_PATHS[name], nextValue);
  }

  return (
    <main className={styles.shell}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onMouseDown={handleCanvasMouseDown}
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
                      focusTarget(item.obj, item.label, item.vector);
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

        <label className={styles.field}>
          <span>시간</span>
          <input
            type="datetime-local"
            value={time}
            onChange={(event) => handleTimeChange(event.target.value)}
            disabled={status !== "ready"}
          />
        </label>

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

          const selected = selectedTargetRef.current;
          if (selected) {
            setSelectedInfo(
              getObjectInfo(engine, selected.obj, selected.label, selected.vector)
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
        </div>
      </section>
      <ObjectInfoPanel info={selectedInfo} />
    </main>
  );
}
