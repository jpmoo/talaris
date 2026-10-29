// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
import { useEffect, useRef, useState } from "react";

/*
 * A color of one's own: a picker drawn in the page — saturation and value in a
 * square, hue in a strip, and the hex to type — as Settings' accent has.
 *
 * Not `<input type="color">`: on a canvas inside a layer-shell panel that holds
 * the keyboard, the browser's picker is a window of its own that opens *under*
 * the panel and takes the input with it — the whole desktop seemed frozen
 * until a restart. The calendar's pickers went in-page for the same reason.
 *
 * Dragging previews (`onPreview`, if given); letting go, or Enter in the hex,
 * keeps the color (`onPick`).
 */
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function normal(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return `#${h.toLowerCase()}`;
}

function toHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = !d ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return [h, max ? d / max : 0, max];
}

function toHex(h: number, s: number, v: number): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

type Hsv = [number, number, number];

export function CustomColor({ value, onPick, onPreview, title = "Custom color…" }: {
  value: string | null;
  onPick: (color: string) => void;
  onPreview?: (color: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => toHsv(normal(value ?? "") ?? "#c98a5b"));
  const [text, setText] = useState(value ?? "");
  const now = toHex(...hsv);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const held = useRef<Hsv>(hsv);
  held.current = hsv;

  // Opened afresh on the color there is now.
  useEffect(() => {
    if (!open) return;
    const start = normal(value ?? "") ?? "#c98a5b";
    setHsv(toHsv(start));
    setText(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const drag = (box: React.RefObject<HTMLDivElement>, move: (x: number, y: number, from: Hsv) => Hsv) => (e: React.PointerEvent) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    let last = held.current;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      last = move(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)), last);
      setHsv(last);
      setText(toHex(...last));
      onPreview?.(toHex(...last));
    };
    at(e);
    el.onpointermove = at;
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      onPick(toHex(...last));
    };
  };

  return (
    <>
      <button className="cv-swatch cv-swatch-custom" title={title} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="cv-picker" onPointerDown={(e) => e.stopPropagation()}>
          <div className="cv-picker-sv" ref={sv} style={{ ["--hue" as string]: hsv[0] }}
            onPointerDown={drag(sv, (x, y, from) => [from[0], x, 1 - y])}>
            <span className="knob" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%` }} />
          </div>
          <div className="cv-picker-hue" ref={hue} onPointerDown={drag(hue, (_x, y, from) => [Math.min(359, y * 360), from[1], from[2]])}>
            <span className="knob" style={{ top: `${(hsv[0] / 360) * 100}%` }} />
          </div>
          <div className="cv-picker-foot">
            <span className="cv-picker-chip" style={{ background: now }} />
            <input
              className={`cv-hex${text && !normal(text) ? " bad" : ""}`}
              spellCheck={false}
              placeholder="#rrggbb"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const ok = normal(e.target.value);
                if (ok) setHsv(toHsv(ok));
              }}
              onKeyDown={(e) => {
                // The canvas listens for keys everywhere; typing here is typing.
                e.stopPropagation();
                const ok = normal(text);
                if (e.key === "Enter" && ok) {
                  onPick(ok);
                  setOpen(false);
                } else if (e.key === "Escape") setOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
