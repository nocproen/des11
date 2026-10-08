"use client";

import { useEffect, type RefObject } from "react";
import { mergeDesktop, type SharedState } from "@/lib/desktop-state";
import type { Win } from "./wm-store";

type State = { wins: Win[]; z: number; seq: number };
type Snapshot = { version: number; state: State; origin?: string };
const wire = (s: State): SharedState => ({ ...s, wins: s.wins.map((w) => {
  const copy = { ...w };
  delete copy.pendingUrl;
  return copy;
}) });
const equal = (a: State, b: State) => JSON.stringify(wire(a)) === JSON.stringify(wire(b));

export function useDesktopSync(
  cid: string,
  stateRef: RefObject<State>,
  appliedRef: RefObject<State | null>,
  scheduleRef: RefObject<() => void>,
  replace: (state: State) => void,
) {
  useEffect(() => {
    let alive = true;
    let ready = false;
    let sending = false;
    let pulling = false;
    let version = -1;
    let base: State = { wins: [], z: 10, seq: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deferred: Snapshot | null = null;

    function schedule(delay = 120) {
      if (!alive || !ready || timer !== null) return;
      timer = setTimeout(() => void send(), delay);
    }
    scheduleRef.current = schedule;

    function reconcile(remote: Snapshot, baseline = base) {
      if (!alive || remote.version < version) return;
      const local = stateRef.current;
      const rebased = mergeDesktop(wire(remote.state), wire(local), wire(baseline)) as State;
      // URLs initiated by this browser must never be replayed on another client.
      rebased.wins = rebased.wins.map((w) => {
        const pendingUrl = local.wins.find((x) => x.id === w.id)?.pendingUrl;
        return pendingUrl ? { ...w, pendingUrl } : w;
      });
      base = remote.state;
      version = remote.version;
      ready = true;
      const dirty = !equal(rebased, base);
      appliedRef.current = dirty ? null : rebased;
      stateRef.current = rebased;
      replace(rebased);
      if (dirty) schedule();
    }

    async function send() {
      timer = null;
      if (!alive || !ready || sending || equal(stateRef.current, base)) return;
      sending = true;
      const snap = stateRef.current;
      let failed = false;
      try {
        const response = await fetch("/api/desktop/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cid, state: wire(snap), base: wire(base) }),
        });
        if (!response.ok) throw new Error(`Sync HTTP ${response.status}`);
        const result = await response.json() as Snapshot;
        // Only acknowledge what was sent. Edits made during this request survive.
        reconcile(result, snap);
      } catch {
        failed = true;
      } finally {
        sending = false;
        const queued = deferred;
        deferred = null;
        if (queued && queued.version > version) reconcile(queued);
        if (alive && !equal(stateRef.current, base)) schedule(failed ? 1500 : 120);
      }
    }

    async function pull() {
      if (!alive || sending || pulling) return;
      // Retry unsent changes before reading; never replace an offline draft.
      if (ready && !equal(stateRef.current, base)) { schedule(); return; }
      pulling = true;
      try {
        const response = await fetch("/api/desktop/state", { cache: "no-store" });
        if (!response.ok || !alive) return;
        const result = await response.json() as Snapshot;
        if (sending) deferred = result;
        else if (!ready || result.version > version) reconcile(result);
      } catch { /* retry on interval, focus or reconnect */ }
      finally { pulling = false; }
    }

    const onState = (event: MessageEvent) => {
      try {
        const result = JSON.parse(event.data) as Snapshot;
        if (result.version <= version) return;
        if (sending) {
          if (!deferred || result.version > deferred.version) deferred = result;
        } else reconcile(result);
      } catch { /* ignore malformed event */ }
    };
    const onRefresh = (event: MessageEvent) => {
      try { window.dispatchEvent(new CustomEvent("wd:refresh", { detail: JSON.parse(event.data) })); }
      catch { /* ignore malformed event */ }
    };
    let stream: EventSource | null = null;
    try {
      stream = new EventSource(`/api/desktop/stream?cid=${encodeURIComponent(cid)}`);
      stream.addEventListener("state", onState as EventListener);
      stream.addEventListener("refresh", onRefresh as EventListener);
      stream.addEventListener("auth", () => window.location.reload());
      stream.onopen = () => { void pull(); window.dispatchEvent(new CustomEvent("wd:refresh")); };
    } catch { /* polling works if SSE is unavailable */ }
    const visible = () => { if (!document.hidden) void pull(); };
    const poll = setInterval(visible, 3000);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    window.addEventListener("focus", visible);
    void pull();
    return () => {
      alive = false;
      scheduleRef.current = () => {};
      stream?.close();
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("focus", visible);
    };
  }, [cid, stateRef, appliedRef, scheduleRef, replace]);
}
