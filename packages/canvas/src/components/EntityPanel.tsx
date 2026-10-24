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
 * What an entity is connected to, grouped by what each thing is — people,
 * events, tasks, notes — newest first, each saying how it is linked ("invited",
 * "mentioned in"). Twenty of each at first, then more, or all: a person who
 * has been to three hundred meetings is a long list, and the latest are the
 * ones looked for.
 */
const GROUP: Record<string, string> = { contact: "People", event: "Events", task: "Tasks", note: "Notes", project: "Projects" };
const BACK: Record<string, string> = { mentions: "mentioned in", attendees: "invited to", organizer: "organizer of", project: "filed here" };
const OUT: Record<string, string> = { mentions: "mentioned", attendees: "invited", organizer: "organizer", project: "project" };
const FIRST = 20;
const words = (key: string) => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

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

  // Each thing once, however many ways it is connected (an organizer is
  // usually an attendee too), with every way said.
  const byId = new Map<string, Placement & { how: string[] }>();
  const add = (p: Placement, how: string) => {
    const had = byId.get(p.entity.id);
    if (had) {
      if (!had.how.includes(how)) had.how.push(how);
    } else byId.set(p.entity.id, { ...p, how: [how] });
  };
  for (const c of detail.out) add({ entity: c.entity, outgoing: true }, OUT[c.name] ?? words(c.name));
  for (const c of detail.in) add({ entity: c.entity, outgoing: false }, BACK[c.name] ?? `${words(c.name)} of`);
  const all = [...byId.values()];
  const groups = new Map<string, (Placement & { how: string[] })[]>();
  for (const p of all) {
    const g = GROUP[p.entity.kinds.find((k) => GROUP[k]) ?? ""] ?? "Other";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const newest = (x: { entity: { updated?: string } }) => x.entity.updated ?? "";
  for (const rows of groups.values()) rows.sort((a, b) => newest(b).localeCompare(newest(a)));
  const order = [...new Set(Object.values(GROUP)), "Other"].filter((g) => groups.has(g));

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
      {order.map((label) => (
        <Group key={label} label={label} rows={groups.get(label)!} onPlace={onPlace} />
      ))}
    </div>
  );
}

function Group({ label, rows, onPlace }: { label: string; rows: (Placement & { how: string[] })[]; onPlace: (rows: Placement[]) => void }) {
  const [shown, setShown] = useState(FIRST);
  const left = rows.length - shown;
  return (
    <div>
      <div className="menu-sep" />
      <div className="hint" style={{ padding: "4px 10px" }}>{`${label} · ${rows.length}`}</div>
      {rows.slice(0, shown).map((p) => (
        <div key={p.entity.id} className="cv-entity-row">
          <KindMark kinds={p.entity.kinds} />
          <span className="cv-entity-title-text">{p.entity.title || "Untitled"}</span>
          <span className="hint">{p.how.join(", ")}</span>
          <button className="seg cv-entity-place" onClick={() => onPlace([p])}>
            Place
          </button>
        </div>
      ))}
      {left > 0 && (
        <div style={{ display: "flex", gap: 6, padding: "4px 10px" }}>
          <button className="seg" onClick={() => setShown((n) => n + FIRST)}>{`${Math.min(FIRST, left)} more`}</button>
          {left > FIRST && <button className="seg" onClick={() => setShown(rows.length)}>{`All ${rows.length}`}</button>}
        </div>
      )}
    </div>
  );
}

