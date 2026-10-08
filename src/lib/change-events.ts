export type ChangeTopic = "fs" | "settings" | "system";
type Listener = (topic: ChangeTopic) => void;
const holder = globalThis as unknown as { __wdChanges?: Set<Listener> };
const listeners = (holder.__wdChanges ??= new Set<Listener>());

export function publishChange(topic: ChangeTopic) {
  for (const listener of listeners) {
    try { listener(topic); } catch { /* disconnected subscriber */ }
  }
}

export function subscribeChanges(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
