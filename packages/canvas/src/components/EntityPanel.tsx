/*
 * The two small panels an entity note opens: finding an entity to link to, and
 * listing what one is connected to. Both are drawn in the node menu's own
 * style, opened where the menu was, so they read as the menu's second page.
 */
import { Calendar, CheckSquare, FileText, Folder, User } from "lucide-react";
import { useEffect, useState } from "react";
import { entityDetail, findEntities, type Detail, type Summary } from "../entities.ts";

/*
 * One mark per kind, looked up by profile. An entity can carry more than one —
 * an event that is also a task — and the first in this list wins, which puts
 * the more specific kinds ahead of plain `note`.
 */
const MARKS = [
  ["contact", User, "Person"],
  ["event", Calendar, "Event"],
  ["task", CheckSquare, "Task"],
  ["project", Folder, "Project"],
  ["note", FileText, "Note"],
] as const;

export function KindMark({ kinds, size = 12 }: { kinds: string[]; size?: number }) {
  const mark = MARKS.find(([k]) => kinds.includes(k));
  if (!mark) return null;
  const [, Icon, name] = mark;
  return (
    <span className="cv-kind" title={name}>
      <Icon size={size} />
    </span>
  );
}

/** Pick an existing entity by name. */
export function EntitySearch({ onPick }: { onPick: (s: Summary) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Summary[] | null>(null);
  useEffect(() => {
    const words = q.trim();
    if (!words) {
      setFound(null);
      return;
    }
    // A pause before asking, so a name typed quickly is one question.
    let live = true;
    const t = setTimeout(() => {
      findEntities(words).then(
        (rows) => live && setFound(rows),
        () => live && setFound([]),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <div className="cv-entity-panel">
      <input
        className="cv-entity-q"
        autoFocus
        placeholder="Find…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && found?.[0]) onPick(found[0]);
        }}
      />
      {found && found.length === 0 && <div className="hint cv-entity-none">None</div>}
      {found?.map((s) => (
        <button key={s.id} className="menu-item cv-entity-row" onClick={() => onPick(s)}>
          <KindMark kinds={s.kinds} />
          <span className="cv-entity-title-text">{s.title || "Untitled"}</span>
        </button>
      ))}
    </div>
  );
}

/** One thing to put on the canvas, and which way the line between them runs. */
export interface Placement {
  entity: Summary;
  /** True when the source entity points at this one; false when it points back. */
  outgoing: boolean;
}

/**
 * What an entity is connected to, grouped by the name of the link.
 *
 * Outgoing groups are called by their field — "attendees", "organizer" — and
 * incoming ones say so, "In: attendees", which is how a person's panel reads
 * as the events they were at.
 */
export function EntityConnections({ id, onPlace }: { id: string; onPlace: (rows: Placement[]) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    entityDetail(id).then(
      (d) => live && setDetail(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (failed) return <div className="hint cv-entity-none">Couldn't load</div>;
  if (!detail) return <div className="hint cv-entity-none">…</div>;

  const groups = new Map<string, Placement[]>();
  const add = (label: string, p: Placement) => {
    const g = groups.get(label) ?? [];
    g.push(p);
    groups.set(label, g);
  };
  for (const c of detail.out) add(c.name, { entity: c.entity, outgoing: true });
  for (const c of detail.in) add(`In: ${c.name}`, { entity: c.entity, outgoing: false });

  // Placing everything places each entity once, however many ways it is
  // connected: an organizer is usually an attendee too.
  const all = [...new Map([...groups.values()].flat().map((p) => [p.entity.id, p])).values()];

  return (
    <div className="cv-entity-panel">
      <div className="cv-entity-head">
        <KindMark kinds={detail.kinds} />
        <span className="cv-entity-title-text">{detail.title || "Untitled"}</span>
        {all.length > 0 && (
          <button className="seg cv-entity-place" onClick={() => onPlace(all)}>
            Place all
          </button>
        )}
      </div>
      {all.length === 0 && <div className="hint cv-entity-none">No connections</div>}
      {[...groups.entries()].map(([label, rows]) => (
        <div key={label}>
          <div className="menu-sep" />
          <div className="hint" style={{ padding: "4px 10px" }}>{label}</div>
          {rows.map((p) => (
            <div key={p.entity.id} className="cv-entity-row">
              <KindMark kinds={p.entity.kinds} />
              <span className="cv-entity-title-text">{p.entity.title || "Untitled"}</span>
              <button className="seg cv-entity-place" onClick={() => onPlace([p])}>
                Place
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
