import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { LocationPicker } from "./LocationPicker";
import styles from "./SkyViewer.module.css";
import type { DisplayToggleName, DisplayToggles } from "./SkyViewerToolbar";
import type {
  EngineStatus,
  ObserverLocation,
  SearchSuggestion,
} from "./types";

const MIN_PICKER_YEAR = 1;
const MAX_PICKER_YEAR = 9999;

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
  timeDirection: 1 | -1;
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
  onTimeForwardStep: () => void;
  onTimePlayPauseToggle: () => void;
  onTimeReverseStep: () => void;
  onTimePickerMonthChange: (date: Date) => void;
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
  timeDirection,
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
  onTimeForwardStep,
  onTimePlayPauseToggle,
  onTimeReverseStep,
  onTimePickerMonthChange,
  onToggle,
  onUseCurrentTime,
}: SkyViewerControlsProps) {
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [yearInput, setYearInput] = useState(
    String(timePickerMonth.getFullYear())
  );
  const activeSuggestionRef = useRef<HTMLButtonElement | null>(null);
  const selectedSuggestionIndex =
    suggestions.length > 0
      ? Math.min(activeSuggestionIndex, suggestions.length - 1)
      : -1;

  useEffect(() => {
    activeSuggestionRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [selectedSuggestionIndex]);

  useEffect(() => {
    setYearInput(String(timePickerMonth.getFullYear()));
  }, [timePickerMonth]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestionIndex((current) => (current + 1) % suggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex(
        (current) => (current <= 0 ? suggestions.length : current) - 1
      );
      return;
    }

    if (event.key === "Enter" && selectedSuggestionIndex >= 0) {
      event.preventDefault();
      onSuggestionSelect(suggestions[selectedSuggestionIndex]);
    }
  }

  function changePickerYear(nextYear: number) {
    if (!Number.isFinite(nextYear)) return;

    const year = Math.min(
      MAX_PICKER_YEAR,
      Math.max(MIN_PICKER_YEAR, Math.trunc(nextYear))
    );
    const month = timePickerMonth.getMonth();
    const maxDate = new Date(year, month + 1, 0).getDate();
    const nextDate = new Date(
      year,
      month,
      Math.min(timeDraftDate.getDate(), maxDate)
    );

    onTimePickerMonthChange(new Date(year, month, 1));
    onDraftDateChange(nextDate);
  }

  function handlePickerYearInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value.replace(/\D/g, "").slice(0, 4);
    setYearInput(nextValue);
  }

  function applyPickerYearInput() {
    const nextYear = Number(yearInput);
    if (!yearInput || !Number.isFinite(nextYear)) {
      setYearInput(String(timePickerMonth.getFullYear()));
      return;
    }

    changePickerYear(nextYear);
  }

  function handlePickerYearKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;

    event.preventDefault();
    applyPickerYearInput();
  }

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
            onChange={(event) => {
              setActiveSuggestionIndex(0);
              onQueryChange(event.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Vega, Sirius, HR 7001..."
            aria-label="천체 검색"
            aria-activedescendant={
              selectedSuggestionIndex >= 0
                ? `sky-suggestion-${selectedSuggestionIndex}`
                : undefined
            }
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <div className={styles.suggestionList}>
              {suggestions.map((item, index) => (
                <button
                  id={`sky-suggestion-${index}`}
                  key={`${item.key}-${item.label}-${item.obj.v}`}
                  type="button"
                  className={
                    index === selectedSuggestionIndex
                      ? styles.activeSuggestion
                      : ""
                  }
                  ref={
                    index === selectedSuggestionIndex
                      ? activeSuggestionRef
                      : undefined
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
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
          <div className={styles.timeTransportButtons} aria-label="시간 재생 방향">
            <button
              type="button"
              className={!isTimePaused && timeDirection === -1 ? styles.active : ""}
              onClick={onTimeReverseStep}
              disabled={status !== "ready"}
              aria-label="시간 역방향 재생"
              aria-pressed={!isTimePaused && timeDirection === -1}
              title="역방향"
            >
              <span className={styles.fastReverseIcon} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={!isTimePaused ? styles.active : ""}
              onClick={onTimePlayPauseToggle}
              disabled={status !== "ready"}
              aria-label={isTimePaused ? "시간 재생" : "시간 정지"}
              aria-pressed={!isTimePaused}
              title={isTimePaused ? "재생" : "정지"}
            >
              <span
                className={isTimePaused ? styles.playIcon : styles.pauseIcon}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={onUseCurrentTime}
              disabled={status !== "ready"}
              aria-label="현재시간"
              title="현재시간"
            >
              <span className={styles.currentTimeIcon} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={!isTimePaused && timeDirection === 1 ? styles.active : ""}
              onClick={onTimeForwardStep}
              disabled={status !== "ready"}
              aria-label="시간 정방향 재생"
              aria-pressed={!isTimePaused && timeDirection === 1}
              title="정방향"
            >
              <span className={styles.fastForwardIcon} aria-hidden="true" />
            </button>
          </div>
        </div>
        {isTimePickerOpen && (
          <section className={styles.timePicker} aria-label="시간 선택">
            <div className={styles.timePickerYearControls}>
              <button
                type="button"
                onClick={() =>
                  changePickerYear(timePickerMonth.getFullYear() - 1)
                }
              >
                -1년
              </button>
              <label>
                <span>연도</span>
                <input
                  type="text"
                  inputMode="numeric"
                  minLength={1}
                  maxLength={4}
                  value={yearInput}
                  onChange={handlePickerYearInputChange}
                  onBlur={applyPickerYearInput}
                  onKeyDown={handlePickerYearKeyDown}
                  aria-label="연도"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  changePickerYear(timePickerMonth.getFullYear() + 1)
                }
              >
                +1년
              </button>
            </div>
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
