"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

export type MenuItem =
  | { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean }
  | { divider: true };

type MenuApi = {
  show: (e: ReactMouseEvent, items: MenuItem[]) => void;
  hide: () => void;
};

const Ctx = createContext<MenuApi | null>(null);

export function useContextMenu() {
  const v = useContext(Ctx);
  if (!v) throw new Error("ContextMenuProvider missing");
  return v;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const show = useCallback((e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const hide = useCallback(() => setMenu(null), []);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && (
        <div
          ref={ref}
          data-ctxmenu
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-[9000] min-w-44 animate-[pop_0.1s_ease-out] rounded-xl border border-white/10 bg-slate-800/95 p-1.5 text-sm text-slate-100 shadow-2xl backdrop-blur-xl"
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((item, i) =>
            "divider" in item ? (
              <div key={i} className="my-1 h-px bg-white/10" />
            ) : (
              <button
                key={i}
                disabled={item.disabled}
                onClick={() => {
                  setMenu(null);
                  item.onClick();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left disabled:opacity-40 ${
                  item.danger ? "text-red-300 hover:bg-red-500/20" : "hover:bg-white/10"
                }`}
              >
                <span className="w-4 text-center">{item.icon}</span>
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
