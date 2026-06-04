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
import {
  DEG_TO_RAD,
  TOGGLE_PATHS,
  addDataSource,
  addOfficialPlanetDataSources,
  applyDeepSkyMode,
  applyNightSkyDefaults,
  configureEngineLandscape,
  createConstellationLineObjects,
  ensureDssDataSource,
  getEngineModule,
  loadStellariumScript,
  patchWasmMemoryHelpers,
  setConstellationLineObjectVisible,
  setInitialHorizonView,
  setObservationTime,
  setObserverLocation,
  trySetAllValues,
  trySetValue,
} from "./engineControls";
import { ObjectInfoPanel } from "./ObjectInfoPanel";
import { SkyViewerControls } from "./SkyViewerControls";
import { SkyViewerToolbar } from "./SkyViewerToolbar";
import type { DisplayToggleName } from "./SkyViewerToolbar";
import {
  FEATURED_STAR_NAMES,
  getDeepSkySearchCandidates,
  getPreferredStarDisplayName,
  loadBrightStarCatalog,
  normalizeSearchKey,
  titleCaseName,
} from "./skyCatalog";
import {
  DEFAULT_TIME,
  WEEKDAY_LABELS,
  formatDisplayDateTime,
  getCalendarDays,
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
} from "./timeUtils";
import type {
  EngineStatus,
  ObjectInfo,
  ObserverLocation,
  SearchSuggestion,
  SelectedTarget,
  StellariumEngine,
  SweObj,
  TelescopeSettings,
} from "./types";

const SEOUL = {
  name: "서울",
  latitude: 37.5665,
  longitude: 126.978,
  elevation: 0,
};

const TIME_DISPLAY_UPDATE_INTERVAL_MS = 250;

const TIME_SPEEDS = [
  { label: "실시간", multiplier: 1 },
  { label: "초 12배", multiplier: 12 },
  { label: "초 60배", multiplier: 60 },
  { label: "분 12배", multiplier: 60 * 12 },
  { label: "분 60배", multiplier: 60 * 60 },
  { label: "시 12배", multiplier: 60 * 60 * 12 },
];

const DEFAULT_TELESCOPE_SETTINGS: TelescopeSettings = {
  focalLengthMm: 1000,
  apertureMm: 100,
};

const DEEP_SKY_IMAGE_FOV = 8 * DEG_TO_RAD;

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

const PLANET_SURVEY_KEYS = new Map(
  [
    ["Mercury", "mercury"],
    ["Venus", "venus"],
    ["Mars", "mars"],
    ["Jupiter", "jupiter"],
    ["Saturn", "saturn"],
    ["Uranus", "uranus"],
    ["Neptune", "neptune"],
  ].map(([name, key]) => [normalizeSearchKey(name), key])
);

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

function addPlanetSurveyIfNeeded(
  engine: StellariumEngine,
  label: string,
  loadedSurveys: Set<string>
) {
  const surveyKey = PLANET_SURVEY_KEYS.get(normalizeSearchKey(label));
  if (!surveyKey || loadedSurveys.has(surveyKey)) return;

  const planets = engine.core?.planets as SweObj | undefined;
  addDataSource(
    planets,
    `https://data.stellarium.org/surveys/${surveyKey}`,
    surveyKey
  );
  loadedSurveys.add(surveyKey);
  planets?.update?.();
  engine._core_update?.();
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

function setEngineSelection(engine: StellariumEngine, target: SweObj) {
  try {
    if (engine.core) {
      engine.core.selection = target;
    }
  } catch {
    // Some engine builds expose selection through setValue only.
  }

  trySetValue(engine, ["selection", "core.selection"], target);
  trySetValue(engine, ["pointer.visible"], true);
  (engine.core as SweObj | undefined)?.update?.();
  engine._core_update?.();
}

function clearEngineSelection(engine: StellariumEngine) {
  try {
    if (engine.core) {
      engine.core.selection = null;
    }
  } catch {
    // Some engine builds expose selection through setValue only.
  }

  trySetValue(engine, ["selection", "core.selection", "lock"], null);
  trySetValue(engine, ["pointer.visible"], false);
  (engine.core as SweObj | undefined)?.update?.();
  engine._core_update?.();
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

function getObjectSearchKeys(target: SweObj) {
  const keys = new Set<string>();

  try {
    for (const designation of target.designations?.() ?? []) {
      const key = normalizeSearchKey(designation.replace(/^NAME\s+/i, ""));
      if (key) keys.add(key);
    }
  } catch {
    // Some engine-native objects do not expose designations safely.
  }

  for (const value of [target.name, target.id]) {
    if (!value) continue;
    const key = normalizeSearchKey(value.replace(/^NAME\s+/i, ""));
    if (key) keys.add(key);
  }

  return keys;
}

function findMatchingSearchTarget(
  target: SweObj,
  searchTargets: SearchSuggestion[]
) {
  const directMatch = searchTargets.find((item) => item.obj.v === target.v);
  if (directMatch) return directMatch;

  const keys = getObjectSearchKeys(target);
  if (keys.size === 0) return null;

  return (
    searchTargets.find((item) => keys.has(item.key)) ??
    searchTargets.find((item) => keys.has(normalizeSearchKey(item.label))) ??
    null
  );
}

function dedupeSearchSuggestions(items: SearchSuggestion[]) {
  const seen = new Set<string>();
  const unique: SearchSuggestion[] = [];

  for (const item of items) {
    const normalizedLabel = normalizeSearchKey(item.label);
    const signature = `${normalizedLabel}:${item.obj.v}`;
    if (seen.has(signature)) continue;

    seen.add(signature);
    unique.push(item);
  }

  return unique;
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
  const loadedPlanetSurveysRef = useRef(new Set<string>());
  const simulatedTimeRef = useRef(new Date());
  const lastTickRef = useRef<number | null>(null);
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
  const [timeDirection, setTimeDirection] = useState<1 | -1>(1);
  const [telescopeSettings, setTelescopeSettings] =
    useState<TelescopeSettings>(DEFAULT_TELESCOPE_SETTINGS);
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
  const [isControlPanelOpen, setIsControlPanelOpen] = useState(false);

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
    const catalogSearch = catalogSearchRef.current;
    const loadedPlanetSurveys = loadedPlanetSurveysRef.current;

    async function start() {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;

        await loadStellariumScript();
        if (disposed || !canvas.isConnected) return;

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
        catalogSearch.clear();
        searchSuggestionsRef.current = [];
        clickTargetsRef.current = [];
        patchWasmMemoryHelpers(engine);
        addOfficialPlanetDataSources(engine);
        configureEngineLandscape(engine);
        setObserverLocation(
          engine,
          SEOUL.latitude,
          SEOUL.longitude,
          SEOUL.elevation
        );
        setObservationTime(engine, initialTimeRef.current);
        applyNightSkyDefaults(engine);
        applyDeepSkyMode(engine, false);
        setInitialHorizonView(engine);
        addSolarSystemTargets(
          engine,
          searchSuggestionsRef.current,
          clickTargetsRef.current
        );
        setStatus("ready");

        await loadBrightStarCatalog(
          engine,
          catalogSearch,
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
      catalogSearch.clear();
      searchSuggestionsRef.current = [];
      clickTargetsRef.current = [];
      constellationLineObjectsRef.current = [];
      isConstellationLineObjectAddedRef.current = false;
      loadedPlanetSurveys.clear();
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
      dedupeSearchSuggestions(
        [...deepSkySuggestions, ...searchSuggestionsRef.current].filter((item) =>
          deepSkyOnly
            ? item.key === key || item.key.startsWith(key)
            : item.key.startsWith(key) || item.key.includes(key)
        )
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
    setEngineSelection(engine, target);
    trackingTargetRef.current = null;
    if (trackingActivationTimeoutRef.current !== null) {
      window.clearTimeout(trackingActivationTimeoutRef.current);
    }
    addPlanetSurveyIfNeeded(engine, label, loadedPlanetSurveysRef.current);
    setQuery(label);
    setSelectedInfo(
      getSafeObjectInfo(engine, target, label, vector)
    );
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
    setEngineSelection(engine, target);
    cancelTargetTracking();
    addPlanetSurveyIfNeeded(engine, label, loadedPlanetSurveysRef.current);
    setQuery(label);
    setSelectedInfo(
      getSafeObjectInfo(engine, target, label, vector)
    );
    setSuggestions([]);
  }

  function clearSelectedTarget() {
    const engine = engineRef.current;
    selectedTargetRef.current = null;
    setSelectedInfo(null);
    cancelTargetTracking();
    setSuggestions([]);
    if (engine) {
      clearEngineSelection(engine);
    }
  }

  function focusSuggestion(item: SearchSuggestion) {
    const engine = engineRef.current;
    if (!engine) return;
    setQuery(item.label);
    focusTarget(item.obj, item.label, item.vector);
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
    if (!engine || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    const previousSelectionId = selectedTargetRef.current?.obj.v ?? null;

    window.setTimeout(() => {
      const selectionRadius = getClickSelectionRadius(engine);
      const nativeSelection = getEngineSelection(engine);
      if (nativeSelection) {
        const matchedNativeTarget = findMatchingSearchTarget(
          nativeSelection,
          [...clickTargetsRef.current, ...searchSuggestionsRef.current]
        );
        if (nativeSelection.v !== previousSelectionId) {
          const label = labelForObject(
            nativeSelection,
            "Selected object",
            clickTargetsRef.current
          );
          selectTarget(
            nativeSelection,
            matchedNativeTarget?.label ?? label,
            matchedNativeTarget?.vector
          );
          return;
        }

        const nativePoint = projectTargetToScreen(
          engine,
          canvas,
          nativeSelection,
          matchedNativeTarget?.vector
        );
        const nativeDistance = nativePoint
          ? Math.hypot(nativePoint.x - clickX, nativePoint.y - clickY)
          : Number.POSITIVE_INFINITY;
        if (nativeDistance > selectionRadius) {
          clearEngineSelection(engine);
        } else {
          const label = labelForObject(
            nativeSelection,
            "Selected object",
            clickTargetsRef.current
          );
          selectTarget(
            nativeSelection,
            matchedNativeTarget?.label ?? label,
            matchedNativeTarget?.vector
          );
          return;
        }
      }

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
        return;
      }

      clearSelectedTarget();
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
      const catalogTarget = catalogSearchRef.current.get(normalizedTerm);
      const target =
        selectedTarget?.obj ??
        exactSuggestion?.obj ??
        catalogTarget ??
        engineTarget ??
        suggestions[0]?.obj ??
        null;
      if (!target) {
        return;
      }

      const isDeepSkySearch = getDeepSkySearchCandidates(term).length > 0;
      if (isDeepSkySearch) {
        setDeepSkyMode(true);
        ensureDssDataSource(engine, loadedPlanetSurveysRef.current);
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
          : catalogTarget === target
          ? exactSuggestion?.vector ?? matchedClickTarget?.vector
          : engineTarget === target
          ? undefined
          : matchedClickTarget?.vector
          ? matchedClickTarget.vector
          : suggestions[0]?.obj === target
            ? suggestions[0].vector
            : undefined
      );
      if (isDeepSkySearch) {
        engine.zoomTo?.(DEEP_SKY_IMAGE_FOV, 1.2);
      }
    } catch (error) {
      console.error(error);
    }
  }

  const updateSelectedInfo = useCallback(() => {
    const engine = engineRef.current;
    const selected = selectedTargetRef.current;
    if (!engine || !selected) return;

    setSelectedInfo(
      getSafeObjectInfo(
        engine,
        selected.obj,
        selected.label,
        selected.vector
      )
    );
  }, []);

  useEffect(() => {
    updateSelectedInfo();
  }, [updateSelectedInfo]);

  const applyObservationTime = useCallback((value: string | Date) => {
    const engine = engineRef.current;
    if (!engine) return false;

    if (setObservationTime(engine, value)) {
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
          elapsedSeconds * speed.multiplier * timeDirection * 1000
      );

      applyObservationTime(simulatedTimeRef.current);
      const trackingTarget = trackingTargetRef.current;
      const engine = engineRef.current;
      if (engine && trackingTarget) {
        centerTarget(engine, trackingTarget.obj, trackingTarget.vector, 0, false);
      }

      const lastTimeDisplayUpdate = lastTimeDisplayUpdateRef.current ?? 0;
      if (
        !isEditingTime &&
        now - lastTimeDisplayUpdate >= TIME_DISPLAY_UPDATE_INTERVAL_MS
      ) {
        lastTimeDisplayUpdateRef.current = now;
        const nextTime = toDateTimeLocalValue(simulatedTimeRef.current);
        setTimeDraft(nextTime);
        updateSelectedInfo();
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      lastTickRef.current = null;
      lastTimeDisplayUpdateRef.current = null;
      window.cancelAnimationFrame(frameId);
    };
  }, [
    applyObservationTime,
    deepSkyMode,
    isEditingTime,
    isTimePaused,
    observerLocation,
    status,
    timeSpeedIndex,
    timeDirection,
    updateSelectedInfo,
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

  async function handleToggle(name: DisplayToggleName) {
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
      if (nextValue) {
        ensureDssDataSource(engine, loadedPlanetSurveysRef.current);
      }
      applyDeepSkyMode(engine, nextValue);
    }
  }

  function handleTimePlayPauseToggle() {
    lastTickRef.current = performance.now();
    setIsTimePaused((current) => !current);
  }

  function stepTimeSpeed(direction: 1 | -1) {
    lastTickRef.current = performance.now();
    setTimeSpeedIndex((current) =>
      !isTimePaused && timeDirection === direction
        ? (current + 1) % TIME_SPEEDS.length
        : current
    );
    setTimeDirection(direction);
    setIsTimePaused(false);
  }

  function handleTimeForwardStep() {
    stepTimeSpeed(1);
  }

  function handleTimeReverseStep() {
    stepTimeSpeed(-1);
  }

  function handleTelescopeSettingsChange(nextSettings: TelescopeSettings) {
    setTelescopeSettings(nextSettings);
  }

  function handleApplyLocation(location: ObserverLocation, name?: string) {
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
        getSafeObjectInfo(
          engine,
          selected.obj,
          selected.label,
          selected.vector
        )
      );
    }

    return true;
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

      <button
        type="button"
        className={styles.panelToggle}
        onClick={() => setIsControlPanelOpen((current) => !current)}
        aria-label={isControlPanelOpen ? "관측 패널 닫기" : "관측 패널 열기"}
        aria-expanded={isControlPanelOpen}
        title={isControlPanelOpen ? "관측 패널 닫기" : "관측 패널 열기"}
      >
        <span aria-hidden="true" />
      </button>

      {isControlPanelOpen && (
        <SkyViewerControls
          calendarDays={calendarDays}
          deepSkyMode={deepSkyMode}
          formatDisplayDateTime={formatDisplayDateTime}
          isTimePaused={isTimePaused}
          isTimePickerOpen={isTimePickerOpen}
          locationName={locationQuery}
          observerLocation={observerLocation}
          query={query}
          status={status}
          statusText={statusText}
          suggestions={suggestions}
          timeDraft={timeDraft}
          timeDraftDate={timeDraftDate}
          timePickerMonth={timePickerMonth}
          timeDirection={timeDirection}
          toggles={toggles}
          weekdayLabels={WEEKDAY_LABELS}
          onApplyLocation={handleApplyLocation}
          onApplyTime={handleApplyTime}
          onDeepSkyModeToggle={handleDeepSkyModeToggle}
          onDraftDateChange={updateDraftDate}
          onDraftTimeChange={updateDraftTime}
          onOpenTimePicker={openTimePicker}
          onQueryChange={updateQuery}
          onSearchSubmit={handleSearch}
          onSuggestionSelect={focusSuggestion}
          onTimeForwardStep={handleTimeForwardStep}
          onTimePlayPauseToggle={handleTimePlayPauseToggle}
          onTimeReverseStep={handleTimeReverseStep}
          onTimePickerMonthChange={setTimePickerMonth}
          onToggle={handleToggle}
          onUseCurrentTime={handleUseCurrentTime}
        />
      )}

      <SkyViewerToolbar
        deepSkyMode={deepSkyMode}
        telescopeSettings={telescopeSettings}
        toggles={toggles}
        onDeepSkyModeToggle={handleDeepSkyModeToggle}
        onTelescopeSettingsChange={handleTelescopeSettingsChange}
        onToggle={handleToggle}
      />

      <ObjectInfoPanel info={selectedInfo} />
    </main>
  );
}
