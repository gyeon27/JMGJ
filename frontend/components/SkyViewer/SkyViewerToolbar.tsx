import styles from "./SkyViewer.module.css";

export type DisplayToggleName =
  | "horizontalCoordinates"
  | "constellationLines"
  | "atmosphere"
  | "ground";

export type DisplayToggles = Record<DisplayToggleName, boolean>;

type ToolbarIconName =
  | "constellation"
  | "horizontal"
  | "atmosphere"
  | "ground"
  | "deepSky";

type SkyViewerToolbarProps = {
  deepSkyMode: boolean;
  toggles: DisplayToggles;
  onDeepSkyModeToggle: () => void;
  onToggle: (name: DisplayToggleName) => void;
};

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  if (name === "constellation") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M9 36 17 12 32 18 39 35 23 39Z" />
        <circle cx="9" cy="36" r="4" />
        <circle cx="17" cy="12" r="4" />
        <circle cx="32" cy="18" r="4" />
        <circle cx="39" cy="35" r="4" />
        <circle cx="23" cy="39" r="4" />
      </svg>
    );
  }

  if (name === "horizontal") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="18" />
        <path d="M6 24h36M24 6c5 5 7.5 11 7.5 18S29 37 24 42M24 6c-5 5-7.5 11-7.5 18S19 37 24 42M10.5 14.5h27M10.5 33.5h27" />
      </svg>
    );
  }

  if (name === "atmosphere") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M14 34h23a8 8 0 0 0 0-16 12 12 0 0 0-23-3 9.5 9.5 0 0 0 0 19Z" />
      </svg>
    );
  }

  if (name === "ground") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M5 35c7-10 13-13 19-8 5-8 12-10 19 8" />
        <path d="M7 36h34" />
        <circle cx="34" cy="15" r="5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M39 14c-5-7-17-8-25-1 8-2 13 0 16 4-7-3-17 0-21 9 6-5 13-5 18-2-7 0-14 6-14 15 4-6 10-9 17-8 7 1 12-3 14-9-4 4-8 5-13 4 6-2 9-6 8-12Z" />
    </svg>
  );
}

export function SkyViewerToolbar({
  deepSkyMode,
  toggles,
  onDeepSkyModeToggle,
  onToggle,
}: SkyViewerToolbarProps) {
  return (
    <div className={styles.bottomToolbar} aria-label="Display toggles">
      <button
        type="button"
        className={toggles.constellationLines ? styles.active : ""}
        onClick={() => onToggle("constellationLines")}
        aria-label={`별자리선 ${toggles.constellationLines ? "끄기" : "켜기"}`}
        aria-pressed={toggles.constellationLines}
        title={`별자리선 ${toggles.constellationLines ? "끄기" : "켜기"}`}
      >
        <ToolbarIcon name="constellation" />
      </button>
      <button
        type="button"
        className={toggles.horizontalCoordinates ? styles.active : ""}
        onClick={() => onToggle("horizontalCoordinates")}
        aria-label={`지평좌표 ${
          toggles.horizontalCoordinates ? "끄기" : "켜기"
        }`}
        aria-pressed={toggles.horizontalCoordinates}
        title={`지평좌표 ${toggles.horizontalCoordinates ? "끄기" : "켜기"}`}
      >
        <ToolbarIcon name="horizontal" />
      </button>
      <button
        type="button"
        className={toggles.atmosphere ? styles.active : ""}
        onClick={() => onToggle("atmosphere")}
        aria-label={`대기 ${toggles.atmosphere ? "끄기" : "켜기"}`}
        aria-pressed={toggles.atmosphere}
        title={`대기 ${toggles.atmosphere ? "끄기" : "켜기"}`}
      >
        <ToolbarIcon name="atmosphere" />
      </button>
      <button
        type="button"
        className={toggles.ground ? styles.active : ""}
        onClick={() => onToggle("ground")}
        aria-label={`지평 ${toggles.ground ? "끄기" : "켜기"}`}
        aria-pressed={toggles.ground}
        title={`지평 ${toggles.ground ? "끄기" : "켜기"}`}
      >
        <ToolbarIcon name="ground" />
      </button>
      <button
        type="button"
        className={deepSkyMode ? styles.active : ""}
        onClick={onDeepSkyModeToggle}
        aria-label={`딥스카이 ${deepSkyMode ? "끄기" : "켜기"}`}
        aria-pressed={deepSkyMode}
        title={`딥스카이 ${deepSkyMode ? "끄기" : "켜기"}`}
      >
        <ToolbarIcon name="deepSky" />
      </button>
    </div>
  );
}
