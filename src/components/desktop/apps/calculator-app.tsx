"use client";

import { useState } from "react";

type Op = "+" | "-" | "×" | "÷";

function compute(a: number, b: number, op: Op) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "×":
      return a * b;
    case "÷":
      return b === 0 ? NaN : a / b;
  }
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return "错误";
  const s = String(Number(n.toPrecision(12)));
  return s;
}

export function CalculatorApp() {
  const [display, setDisplay] = useState("0");
  const [acc, setAcc] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [fresh, setFresh] = useState(true);
  const [expr, setExpr] = useState("");

  const digit = (d: string) => {
    if (display === "错误") return reset(d);
    if (fresh) {
      setDisplay(d === "." ? "0." : d);
      setFresh(false);
    } else if (d === "." ? !display.includes(".") : true) {
      setDisplay(display === "0" && d !== "." ? d : display + d);
    }
  };
  const reset = (d = "0") => {
    setDisplay(d);
    setAcc(null);
    setOp(null);
    setFresh(d === "0");
    setExpr("");
  };
  const operate = (next: Op) => {
    const cur = parseFloat(display);
    if (isNaN(cur)) return;
    if (acc !== null && op && !fresh) {
      const r = compute(acc, cur, op);
      setAcc(r);
      setDisplay(fmt(r));
      setExpr(`${fmt(r)} ${next}`);
    } else {
      setAcc(cur);
      setExpr(`${fmt(cur)} ${next}`);
    }
    setOp(next);
    setFresh(true);
  };
  const equals = () => {
    if (acc === null || !op) return;
    const cur = parseFloat(display);
    const r = compute(acc, cur, op);
    setExpr(`${fmt(acc)} ${op} ${fmt(cur)} =`);
    setDisplay(fmt(r));
    setAcc(null);
    setOp(null);
    setFresh(true);
  };

  const keys: { l: string; t: "n" | "o" | "f" | "e"; fn: () => void; wide?: boolean }[] = [
    { l: "AC", t: "f", fn: () => reset() },
    { l: "±", t: "f", fn: () => display !== "0" && setDisplay(fmt(-parseFloat(display))) },
    { l: "%", t: "f", fn: () => setDisplay(fmt(parseFloat(display) / 100)) },
    { l: "÷", t: "o", fn: () => operate("÷") },
    ...["7", "8", "9"].map((d) => ({ l: d, t: "n" as const, fn: () => digit(d) })),
    { l: "×", t: "o", fn: () => operate("×") },
    ...["4", "5", "6"].map((d) => ({ l: d, t: "n" as const, fn: () => digit(d) })),
    { l: "-", t: "o", fn: () => operate("-") },
    ...["1", "2", "3"].map((d) => ({ l: d, t: "n" as const, fn: () => digit(d) })),
    { l: "+", t: "o", fn: () => operate("+") },
    { l: "0", t: "n", fn: () => digit("0"), wide: true },
    { l: ".", t: "n", fn: () => digit(".") },
    { l: "=", t: "e", fn: equals },
  ];

  return (
    <div
      className="flex h-full flex-col bg-slate-950/50 p-3"
      tabIndex={0}
      onKeyDown={(e) => {
        if (/^[0-9.]$/.test(e.key)) digit(e.key);
        else if (e.key === "+") operate("+");
        else if (e.key === "-") operate("-");
        else if (e.key === "*") operate("×");
        else if (e.key === "/") operate("÷");
        else if (e.key === "Enter" || e.key === "=") equals();
        else if (e.key === "Escape") reset();
        else if (e.key === "Backspace" && !fresh)
          setDisplay(display.length > 1 ? display.slice(0, -1) : "0");
      }}
    >
      <div className="flex flex-1 flex-col items-end justify-end px-2 pb-3">
        <div className="h-5 text-sm text-slate-400">{expr}</div>
        <div className="max-w-full truncate text-5xl font-light tabular-nums">{display}</div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {keys.map((k, i) => (
          <button
            key={i}
            onClick={k.fn}
            className={`h-12 rounded-xl text-lg font-medium transition active:scale-95 ${
              k.wide ? "col-span-2" : ""
            } ${
              k.t === "o"
                ? "bg-[var(--accent)]/80 text-white hover:bg-[var(--accent)]"
                : k.t === "e"
                  ? "bg-[var(--accent)] text-white hover:brightness-110"
                  : k.t === "f"
                    ? "bg-slate-600/70 hover:bg-slate-500/70"
                    : "bg-slate-700/60 hover:bg-slate-600/60"
            }`}
          >
            {k.l}
          </button>
        ))}
      </div>
    </div>
  );
}
