// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * A tag, chosen to put everything carrying it on the canvas (CanvasTools):
 * the tags in use, most used first, narrowed as it is typed. What is placed
 * is decided by the strip; this only answers which tag.
 */

import { useEffect, useMemo, useState } from "react";
import { ask } from "../api.ts";
import { PointerMenu } from "./PointerMenu.tsx";

export function TagPicker({ x, y, onPick, onClose }: { x: number; y: number; onPick: (tag: string) => void; onClose: () => void }) {
  const [all, setAll] = useState<{ tag: string; count: number }[] | null>(null);
  const [words, setWords] = useState("");
  useEffect(() => {
    ask<{ tag: string; count: number }[]>("GET", "/tags").then((t) => setAll(t ?? []), () => setAll([]));
  }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".cv-tagpick")) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  const shown = useMemo(() => {
    const w = words.trim().replace(/^#+/, "").toLowerCase();
    return (all ?? []).filter((t) => !w || t.tag.toLowerCase().includes(w)).slice(0, 30);
  }, [all, words]);
  return (
    <PointerMenu x={x} y={y} className="menu cv-menu cv-tagpick">
      <div className="cv-entity-panel">
        <input
          autoFocus
          className="cv-bringin-q"
          placeholder="Everything tagged…"
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.stopPropagation(); onClose(); }
            if (e.key === "Enter" && shown[0]) onPick(shown[0].tag);
          }}
        />
        {all === null ? <div className="cv-bringin-empty">Reading the tags…</div>
          : !shown.length ? <div className="cv-bringin-empty">{all.length ? "No tag like that" : "Nothing is tagged yet"}</div>
          : shown.map((t) => (
            <button key={t.tag} className="menu-item" onClick={() => onPick(t.tag)}>
              #{t.tag}<span style={{ marginLeft: "auto", paddingLeft: 12, opacity: 0.6 }}>{t.count}</span>
            </button>
          ))}
      </div>
    </PointerMenu>
  );
}
