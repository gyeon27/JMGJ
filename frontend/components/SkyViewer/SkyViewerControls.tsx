import type { FormEvent } from "react";
import { LocationPicker } from "./LocationPicker";
import styles from "./SkyViewer.module.css";
import type { DisplayToggleName, DisplayToggles } from "./SkyViewerToolbar";
import type {
  EngineStatus,
  ObserverLocation,
  SearchSuggestion,
} from "./types";

type TimeSpeed = {
  label: string;
  multiplier: number;
};

type SkyViewerControlsProps = {
  calendarDays: Date[];
  deepSkyMode: boolean;
  isTimePaused: boolean;
  isTimePickerOpen: boolean;
  locationName: string;
  observerLocation: ObserverLocation;
  query: string;
  status: EngineStatus;
  statusText: string;
  suggestions: SearchSuggestion[];
  timeDraft: string;
  timeDraftDate: Date;
  timePickerMonth: Date;
  timeSpeedIndex: number;
  timeSpeeds: TimeSpeed[];
  toggles: DisplayToggles;
  weekdayLabels: string[];
  formatDisplayDateTime: (value: string) => string;
  onApplyLocation: (location: ObserverLocation, name?: string) => boolean;
  onApplyTime: () => void;
  onDeepSkyModeToggle: () => void;
  onDraftDateChange: (date: Date) => void;
  onDraftTimeChange: (part: "hour" | "minute", value: string) => void;
  onOpenTimePicker: () => void;
  onQueryChange: (value: string) => void;
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSuggestionSelect: (suggestion: SearchSuggestion) => void;
  onTimePauseToggle: () => void;
  onTimePickerMonthChange: (date: Date) => void;
  onTimeSpeedChange: (index: number) => void;
  onToggle: (name: DisplayToggleName) => void;
  onUseCurrentTime: () => void;
};

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </svg>
  );
}

export function SkyViewerControls({
  calendarDays,
  deepSkyMode,
  formatDisplayDateTime,
  isTimePaused,
  isTimePickerOpen,
  locationName,
  observerLocation,
  query,
  status,
  statusText,
  suggestions,
  timeDraft,
  timeDraftDate,
  timePickerMonth,
  timeSpeedIndex,
  timeSpeeds,
  toggles,
  weekdayLabels,
  onApplyLocation,
  onApplyTime,
  onDeepSkyModeToggle,
  onDraftDateChange,
  onDraftTimeChange,
  onOpenTimePicker,
  onQueryChange,
  onSearchSubmit,
  onSuggestionSelect,
  onTimePauseToggle,
  onTimePickerMonthChange,
  onTimeSpeedChange,
  onToggle,
  onUseCurrentTime,
}: SkyViewerControlsProps) {
  return (
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

      <form className={styles.search} onSubmit={onSearchSubmit}>
        <div className={styles.searchBox}>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
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
                  onClick={() => onSuggestionSelect(item)}
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

      <div className={styles.field}>
        <span>시간</span>
        <div className={styles.timeField}>
          <button
            type="button"
            className={styles.timeInputButton}
            onClick={onOpenTimePicker}
            disabled={status !== "ready"}
          >
            <CalendarIcon />
            <span>{formatDisplayDateTime(timeDraft)}</span>
          </button>
          <button
            type="button"
            onClick={onUseCurrentTime}
            disabled={status !== "ready"}
          >
            현재시간
          </button>
        </div>
        {isTimePickerOpen && (
          <section className={styles.timePicker} aria-label="시간 선택">
            <div className={styles.timePickerHeader}>
              <button
                type="button"
                onClick={() =>
                  onTimePickerMonthChange(
                    new Date(
                      timePickerMonth.getFullYear(),
                      timePickerMonth.getMonth() - 1,
                      1
                    )
                  )
                }
              >
                이전
              </button>
              <strong>
                {timePickerMonth.getFullYear()}년{" "}
                {String(timePickerMonth.getMonth() + 1).padStart(2, "0")}월
              </strong>
              <button
                type="button"
                onClick={() =>
                  onTimePickerMonthChange(
                    new Date(
                      timePickerMonth.getFullYear(),
                      timePickerMonth.getMonth() + 1,
                      1
                    )
                  )
                }
              >
                다음
              </button>
            </div>
            <div className={styles.calendarWeekdays}>
              {weekdayLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className={styles.calendarGrid}>
              {calendarDays.map((date) => {
                const isCurrentMonth =
                  date.getMonth() === timePickerMonth.getMonth();
                const isSelected =
                  date.getFullYear() === timeDraftDate.getFullYear() &&
                  date.getMonth() === timeDraftDate.getMonth() &&
                  date.getDate() === timeDraftDate.getDate();

                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    className={[
                      isCurrentMonth ? "" : styles.outsideMonth,
                      isSelected ? styles.selectedDay : "",
                    ].join(" ")}
                    onClick={() => onDraftDateChange(date)}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
            <div className={styles.timePickerClock}>
              <select
                value={timeDraftDate.getHours()}
                onChange={(event) =>
                  onDraftTimeChange("hour", event.target.value)
                }
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, "0")}시
                  </option>
                ))}
              </select>
              <select
                value={timeDraftDate.getMinutes()}
                onChange={(event) =>
                  onDraftTimeChange("minute", event.target.value)
                }
              >
                {Array.from({ length: 60 }, (_, minute) => (
                  <option key={minute} value={minute}>
                    {String(minute).padStart(2, "0")}분
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.timePickerActions}>
              <button type="button" onClick={onApplyTime}>
                확인
              </button>
            </div>
          </section>
        )}
      </div>

      <div className={styles.timeControls} aria-label="시간 흐름 제어">
        <label className={styles.speedField}>
          <span>배속</span>
          <select
            value={timeSpeedIndex}
            onChange={(event) => onTimeSpeedChange(Number(event.target.value))}
            disabled={status !== "ready"}
          >
            {timeSpeeds.map((speed, index) => (
              <option key={speed.label} value={index}>
                {speed.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={[styles.timePauseButton, isTimePaused ? styles.active : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={onTimePauseToggle}
          disabled={status !== "ready"}
          aria-label={isTimePaused ? "시간 재생" : "시간 멈춤"}
          aria-pressed={isTimePaused}
          title={isTimePaused ? "시간 재생" : "시간 멈춤"}
        >
          <span
            className={isTimePaused ? styles.playIcon : styles.pauseIcon}
            aria-hidden="true"
          />
        </button>
      </div>

      <LocationPicker
        status={status}
        locationName={locationName}
        observerLocation={observerLocation}
        onApply={onApplyLocation}
      />

      <div className={styles.buttonGrid} aria-label="Display toggles">
        <button
          type="button"
          className={toggles.horizontalCoordinates ? styles.active : ""}
          onClick={() => onToggle("horizontalCoordinates")}
          aria-pressed={toggles.horizontalCoordinates}
        >
          지평좌표 {toggles.horizontalCoordinates ? "켜짐" : "꺼짐"}
        </button>
        <button
          type="button"
          className={toggles.constellationLines ? styles.active : ""}
          onClick={() => onToggle("constellationLines")}
          aria-pressed={toggles.constellationLines}
        >
          별자리선 {toggles.constellationLines ? "켜짐" : "꺼짐"}
        </button>
        <button
          type="button"
          className={toggles.atmosphere ? styles.active : ""}
          onClick={() => onToggle("atmosphere")}
          aria-pressed={toggles.atmosphere}
        >
          대기 {toggles.atmosphere ? "켜짐" : "꺼짐"}
        </button>
        <button
          type="button"
          className={toggles.ground ? styles.active : ""}
          onClick={() => onToggle("ground")}
          aria-pressed={toggles.ground}
        >
          지평 {toggles.ground ? "켜짐" : "꺼짐"}
        </button>
        <button
          type="button"
          className={deepSkyMode ? styles.active : ""}
          onClick={onDeepSkyModeToggle}
          aria-pressed={deepSkyMode}
        >
          딥스카이 {deepSkyMode ? "켜짐" : "꺼짐"}
        </button>
      </div>
    </section>
  );
}
