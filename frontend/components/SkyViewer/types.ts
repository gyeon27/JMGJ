export type EngineStatus = "loading" | "ready" | "error";

export type LocationApplyState = "idle" | "loading" | "ok" | "error";

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
