export type EngineStatus = "loading" | "ready" | "error";

export type LocationApplyState = "idle" | "loading" | "ok" | "error";

export type SweObj = {
  v: number;
  id?: string;
  path?: string;
  name?: string;
  add?: (obj: SweObj) => SweObj;
  designations?: () => string[];
  getInfo?: (format?: string, observer?: SweObj) => unknown;
  getPath?: () => string;
  radec?: number[];
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
  getValue?: (path: string) => unknown;
  lookAt?: (position: [number, number, number], duration?: number) => void;
  pointAndLock?: (target: SweObj, duration?: number) => void;
  setValue?: (path: string, value: unknown) => void;
  _core_update?: () => void;
  _core_set_time?: (mjd: number) => void;
  _free?: (ptr: number) => void;
  _malloc?: (size: number) => number;
};

export type StellariumFactory = (options: {
  canvasElement: HTMLCanvasElement;
  wasmFile: string;
}) => Promise<StellariumEngine>;

export type ObserverLocation = {
  latitude: number;
  longitude: number;
};

export type GeocodeResult = ObserverLocation & {
  name: string;
};

export type ObjectInfo = {
  name: string;
  altitude: string;
  azimuth: string;
  rightAscension: string;
  declination: string;
};

export type BrightStar = {
  hr: number;
  hd: number | null;
  name: string;
  names: string[];
  ra: number;
  dec: number;
  vmag: number;
  spect: string;
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
  vector: number[];
  priority?: number;
};

export type SelectedTarget = {
  label: string;
  obj: SweObj;
  vector?: number[];
};
