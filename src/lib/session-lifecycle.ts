// A shared application belongs to its desktop window, not to any one viewer.
type Close = () => void | Promise<void>;
const holder = globalThis as unknown as { __wdWindowSessions?: Map<string, Map<string, Close>> };
const sessions = (holder.__wdWindowSessions ??= new Map<string, Map<string, Close>>());
export function registerWindowSession(windowId: string, kind: string, close: Close) {
  const window = sessions.get(windowId) ?? new Map<string, Close>();
  window.set(kind, close);
  sessions.set(windowId, window);
}
export function closeWindowSessions(windowIds: string[]) {
  for (const id of windowIds) {
    const window = sessions.get(id);
    sessions.delete(id);
    if (!window) continue;
    for (const close of window.values()) {
      try { void Promise.resolve(close()).catch((error) => console.error("[session-close]", error)); }
      catch (error) { console.error("[session-close]", error); }
    }
  }
}
