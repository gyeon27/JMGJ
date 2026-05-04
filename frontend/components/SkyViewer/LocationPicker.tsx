import {
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  WheelEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { geocodeLocation, reverseGeocodeLocation } from "./geo";
import styles from "./SkyViewer.module.css";
import type { EngineStatus, LocationApplyState, ObserverLocation } from "./types";

const MAP_TILE_SIZE = 256;
const MAP_WIDTH = 520;
const MAP_HEIGHT = 360;
const MAP_MIN_ZOOM = 3;
const MAP_MAX_ZOOM = 18;

type MapDragState = {
  pointerId: number;
  x: number;
  y: number;
};

type LocationPickerProps = {
  status: EngineStatus;
  locationName: string;
  observerLocation: ObserverLocation;
  onApply: (location: ObserverLocation, name?: string) => boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function latLngToWorldPixel(
  latitude: number,
  longitude: number,
  zoom: number
) {
  const sinLatitude = Math.sin(
    (clamp(latitude, -85.05112878, 85.05112878) * Math.PI) / 180
  );
  const scale = MAP_TILE_SIZE * 2 ** zoom;

  return {
    x: ((longitude + 180) / 360) * scale,
    y:
      (0.5 -
        Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
      scale,
  };
}

function worldPixelToLatLng(x: number, y: number, zoom: number) {
  const scale = MAP_TILE_SIZE * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const mercatorY = 0.5 - y / scale;
  const latitude =
    90 - (360 * Math.atan(Math.exp(-mercatorY * 2 * Math.PI))) / Math.PI;

  return {
    latitude: clamp(latitude, -85.05112878, 85.05112878),
    longitude: ((longitude + 540) % 360) - 180,
  };
}

export function LocationPicker({
  status,
  locationName,
  observerLocation,
  onApply,
}: LocationPickerProps) {
  const mapMovedRef = useRef(false);
  const [mapSearchQuery, setMapSearchQuery] = useState("");
  const [mapSelectionName, setMapSelectionName] = useState(locationName);
  const [mapSearchState, setMapSearchState] =
    useState<LocationApplyState>("idle");
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [mapCenter, setMapCenter] = useState<ObserverLocation>(observerLocation);
  const [mapSelection, setMapSelection] =
    useState<ObserverLocation>(observerLocation);
  const [mapZoom, setMapZoom] = useState(13);
  const [mapDrag, setMapDrag] = useState<MapDragState | null>(null);

  const mapView = useMemo(() => {
    if (!isMapOpen) {
      return {
        tiles: [],
        marker: {
          x: MAP_WIDTH / 2,
          y: MAP_HEIGHT / 2,
        },
      };
    }

    const center = latLngToWorldPixel(
      mapCenter.latitude,
      mapCenter.longitude,
      mapZoom
    );
    const selection = latLngToWorldPixel(
      mapSelection.latitude,
      mapSelection.longitude,
      mapZoom
    );
    const zoomTileCount = 2 ** mapZoom;
    const firstTileX = Math.floor((center.x - MAP_WIDTH / 2) / MAP_TILE_SIZE);
    const lastTileX = Math.floor((center.x + MAP_WIDTH / 2) / MAP_TILE_SIZE);
    const firstTileY = Math.floor((center.y - MAP_HEIGHT / 2) / MAP_TILE_SIZE);
    const lastTileY = Math.floor((center.y + MAP_HEIGHT / 2) / MAP_TILE_SIZE);
    const tiles = [];

    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
        if (tileY < 0 || tileY >= zoomTileCount) continue;

        const wrappedTileX =
          ((tileX % zoomTileCount) + zoomTileCount) % zoomTileCount;
        tiles.push({
          key: `${mapZoom}-${tileX}-${tileY}`,
          left: tileX * MAP_TILE_SIZE - center.x + MAP_WIDTH / 2,
          top: tileY * MAP_TILE_SIZE - center.y + MAP_HEIGHT / 2,
          url: `https://tile.openstreetmap.org/${mapZoom}/${wrappedTileX}/${tileY}.png`,
        });
      }
    }

    return {
      tiles,
      marker: {
        x: selection.x - center.x + MAP_WIDTH / 2,
        y: selection.y - center.y + MAP_HEIGHT / 2,
      },
    };
  }, [isMapOpen, mapCenter, mapSelection, mapZoom]);

  function openLocationMap() {
    setMapCenter(observerLocation);
    setMapSelection(observerLocation);
    setMapSelectionName(locationName);
    setMapSearchQuery("");
    setMapSearchState("idle");
    setIsMapOpen(true);
  }

  async function updateMapSelection(
    location: ObserverLocation,
    fallbackName?: string
  ) {
    setMapSelection(location);
    setMapSelectionName(fallbackName ?? "주소 확인 중");

    const addressName = await reverseGeocodeLocation(location);
    setMapSelectionName(addressName ?? fallbackName ?? "선택한 위치");
  }

  function pickMapLocation(
    event: MouseEvent<HTMLDivElement> | PointerEvent<HTMLDivElement>
  ) {
    const rect = event.currentTarget.getBoundingClientRect();
    const center = latLngToWorldPixel(
      mapCenter.latitude,
      mapCenter.longitude,
      mapZoom
    );
    const selected = worldPixelToLatLng(
      center.x + event.clientX - rect.left - rect.width / 2,
      center.y + event.clientY - rect.top - rect.height / 2,
      mapZoom
    );

    void updateMapSelection(selected);
  }

  function handleMapPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    mapMovedRef.current = false;
    setMapDrag({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handleMapPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!mapDrag || mapDrag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - mapDrag.x, event.clientY - mapDrag.y) > 2) {
      mapMovedRef.current = true;
    }

    const center = latLngToWorldPixel(
      mapCenter.latitude,
      mapCenter.longitude,
      mapZoom
    );
    const nextCenter = worldPixelToLatLng(
      center.x - (event.clientX - mapDrag.x),
      center.y - (event.clientY - mapDrag.y),
      mapZoom
    );

    setMapCenter(nextCenter);
    setMapDrag({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handleMapPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (mapDrag && mapDrag.pointerId === event.pointerId) {
      setMapDrag(null);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleMapClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;

    if (mapMovedRef.current) {
      mapMovedRef.current = false;
      return;
    }
    pickMapLocation(event);
  }

  function handleMapZoom(nextZoom: number) {
    setMapZoom(clamp(nextZoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM));
  }

  function handleMapWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();

    const direction = event.deltaY < 0 ? 1 : -1;
    handleMapZoom(mapZoom + direction);
  }

  async function handleMapSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const term = mapSearchQuery.trim();
    if (!term) {
      setMapSearchState("error");
      return;
    }

    setMapSearchState("loading");
    const location = await geocodeLocation(term);
    if (!location) {
      setMapSelectionName("검색 결과 없음");
      setMapSearchState("error");
      return;
    }

    setMapCenter(location);
    setMapSelection(location);
    setMapSelectionName(location.name);
    setMapZoom((current) => Math.max(current, 15));
    setMapSearchState("ok");
  }

  function handleMapSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function applyMapLocation() {
    if (onApply(mapSelection, mapSelectionName)) {
      setMapSearchState("ok");
      setIsMapOpen(false);
    } else {
      setMapSearchState("error");
    }
  }

  return (
    <>
      <div className={styles.location}>
        <div className={styles.locationName}>
          <span>관측 위치</span>
          <strong>{locationName}</strong>
        </div>
        <button
          type="button"
          className={styles.mapOpenButton}
          onClick={openLocationMap}
          disabled={status !== "ready"}
        >
          지도에서 선택
        </button>
        <div className={styles.locationCoords} aria-live="polite">
          <label className={styles.coordField}>
            <span>위도</span>
            <input value={observerLocation.latitude.toFixed(4)} readOnly />
          </label>
          <label className={styles.coordField}>
            <span>경도</span>
            <input value={observerLocation.longitude.toFixed(4)} readOnly />
          </label>
        </div>
      </div>

      {isMapOpen && (
        <section className={styles.mapModal} aria-label="지도에서 관측 위치 선택">
          <div className={styles.mapDialog}>
            <div className={styles.mapHeader}>
              <div>
                <p className={styles.kicker}>관측 위치</p>
                <h2>지도에서 위치 선택</h2>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setIsMapOpen(false)}
                aria-label="지도 닫기"
              >
                ×
              </button>
            </div>

            <form className={styles.mapSearch} onSubmit={handleMapSearch}>
              <input
                value={mapSearchQuery}
                onChange={(event) => {
                  setMapSearchQuery(event.target.value);
                  setMapSearchState("idle");
                }}
                onKeyDown={handleMapSearchKeyDown}
                placeholder="주소나 장소 검색"
                aria-label="지도 위치 검색"
              />
              <button type="submit" disabled={mapSearchState === "loading"}>
                검색
              </button>
            </form>

            <div
              className={styles.mapCanvas}
              style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
              onClick={handleMapClick}
              onPointerDown={handleMapPointerDown}
              onPointerMove={handleMapPointerMove}
              onPointerUp={handleMapPointerUp}
              onPointerCancel={handleMapPointerUp}
              onWheel={handleMapWheel}
            >
              {mapView.tiles.map((tile) => (
                <div
                  key={tile.key}
                  className={styles.mapTile}
                  style={{
                    left: tile.left,
                    top: tile.top,
                    backgroundImage: `url(${tile.url})`,
                  }}
                />
              ))}
              <div
                className={styles.mapMarker}
                style={{
                  left: mapView.marker.x,
                  top: mapView.marker.y,
                }}
                aria-hidden="true"
              />
              <div className={styles.mapZoom}>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onWheel={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleMapZoom(mapZoom + 1);
                  }}
                  aria-label="지도 확대"
                >
                  +
                </button>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onWheel={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleMapZoom(mapZoom - 1);
                  }}
                  aria-label="지도 축소"
                >
                  -
                </button>
              </div>
              <span className={styles.mapAttribution}>
                © OpenStreetMap contributors
              </span>
            </div>

            <p className={styles.mapAddress}>{mapSelectionName}</p>
            <div className={styles.mapCoords}>
              <span>위도 {mapSelection.latitude.toFixed(6)}</span>
              <span>경도 {mapSelection.longitude.toFixed(6)}</span>
            </div>
            <div className={styles.mapActions}>
              <button type="button" onClick={() => setIsMapOpen(false)}>
                취소
              </button>
              <button type="button" onClick={applyMapLocation}>
                이 위치 적용
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
