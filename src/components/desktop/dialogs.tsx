"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type PromptOpts = { title: string; label?: string; value?: string; confirmText?: string };
type ConfirmOpts = { title: string; message: string; danger?: boolean; confirmText?: string };

type DialogState =
  | ({ type: "prompt" } & PromptOpts)
  | ({ type: "confirm" } & ConfirmOpts)
  | null;

type DialogsApi = {
  prompt: (o: PromptOpts) => Promise<string | null>;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  toast: (message: string) => void;
};

const Ctx = createContext<DialogsApi | null>(null);

export function useDialogs() {
  const v = useContext(Ctx);
  if (!v) throw new Error("DialogProvider missing");
  return v;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [text, setText] = useState("");
  const resolver = useRef<((v: unknown) => void) | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const toastId = useRef(0);

  const prompt = useCallback((o: PromptOpts) => {
    setText(o.value ?? "");
    setDialog({ type: "prompt", ...o });
    return new Promise<string | null>((res) => {
      resolver.current = res as (v: unknown) => void;
    });
  }, []);

  const confirm = useCallback((o: ConfirmOpts) => {
    setDialog({ type: "confirm", ...o });
    return new Promise<boolean>((res) => {
      resolver.current = res as (v: unknown) => void;
    });
  }, []);

  const toast = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const close = (value: unknown) => {
    resolver.current?.(value);
    resolver.current = null;
    setDialog(null);
  };

  const api = useMemo(() => ({ prompt, confirm, toast }), [prompt, confirm, toast]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {dialog && (
        <DialogView
          dialog={dialog}
          text={text}
          setText={setText}
          onCancel={() => close(dialog.type === "prompt" ? null : false)}
          onOk={() => close(dialog.type === "prompt" ? text : true)}
        />
      )}
      <div className="pointer-events-none fixed left-1/2 top-4 z-[10000] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-[pop_0.2s_ease-out] rounded-full border border-white/15 bg-slate-900/90 px-4 py-2 text-sm text-white shadow-xl backdrop-blur"
          >
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function DialogView({
  dialog,
  text,
  setText,
  onCancel,
  onOk,
}: {
  dialog: NonNullable<DialogState>;
  text: string;
  setText: (v: string) => void;
  onCancel: () => void;
  onOk: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog.type === "prompt") {
      inputRef.current?.focus();
      const el = inputRef.current;
      if (el) {
        const dot = el.value.lastIndexOf(".");
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      }
    }
  }, [dialog]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const danger = dialog.type === "confirm" && dialog.danger;

  return (
    <div
      className="fixed inset-0 z-[9999] grid place-items-center bg-black/40 p-4 backdrop-blur-[2px]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <form
        className="w-full max-w-sm animate-[pop_0.15s_ease-out] rounded-2xl border border-white/10 bg-slate-800/95 p-5 text-slate-100 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          onOk();
        }}
      >
        <h3 className="text-base font-semibold">{dialog.title}</h3>
        {dialog.type === "prompt" ? (
          <>
            {dialog.label && <p className="mt-2 text-sm text-slate-400">{dialog.label}</p>}
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="mt-3 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-300">{dialog.message}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-1.5 text-sm text-slate-300 hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="submit"
            autoFocus={dialog.type === "confirm"}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium text-white ${
              danger ? "bg-red-500 hover:bg-red-400" : "bg-[var(--accent)] hover:brightness-110"
            }`}
          >
            {dialog.confirmText ?? "确定"}
          </button>
        </div>
      </form>
    </div>
  );
}
