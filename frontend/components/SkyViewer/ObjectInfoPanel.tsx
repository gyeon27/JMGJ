import { useState } from "react";
import styles from "./SkyViewer.module.css";
import type { ObjectInfo } from "./types";

type InfoTab = "position" | "names" | "photometry";

const INFO_TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "position", label: "위치" },
  { id: "names", label: "이름" },
  { id: "photometry", label: "광도" },
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
        <InfoGrid
          items={[
            ["겉보기 등급", info.apparentMagnitude],
            ["절대 등급", info.absoluteMagnitude],
            ["거리", info.distance],
            ["거리계수", info.distanceModulus],
            ["분류", info.objectType],
            ["크기", info.dimensions],
            ["스펙트럼", info.spectrum],
          ]}
        />
      )}
    </section>
  );
}

export function ObjectInfoPanel({ info }: { info: ObjectInfo | null }) {
  if (!info) return null;

  return <ObjectInfoPanelContent key={info.name} info={info} />;
}
