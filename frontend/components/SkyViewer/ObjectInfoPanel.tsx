import styles from "./SkyViewer.module.css";
import type { ObjectInfo } from "./types";

export function ObjectInfoPanel({ info }: { info: ObjectInfo | null }) {
  if (!info) return null;

  return (
    <section className={styles.infoPanel} aria-label="Selected object info">
      <h2>{info.name}</h2>
      <dl>
        <div>
          <dt>고도</dt>
          <dd>{info.altitude}</dd>
        </div>
        <div>
          <dt>방위각</dt>
          <dd>{info.azimuth}</dd>
        </div>
        <div>
          <dt>적경</dt>
          <dd>{info.rightAscension}</dd>
        </div>
        <div>
          <dt>적위</dt>
          <dd>{info.declination}</dd>
        </div>
      </dl>
    </section>
  );
}
