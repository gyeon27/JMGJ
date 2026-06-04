import { useState } from "react";
import styles from "./SkyViewer.module.css";
import type { ObjectInfo } from "./types";

type InfoTab = "position" | "names" | "photometry";

const INFO_TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "position", label: "위치" },
  { id: "names", label: "이름" },
  { id: "photometry", label: "정보" },
];

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlanetPhasePreview({ fraction }: { fraction: number }) {
  const lit = Math.min(1, Math.max(0, fraction));
  const shadow = 1 - lit;
  const controlX = 50 + (shadow - 0.5) * 170;
  const shadowPath =
    shadow <= 0.005
      ? ""
      : shadow >= 0.995
        ? "M50 5a45 45 0 1 1 0 90a45 45 0 1 1 0-90"
        : `M50 5 A45 45 0 0 0 50 95 Q ${controlX.toFixed(1)} 50 50 5 Z`;

  return (
    <div className={styles.phasePreview} aria-label={`행성 조명률 ${(lit * 100).toFixed(1)}%`}>
      <svg viewBox="0 0 100 100" role="img" aria-hidden="true">
        <circle cx="50" cy="50" r="45" className={styles.phaseLight} />
        {shadowPath && <path d={shadowPath} className={styles.phaseDark} />}
        <circle cx="50" cy="50" r="45" className={styles.phaseRim} />
      </svg>
      <span>{(lit * 100).toFixed(1)}%</span>
    </div>
  );
}

function ObjectInfoPanelContent({ info }: { info: ObjectInfo }) {
  const [activeTab, setActiveTab] = useState<InfoTab>("position");

  return (
    <section className={styles.infoPanel} aria-label="선택한 천체 정보">
      <div className={styles.infoHeader}>
        <h2>{info.name}</h2>
        <div className={styles.infoTabs} role="tablist" aria-label="천체 정보">
          {INFO_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? styles.active : ""}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "position" && (
        <InfoGrid
          items={[
            ["고도", info.altitude],
            ["방위각", info.azimuth],
            ["적경", info.rightAscension],
            ["적위", info.declination],
          ]}
        />
      )}

      {activeTab === "names" && (
        <div className={styles.aliasPanel}>
          {info.aliases.length > 0 ? (
            info.aliases.map((alias) => (
              <span key={alias} className={styles.aliasChip} title={alias}>
                <span>{alias}</span>
              </span>
            ))
          ) : (
            <p>다른 이름 정보 없음</p>
          )}
        </div>
      )}

      {activeTab === "photometry" && (
        <>
          {info.phaseFraction !== null && (
            <PlanetPhasePreview fraction={info.phaseFraction} />
          )}
          <InfoGrid
            items={
              info.physicalFields.length > 0
                ? info.physicalFields
                : [["물리량", "정보 없음"]]
            }
          />
        </>
      )}
    </section>
  );
}

export function ObjectInfoPanel({ info }: { info: ObjectInfo | null }) {
  if (!info) return null;

  return <ObjectInfoPanelContent key={info.name} info={info} />;
}
