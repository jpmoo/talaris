// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * "Bring in…": find an entity in the core and put it on the canvas as a card.
 * What can be found is what an @ finds (`/mentionables`): people, tasks,
 * events, and every project's pages and canvases — this canvas's project's
 * first. A page or a canvas becomes an entity when it is brought in.
 *
 * A search box opened where the canvas was right-clicked, so what is chosen
 * lands where the pointer already said. Drawn in the page rather than as a
 * browser picker — a picker is the browser's own chrome, which this canvas
 * never wears.
 */
import { useEffect, useState } from "react";
import { ask, where } from "../api.ts";
import type { Summary } from "../entities.ts";
import { KindMark } from "./EntityPanel.tsx";
import { PointerMenu } from "./PointerMenu.tsx";

/** What `/mentionables` answers (packages/core/src/mentionables.ts). */
interface Mentionable {
  id: string;
  title: string;
  kind: string;
  project?: string;
  projectName?: string;
  where?: string;
  here: boolean;
}

/** A row: an entity, or a page or a canvas that will be one. */
type Found = Summary & { place?: { kind: string; project?: string; where?: string }; detail?: string };

export function BringIn({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (s: Summary) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [at, setAt] = useState(0);

  useEffect(() => {
    const words = q.trim();
    if (!words) {
      setFound(null);
      return;
    }
    // A pause before asking, so a name typed quickly is one question.
    let live = true;
    const t = setTimeout(() => {
      const p = new URLSearchParams({ q: words, limit: "12", project: where.project });
      ask<Mentionable[]>("GET", `/mentionables?${p}`).then(
        (rows) => {
          if (!live) return;
          setFound((rows ?? []).map((m) => ({
            id: m.id, title: m.title, kinds: [m.kind],
            ...(m.id ? {} : { place: { kind: m.kind, project: m.project, where: m.where } }),
            ...(m.kind === "page" || m.kind === "canvas" ? { detail: m.here ? m.kind : `${m.kind} · ${m.projectName ?? ""}` } : {}),
          })));
          setAt(0);
        },
        () => live && setFound([]),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".cv-bringin")) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);

  const rows = found ?? [];
  // A page or a canvas with no entity yet is given one, then brought in as it.
  const pick = async (s: Found) => {
    if (s.id || !s.place) return onPick(s);
    try {
      const made = await ask<{ id: string }>("POST", "/entities/place", { ...s.place, title: s.title });
      onPick({ ...s, id: made.id, kinds: ["note"] });
    } catch {
      onClose();
    }
  };
  return (
    <PointerMenu x={x} y={y} className="menu cv-menu cv-bringin">
      <div className="cv-entity-panel">
        <input
          className="cv-entity-q"
          autoFocus
          placeholder="Bring in…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown" && rows.length) {
              e.preventDefault();
              setAt((i) => (i + 1) % rows.length);
            } else if (e.key === "ArrowUp" && rows.length) {
              e.preventDefault();
              setAt((i) => (i - 1 + rows.length) % rows.length);
            } else if (e.key === "Enter" && rows[at]) {
              e.preventDefault();
              void pick(rows[at]!);
            }
          }}
        />
        {found && found.length === 0 && <div className="hint cv-entity-none">None</div>}
        {rows.map((s, i) => (
          <button
            key={s.id || `${s.place?.project}/${s.place?.where}`}
            className={`menu-item cv-entity-row${i === at ? " active" : ""}`}
            onPointerEnter={() => setAt(i)}
            onClick={() => void pick(s)}
          >
            <KindMark kinds={s.kinds} />
            <span className="cv-entity-title-text">{s.title || "Untitled"}</span>
            {s.detail && <span className="hint">{s.detail}</span>}
          </button>
        ))}
      </div>
    </PointerMenu>
  );
}
