import { useState } from "react";
import { Pipette } from "lucide-react";

/*
 * A color of one's own, typed as #rrggbb.
 *
 * Not `<input type="color">`: on a canvas inside a layer-shell panel that holds
 * the keyboard, the browser's picker is a window of its own that opens *under*
 * the panel and takes the input with it — the whole desktop seemed frozen
 * until a restart. The calendar's pickers went in-page for the same reason.
 */
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

function normal(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return `#${h.toLowerCase()}`;
}

export function CustomColor({ value, onPick, title = "Custom color…" }: { value: string | null; onPick: (color: string) => void; title?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ?? "");
  const ok = normal(text);
  return (
    <>
      <button className="cv-swatch cv-swatch-custom" title={title} onClick={() => setOpen((o) => !o)}>
        <Pipette size={12} />
      </button>
      {open && (
        <input
          className={`cv-hex${text && !ok ? " bad" : ""}`}
          autoFocus
          spellCheck={false}
          placeholder="#rrggbb"
          value={text}
          style={ok ? { borderColor: ok } : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The canvas listens for keys everywhere; typing here is typing.
            e.stopPropagation();
            if (e.key === "Enter" && ok) {
              onPick(ok);
              setOpen(false);
            } else if (e.key === "Escape") setOpen(false);
          }}
        />
      )}
    </>
  );
}
