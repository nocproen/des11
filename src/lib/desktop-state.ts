// Pure three-way merge shared by server and client. Only locally changed fields
// are applied; unrelated concurrent edits survive and closed windows stay closed.
export type SharedWin = { id: string; app: string } & Record<string, unknown>;
export type SharedState = { wins: SharedWin[]; z: number; seq: number };

export function mergeDesktop(current: SharedState, incoming: SharedState, base: SharedState): SharedState {
  const before = new Map(base.wins.map((w) => [w.id, w]));
  const after = new Map(incoming.wins.map((w) => [w.id, w]));
  const wins = current.wins.filter((w) => !before.has(w.id) || after.has(w.id)).map((w) => ({ ...w }));
  const index = new Map(wins.map((w) => [w.id, w]));
  for (const next of incoming.wins) {
    const previous = before.get(next.id);
    const target = index.get(next.id);
    if (!previous) {
      if (!target && wins.length < 64) {
        const added = { ...next };
        wins.push(added);
        index.set(added.id, added);
      }
      continue;
    }
    if (!target) continue; // Another client closed it: never resurrect it.
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (key === "id" || Object.is(previous[key], next[key])) continue;
      if (next[key] === undefined) delete target[key];
      else target[key] = next[key];
    }
  }
  return {
    wins,
    z: Math.max(current.z, incoming.z, ...wins.map((w) => typeof w.z === "number" ? w.z : 0)),
    seq: Math.max(current.seq, incoming.seq),
  };
}
