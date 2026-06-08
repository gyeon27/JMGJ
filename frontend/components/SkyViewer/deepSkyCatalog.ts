export type DeepSkySupplementEntry = {
  id: string;
  names: string[];
  objectType?: string;
  magnitude?: number;
  surfaceBrightness?: number;
  majorAxisArcmin?: number;
  minorAxisArcmin?: number;
  positionAngleDeg?: number;
  constellation?: string;
  hubbleType?: string;
};

type DeepSkySupplementCatalog = {
  entries: DeepSkySupplementEntry[];
};

export type DeepSkySupplementIndex = Map<string, DeepSkySupplementEntry>;

let catalogPromise: Promise<DeepSkySupplementIndex> | null = null;

export function normalizeDeepSkyKey(value: string) {
  return value
    .replace(/^NAME\s+/i, "")
    .replace(/^(NGC|IC)\s*0*(\d+[A-Z]?)$/i, "$1 $2")
    .replace(/^M\s*0*(\d+)$/i, (_, id: string) => `M ${Number(id)}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function loadDeepSkySupplementCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch("/catalogs/deep-sky-supplement.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Cannot load deep-sky catalog: ${response.status}`);
        }
        return response.json() as Promise<DeepSkySupplementCatalog>;
      })
      .then((catalog) => {
        const index: DeepSkySupplementIndex = new Map();

        for (const entry of catalog.entries) {
          for (const name of [entry.id, ...entry.names]) {
            const key = normalizeDeepSkyKey(name);
            if (key && !index.has(key)) {
              index.set(key, entry);
            }

            const compactKey = key.replace(/\s+/g, "");
            if (compactKey && !index.has(compactKey)) {
              index.set(compactKey, entry);
            }
          }
        }

        return index;
      });
  }

  return catalogPromise;
}

export function findDeepSkySupplement(
  index: DeepSkySupplementIndex,
  names: string[]
) {
  for (const name of names) {
    const key = normalizeDeepSkyKey(name);
    const exact = index.get(key);
    if (exact) return exact;

    const compact = key.replace(/\s+/g, "");
    if (compact !== key) {
      const compactMatch = index.get(compact);
      if (compactMatch) return compactMatch;
    }
  }

  return null;
}
