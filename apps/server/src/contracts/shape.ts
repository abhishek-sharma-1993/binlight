/**
 * A response's shape: every JSON path mapped to the types seen there.
 * `a.b[].c` means field `c` of the elements of array `a.b`. A key missing
 * from some array elements also records "absent".
 */
export type Shape = Record<string, string>;

export function shapeOf(value: unknown): Shape {
  const seen = new Map<string, Set<string>>();
  const add = (path: string, type: string) => {
    let types = seen.get(path);
    if (!types) seen.set(path, (types = new Set()));
    types.add(type);
  };

  const walk = (v: unknown, path: string) => {
    if (v === null) return add(path, "null");
    if (Array.isArray(v)) {
      add(path, "array");
      const objects = v.filter(isPlainObject);
      const keys = new Set(objects.flatMap((o) => Object.keys(o)));
      for (const o of objects) {
        for (const k of keys) if (!(k in o)) add(join(`${path}[]`, k), "absent");
      }
      for (const el of v) walk(el, `${path}[]`);
      return;
    }
    if (isPlainObject(v)) {
      add(path, "object");
      for (const [k, child] of Object.entries(v)) walk(child, join(path, k));
      return;
    }
    add(path, typeof v);
  };

  walk(value, "");
  return Object.fromEntries(
    [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, types]) => [path || "$", [...types].sort().join("|")]),
  );
}

export interface ShapeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffShapes(recorded: Shape, live: Shape): ShapeDiff {
  const added = Object.keys(live).filter((p) => !(p in recorded));
  const removed = Object.keys(recorded).filter((p) => !(p in live));
  const changed = Object.keys(recorded)
    .filter((p) => p in live && recorded[p] !== live[p])
    .map((p) => `${p}: ${recorded[p]} -> ${live[p]}`);
  return { added, removed, changed };
}

export function formatShapeDiff(diff: ShapeDiff): string {
  return [
    ...diff.removed.map((p) => `  - removed  ${p}`),
    ...diff.changed.map((p) => `  ~ changed  ${p}`),
    ...diff.added.map((p) => `  + added    ${p}`),
  ].join("\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
