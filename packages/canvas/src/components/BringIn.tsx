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
 *
 * With a `kind` it is the Person, Event, Task or Note tool's search instead:
 * only things of that kind, and a last row that makes a new one from what was
 * typed. People are also found in the address books, the way an @ finds them
 * (surfaces/ui/mentions.js) — one already a person here shows as that person,
 * and one who is not is made by address, so never made twice. A note is a
 * writing page (or a note entity); a new one is a page in this project. A new
 * task is filed under this project.
 *
 * What is tied to this canvas's project comes first, and says so (the core's
 * `near`, glance.ts): before anything is typed, the search already lists it.
 */
import { useEffect, useState } from "react";
import { ask, where } from "../api.ts";
import { findEntities, type Summary } from "../entities.ts";
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

/** A row: an entity, or a page or a canvas that will be one, or a person or an event to be made. */
type Found = Summary & {
  place?: { kind: string; project?: string; where?: string };
  detail?: string;
  make?: () => Promise<{ id: string }>;
  /** The New row, made from what was typed. */
  fresh?: boolean;
  /** Tied to this project. */
  near?: boolean;
};

/** What the Person, Event, Task and Note tools look for: a profile name. */
export type BringKind = "contact" | "event" | "task" | "note";

const NEW_ROW: Record<BringKind, string> = { contact: "New person: ", event: "New event (not on a calendar): ", task: "New task: ", note: "New page: " };
const PLACEHOLDER: Record<BringKind, string> = { contact: "Person…", event: "Event…", task: "Task…", note: "Note or page…" };

/** This project's own entity, which a task made here is filed under. */
let projectEntity: Promise<string | undefined> | null = null;
const thisProject = () =>
  (projectEntity ??= ask<{ id: string } | null>("GET", `/entities/by-source?kind=talaris-project&key=${encodeURIComponent(where.project)}`).then(
    (e) => e?.id,
    () => undefined,
  ));

/** Notes: this project's pages first (an @'s search), and note entities that are not a place. */
async function findNotes(words: string): Promise<Found[]> {
  const p = new URLSearchParams({ q: words, limit: "20", project: where.project });
  const rows = await ask<Mentionable[]>("GET", `/mentionables?${p}`).catch(() => [] as Mentionable[]);
  return (rows ?? [])
    .filter((m) => m.kind === "page" || m.kind === "note")
    .slice(0, 10)
    .map((m) => ({
      id: m.id, title: m.title, kinds: [m.kind === "page" ? "note" : m.kind], near: m.here,
      ...(m.id ? {} : { place: { kind: m.kind, project: m.project, where: m.where } }),
      ...(m.kind === "page" && !m.here ? { detail: m.projectName ?? "" } : {}),
    }));
}

/** "YYYY-MM-DDTHH:MM", local. */
const local = (d: Date) => {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
};

/*
 * Existing people or events by name. People also from the address books, by
 * name or the address before its @ — "sch" is Schutt, not everyone at a school
 * district — and a name that is itself an address counts as none.
 */
async function findOfKind(words: string, kind: BringKind): Promise<Found[]> {
  if (kind === "note") return findNotes(words);
  let [out, people] = await Promise.all([
    findEntities(words, kind, where.project).then((rows) => (rows ?? []).slice(0, 10) as Found[]),
    kind === "contact" && words.length >= 2
      ? ask<{ name?: string; email: string }[]>("GET", `/people/find?q=${encodeURIComponent(words)}`).catch(() => [])
      : Promise.resolve([]),
  ]);
  const q = words.toLowerCase();
  people = (people ?? [])
    .map((p) => ({ email: p.email, name: p.name && !p.name.includes("@") ? p.name : "" }))
    .filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().split("@")[0]!.includes(q));
  if (!people.length) return out;
  const known = await ask<Record<string, Summary>>("POST", "/entities/people/known", { emails: people.map((p) => p.email) }).catch(
    () => ({}) as Record<string, Summary>,
  );
  const have = new Set(out.map((f) => f.id));
  const extra: Found[] = [];
  for (const p of people) {
    const k = known[p.email.toLowerCase()];
    if (k) {
      if (!have.has(k.id)) {
        have.add(k.id);
        extra.push({ ...k, kinds: k.kinds?.length ? k.kinds : ["contact"] });
      }
      continue;
    }
    extra.push({
      id: "", title: p.name || p.email, kinds: ["contact"], detail: p.name ? p.email : "address book",
      make: () => ask<{ id: string }>("POST", "/entities/person", { email: p.email, name: p.name || undefined }),
    });
  }
  return [...out.slice(0, 4), ...extra, ...out.slice(4)].slice(0, 10);
}

/*
 * The last row: one made from what was typed. An event made here is an entity
 * and not on any calendar, which the row says rather than let it be assumed;
 * it starts at the next whole hour, for an hour, so its card has a day.
 */
function newRow(words: string, kind: BringKind): Found {
  if (kind === "task") {
    return {
      id: "", title: words, kinds: ["task"], fresh: true,
      make: async () => {
        const project = await thisProject();
        return ask<{ id: string }>("POST", "/tasks", { title: words, ...(project ? { projects: [project] } : {}) });
      },
    };
  }
  if (kind === "note") {
    return {
      id: "", title: words, kinds: ["note"], fresh: true,
      make: async () => {
        const page = await ask<{ path: string; title: string }>("POST", `/projects/${encodeURIComponent(where.project)}/pages`, { parent: null, title: words });
        return ask<{ id: string }>("POST", "/entities/place", { kind: "page", project: where.project, where: page.path, title: page.title });
      },
    };
  }
  if (kind === "contact") {
    return {
      id: "", title: words, kinds: ["contact"], fresh: true,
      make: () => ask<{ id: string }>("POST", "/entities", { role: "person", properties: { title: words } }),
    };
  }
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start.getTime() + 3_600_000);
  return {
    id: "", title: words, kinds: ["event"], fresh: true,
    make: () => ask<{ id: string }>("POST", "/entities", { role: "event", properties: { title: words, start: local(start), end: local(end) } }),
  };
}

export function BringIn({
  x,
  y,
  kind,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  kind?: BringKind;
  onPick: (s: Summary) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [at, setAt] = useState(0);

  useEffect(() => {
    const words = q.trim();
    // A tool's search lists what is near before anything is typed; Bring in waits for words.
    if (!words && !kind) {
      setFound(null);
      return;
    }
    // A pause before asking, so a name typed quickly is one question.
    let live = true;
    const t = setTimeout(() => {
      if (kind) {
        findOfKind(words, kind).then(
          (rows) => {
            if (!live) return;
            setFound(words ? [...rows, newRow(words, kind)] : rows);
            setAt(0);
          },
          () => live && setFound(words ? [newRow(words, kind)] : []),
        );
        return;
      }
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
    }, words ? 180 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, kind]);

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
    if (s.make) {
      try {
        const made = await s.make();
        return onPick({ id: made.id, title: s.title, kinds: s.kinds });
      } catch {
        return onClose();
      }
    }
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
          placeholder={kind ? PLACEHOLDER[kind] : "Bring in…"}
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
        {found && found.length === 0 && <div className="hint cv-entity-none">{q.trim() ? "None" : "Nothing tied to this project yet — type to find"}</div>}
        {rows.map((s, i) => (
          <button
            key={s.id || (s.place ? `${s.place.project}/${s.place.where}` : `${s.fresh ? "+" : s.detail}/${s.title}`)}
            className={`menu-item cv-entity-row${i === at ? " active" : ""}`}
            onPointerEnter={() => setAt(i)}
            onClick={() => void pick(s)}
          >
            <KindMark kinds={s.kinds} />
            <span className="cv-entity-title-text">
              {s.fresh && kind ? NEW_ROW[kind] : ""}
              {s.title || "Untitled"}
            </span>
            {s.detail ? <span className="hint">{s.detail}</span> : s.near && kind ? <span className="hint">this project</span> : null}
          </button>
        ))}
      </div>
    </PointerMenu>
  );
}
