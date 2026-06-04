import { useState } from "react";
import styles from "./SkyViewer.module.css";
import type { TelescopeSettings } from "./types";

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
  | "deepSky"
  | "settings";

type SkyViewerToolbarProps = {
  deepSkyMode: boolean;
  telescopeSettings: TelescopeSettings;
  toggles: DisplayToggles;
  onDeepSkyModeToggle: () => void;
  onTelescopeSettingsChange: (settings: TelescopeSettings) => void;
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

  if (name === "settings") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24.4 4h-.8a4 4 0 0 0-4 4v.3a4 4 0 0 1-2 3.5l-.8.4a4 4 0 0 1-4 0l-.3-.2a4 4 0 0 0-5.5 1.5l-.4.7a4 4 0 0 0 1.5 5.5l.3.2a4 4 0 0 1 2 3.5v1a4 4 0 0 1-2 3.5l-.3.2a4 4 0 0 0-1.5 5.5l.4.7a4 4 0 0 0 5.5 1.5l.3-.2a4 4 0 0 1 4 0l.8.4a4 4 0 0 1 2 3.5v.3a4 4 0 0 0 4 4h.8a4 4 0 0 0 4-4v-.3a4 4 0 0 1 2-3.5l.8-.4a4 4 0 0 1 4 0l.3.2a4 4 0 0 0 5.5-1.5l.4-.7a4 4 0 0 0-1.5-5.5l-.3-.2a4 4 0 0 1-2-3.5v-1a4 4 0 0 1 2-3.5l.3-.2a4 4 0 0 0 1.5-5.5l-.4-.7A4 4 0 0 0 35.5 12l-.3.2a4 4 0 0 1-4 0l-.8-.4a4 4 0 0 1-2-3.5V8a4 4 0 0 0-4-4Z" />
        <circle cx="24" cy="24" r="6" />
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
  telescopeSettings,
  toggles,
  onDeepSkyModeToggle,
  onTelescopeSettingsChange,
  onToggle,
}: SkyViewerToolbarProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  function updateTelescopeSetting(
    key: keyof TelescopeSettings,
    value: string
  ) {
    const parsed = Number(value);
    onTelescopeSettingsChange({
      ...telescopeSettings,
      [key]: Number.isFinite(parsed) ? Math.max(1, parsed) : 1,
    });
  }

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
      <div className={styles.toolbarSettingsWrapper}>
        <button
          type="button"
          className={[
            styles.settingsToolbarButton,
            isSettingsOpen ? styles.active : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => setIsSettingsOpen((current) => !current)}
          aria-label="망원경 설정"
          aria-expanded={isSettingsOpen}
          title="망원경 설정"
        >
          <ToolbarIcon name="settings" />
        </button>
        {isSettingsOpen && (
          <section className={styles.toolbarSettingsPanel} aria-label="망원경 설정">
            <h2>망원경 설정</h2>
            <label>
              <span>초점거리(mm)</span>
              <input
                type="number"
                min={1}
                step={10}
                value={telescopeSettings.focalLengthMm}
                onChange={(event) =>
                  updateTelescopeSetting("focalLengthMm", event.target.value)
                }
              />
            </label>
            <label>
              <span>구경(mm)</span>
              <input
                type="number"
                min={1}
                step={5}
                value={telescopeSettings.apertureMm}
                onChange={(event) =>
                  updateTelescopeSetting("apertureMm", event.target.value)
                }
              />
            </label>
          </section>
        )}
      </div>
    </div>
  );
}
