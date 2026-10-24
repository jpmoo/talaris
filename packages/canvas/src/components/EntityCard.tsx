// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * An entity card's face: the entity, drawn live and compact.
 *
 * Which face comes from the entity's profile — a task, an event, a contact, and
 * everything else as a note — never from its type's name. Drawn inside the
 * canvas's own node chrome, so a card moves, resizes, connects and takes a color
 * the way any note does; only what is written on it is different.
 *
 * Opening one is a double-click, handled in `main.tsx` with the canvas cards,
 * because it has to get there before the node's own double-click starts editing.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PointerMenu } from "./PointerMenu.tsx";
import {
  cardKind,
  plainMentions,
  setStatus,
  shortDay,
  statusLook,
  timeOf,
  useCardData,
  useTaskShape,
  type TaskShape,
} from "../cards.ts";
import type { Detail } from "../entities.ts";

/** "YYYY-MM-DD…" as a local day, not midnight in Greenwich. */
function localDate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function EntityCard({ entity, seen }: { entity: string; seen?: { title?: string; kind?: string } }) {
  const data = useCardData(entity);
  const detail = data && data !== "gone" ? data : null;
  const kind = detail ? cardKind(detail.kinds) : (seen?.kind ?? "note");
  const shape = useTaskShape(kind === "task");

  // Gone is drawn from what it last was, and says so, rather than vanishing —
  // the arrangement around it still meant something.
  if (data === "gone") {
    return (
      <div className="cv-card cv-card-gone">
        <div className="cv-card-title">{seen?.title || "Untitled"}</div>
        <div className="cv-card-meta">gone</div>
      </div>
    );
  }
  const title = detail?.title || seen?.title || "Untitled";
  const props = ((detail?.entity as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});

  if (kind === "task") return <TaskFace id={entity} title={title} props={props} shape={shape} />;
  if (kind === "event") return <EventFace title={title} props={props} detail={detail} />;
  if (kind === "contact") {
    const emails = Array.isArray(props.emails) ? (props.emails as unknown[]).map(str).filter(Boolean) : [];
    return (
      <div className="cv-card cv-card-person">
        <div className="cv-card-row">
          <span className="cv-card-avatar" style={{ background: avatarTint(entity) }}>{initials(title)}</span>
          <div className="cv-card-body">
            <div className="cv-card-title">{title}</div>
            {emails[0] && <div className="cv-card-meta">{emails[0]}</div>}
            {str(props.organization) && <div className="cv-card-meta">{str(props.organization)}</div>}
          </div>
        </div>
      </div>
    );
  }
  return <NoteFace title={title} body={str(props.body)} />;
}

/**
 * A task: its status as a circle, its title, and when it is due.
 *
 * The circle is the one control on any card. It takes its press for itself, so
 * pressing it does not also pick the card up, and the statuses it offers are
 * the type's own — options, labels and colors — rather than a done/not-done
 * this file would have to invent.
 */
function TaskFace({ id, title, props, shape }: { id: string; title: string; props: Record<string, unknown>; shape: TaskShape | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const value = shape ? str(props[shape.statusKey]) || shape.defaultStatus : "";
  const done = Boolean(shape && shape.complete.includes(value));
  const look = shape ? statusLook(shape, value) : { label: "", color: "var(--muted)" };
  const span = (shape?.spanKey ? props[shape.spanKey] : props.schedule) as { end?: string } | undefined;
  const due = str(span?.end);
  const options = shape?.status?.options ?? [];
  return (
    <div className={`cv-card cv-card-task${done ? " cv-card-done" : ""}`}>
      <div className="cv-card-row">
        <button
          className="cv-card-status"
          title={look.label}
          disabled={!shape || options.length === 0}
          style={{ borderColor: look.color, background: done ? look.color : "transparent" }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        />
        <div className="cv-card-title">{title}</div>
      </div>
      {due && <div className="cv-card-meta cv-card-indent">Due {shortDay(due)}</div>}
      {menu && shape && (
        <StatusMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={options.map((v) => ({ value: v, on: v === value, ...statusLook(shape, v) }))}
          onPick={(v) => {
            setMenu(null);
            if (v === value) return;
            setStatus(id, shape, v).catch((err) => {
              const host = window.parent as unknown as { talarisStatus?: (s: string) => void };
              host.talarisStatus?.(String((err as Error).message || err));
            });
          }}
        />
      )}
    </div>
  );
}

function StatusMenu({
  at,
  items,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  items: { value: string; label: string; color: string; on: boolean }[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".cv-card-menu")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  /*
   * A portal still bubbles through React's tree, so a press here would reach
   * the node underneath and pick it up, and a double-click would open it for
   * editing. Stopped at the menu's edge.
   */
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <PointerMenu x={at.x} y={at.y} className="menu cv-menu cv-card-menu">
      <div onPointerDown={stop} onDoubleClick={stop} onContextMenu={stop}>
        {items.map((s) => (
          <button key={s.value} className={`menu-item cv-card-option${s.on ? " active" : ""}`} onClick={() => onPick(s.value)}>
            <span className="cv-card-dot" style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
      </div>
    </PointerMenu>,
    document.body,
  );
}

/*
 * A person's mark: two letters, on a tint picked by the id rather than the
 * name, so renaming somebody does not repaint them. Each tint is a hue mixed
 * into the theme's surface, so it stays quiet in either mode.
 */
const TINTS = ["var(--accent)", "var(--danger)", "#6f93ad", "#7d9c6c", "#9c82b4", "#b39b5f"];

function avatarTint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `color-mix(in srgb, ${TINTS[Math.abs(h) % TINTS.length]} 45%, var(--surface))`;
}

/** First and last name's first letters; one word gives its first two; an address its local part. */
function initials(name: string): string {
  const words = name.split("@")[0]!.split(/[\s._-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return "?";
  const first = [...words[0]!];
  const pair = words.length > 1 ? first[0]! + [...words[words.length - 1]!][0]! : first.slice(0, 2).join("");
  return pair.toUpperCase();
}

/** An event: when, where, and who — the first few invitees by name. */
function EventFace({ title, props, detail }: { title: string; props: Record<string, unknown>; detail: Detail | null }) {
  const start = str(props.start);
  const end = str(props.end);
  let when = "";
  if (start) {
    const day = shortDay(start);
    if (props.allDay === true) {
      when = end && end.slice(0, 10) > start.slice(0, 10) ? `${day} – ${shortDay(end)} · All day` : `${day} · All day`;
    } else if (end && end.slice(0, 10) !== start.slice(0, 10)) {
      when = `${day} ${timeOf(start)} – ${shortDay(end)} ${timeOf(end)}`;
    } else {
      when = `${day} · ${timeOf(start)}${end ? ` – ${timeOf(end)}` : ""}`;
    }
  }
  const people = (detail?.out ?? []).filter((c) => c.name === "attendees").map((c) => c.entity.title || "Someone");
  const shown = people.slice(0, 4).join(", ") + (people.length > 4 ? ` +${people.length - 4}` : "");
  const day = localDate(start);
  return (
    <div className="cv-card cv-card-event">
      <div className="cv-card-row">
        {/* The day it falls on, as a calendar leaf; none when it has no start. */}
        {day && (
          <span className="cv-card-date">
            <span className="cv-card-month">{day.toLocaleDateString(undefined, { month: "short" })}</span>
            <span className="cv-card-day">{day.getDate()}</span>
          </span>
        )}
        <div className="cv-card-body">
          <div className="cv-card-title">{title}</div>
          {when && <div className="cv-card-meta">{when}</div>}
          {str(props.location) && <div className="cv-card-meta">{str(props.location)}</div>}
          {shown && <div className="cv-card-meta">{shown}</div>}
        </div>
      </div>
    </div>
  );
}

/** A note, or anything without a face of its own: the title and a few lines. */
function NoteFace({ title, body }: { title: string; body: string }) {
  const lines = plainMentions(body)
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|>)\s*/, "").trimEnd())
    .filter((l) => l.trim());
  // A note's title is often its first line; saying it twice is noise.
  if (lines[0] && lines[0].trim() === title.trim()) lines.shift();
  const excerpt: ReactNode = lines.slice(0, 4).join("\n");
  return (
    <div className="cv-card">
      <div className="cv-card-title">{title}</div>
      {lines.length > 0 && <div className="cv-card-excerpt">{excerpt}</div>}
    </div>
  );
}
