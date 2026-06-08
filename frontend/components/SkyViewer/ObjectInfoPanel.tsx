import { useState } from "react";
import styles from "./SkyViewer.module.css";
import type { ObjectInfo } from "./types";

type InfoTab = "position" | "names" | "photometry";

const INFO_TABS: Array<{ id: InfoTab; label: string }> = [
  { id: "position", label: "\uC704\uCE58" },
  { id: "names", label: "\uC774\uB984" },
  { id: "photometry", label: "\uC815\uBCF4" },
];

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl>
      {items.map(([label, value]) => (
        <div key={`${label}:${value}`}>
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
    <div
      className={styles.phasePreview}
      aria-label={`\uD589\uC131 \uC870\uBA85\uB960 ${(lit * 100).toFixed(1)}%`}
    >
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
  const difficulty = info.calculationFields.find(
    ([label]) => label === "\uAD00\uCE21 \uB09C\uC774\uB3C4"
  )?.[1];
  const calculationValues = new Set(
    info.calculationFields.map(([, value]) => value)
  );
  const physicalFields = info.physicalFields.filter(
    ([, value]) => !calculationValues.has(value)
  );

  return (
    <section className={styles.infoPanel} aria-label="\uC120\uD0DD\uD55C \uCC9C\uCCB4 \uC815\uBCF4">
      <div className={styles.infoHeader}>
        <h2>
          <span>{info.name}</span>
          {difficulty && (
            <span className={styles.difficultyBadge}>{difficulty}</span>
          )}
        </h2>
        <div className={styles.infoTabs} role="tablist" aria-label="\uCC9C\uCCB4 \uC815\uBCF4">
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
            ["\uACE0\uB3C4", info.altitude],
            ["\uBC29\uC704\uAC01", info.azimuth],
            ["\uC801\uACBD", info.rightAscension],
            ["\uC801\uC704", info.declination],
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
            <p>{"\uB2E4\uB978 \uC774\uB984 \uC815\uBCF4 \uC5C6\uC74C"}</p>
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
              physicalFields.length > 0
                ? physicalFields
                : [["\uBB3C\uB9AC\uB7C9", "\uC815\uBCF4 \uC5C6\uC74C"]]
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
