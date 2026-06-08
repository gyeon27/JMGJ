export type EngineStatus = "loading" | "ready" | "error";

export type LocationApplyState = "idle" | "loading" | "ok" | "error";

export type SweObj = {
  v: number;
  id?: string;
  path?: string;
  name?: string;
  add?: (obj: SweObj) => SweObj;
  data?: Record<string, unknown>;
  remove?: (obj: SweObj) => void;
  destroy?: () => void;
  addDataSource?: (args: { url: string; key?: string }) => void;
  designations?: () => string[];
  getInfo?: (format?: string, observer?: SweObj) => unknown;
  getPath?: () => string;
  jsonData?: {
    model_data?: Record<string, unknown>;
  };
  radec?: number[];
  z?: number;
  update?: () => void;
};

export type StellariumEngine = {
  asm?: Record<string, (...args: number[]) => number>;
  canvas?: HTMLCanvasElement;
  core?: Record<string, unknown>;
  observer?: SweObj;
  convertFrame?: (
    observer: SweObj,
    origin: string,
    dest: string,
    vector: number[]
  ) => number[];
  createLayer?: (data: Record<string, unknown>) => SweObj | null;
  createObj?: (type: string, args: Record<string, unknown>) => SweObj | null;
  date2MJD?: (date: number) => number;
  getObj?: (name: string) => SweObj | null;
  getModule?: (name: string) => SweObj | null;
  getValue?: (path: string) => unknown;
  lookAt?: (position: [number, number, number], duration?: number) => void;
  pointAndLock?: (target: SweObj, duration?: number) => void;
  zoomTo?: (fov: number, duration?: number) => void;
  setValue?: (path: string, value: unknown) => void;
  _core_update?: () => void;
  _core_set_time?: (mjd: number, duration: number) => void;
  _observer_update?: (observer: number, fast: boolean) => void;
  _free?: (ptr: number) => void;
  _malloc?: (size: number) => number;
};

export type StellariumFactory = (options: {
  canvasElement: HTMLCanvasElement;
  res?: string[];
  wasmFile: string;
}) => Promise<StellariumEngine>;

export type ObserverLocation = {
  latitude: number;
  longitude: number;
};

export type TelescopeSettings = {
  focalLengthMm: number;
  apertureMm: number;
};

export type GeocodeResult = ObserverLocation & {
  name: string;
};

export type ObjectInfo = {
  name: string;
  aliases: string[];
  altitude: string;
  azimuth: string;
  altitudeDegrees: number;
  azimuthDegrees: number;
  rightAscension: string;
  declination: string;
  apparentMagnitude: string;
  absoluteMagnitude: string;
  distance: string;
  distanceModulus: string;
  objectType: string;
  physicalFields: Array<[string, string]>;
  calculationFields: Array<[string, string]>;
  phaseFraction: number | null;
};

export type BrightStar = {
  id?: number;
  hip?: number | null;
  hr: number | null;
  hd: number | null;
  name: string;
  names: string[];
  ra: number;
  dec: number;
  vmag: number;
  absoluteMagnitude?: number | null;
  distanceParsec?: number | null;
  spect: string;
  colorIndex?: number | null;
};

export type RenderStar = Pick<
  BrightStar,
  "hr" | "name" | "names" | "ra" | "dec" | "vmag"
> & {
  vector: number[];
};

export type BrightStarCatalog = {
  source: string;
  count: number;
  stars: BrightStar[];
};

export type SearchSuggestion = {
  key: string;
  label: string;
  obj: SweObj;
  vector?: number[];
  priority?: number;
};

export type SelectedTarget = {
  label: string;
  obj: SweObj;
  vector?: number[];
};
