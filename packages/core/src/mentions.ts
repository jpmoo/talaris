// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

import { allRecords, bySource, createEntity, getEntity, onChange, setInlineRelations, typeFor, types, updateEntity, type Entity } from "./entities.js";

/**
 * Mentions: a person, a task, an event — anything — named inside text, by
 * `@` and the picker (the editor's, everywhere text is written).
 *
 * **In the text** a mention is an ordinary Markdown link,
 * `[@Chuck Smith](talaris:e_…)`: a page opened in another editor still reads
 * "@Chuck Smith", and the prose is kept as written (the format's rule — prose
 * is opaque, and never rewritten). Hermes writes the same shape with its own
 * scheme (`block:`), so a sync translates one to the other.
 *
 * **In the graph** each mention is also an edge, `mentions`, `via: "inline"`,
 * naming the field it was written in — the format's inline references, which
 * a tool that cannot read this dialect still holds. They are kept in step with
 * the text on every change: a mention deleted from a sentence is an edge gone.
 */

const MENTION = () => /\[([^\]\n]*)\]\(talaris:([A-Za-z0-9_-]+)\)/g;

/** Every entity a text names, in order, once each. */
export function mentionsIn(text: string): { id: string; label: string }[] {
  const out = new Map<string, string>();
  const re = MENTION();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (!out.has(m[2]!)) out.set(m[2]!, m[1]!);
  return [...out].map(([id, label]) => ({ id, label }));
}

/** A text with its mentions as the words they show: for a title read aloud, sorted, searched. */
export function plain(text: string): string {
  return text.replace(MENTION(), (_m, label: string) => label);
}

/** The mentions an entity's text holds, by the declared field each is in. */
function inlineOf(o: Entity): { to: string; field: string }[] {
  const t = types().find((x) => x.id === o.type);
  const declared = new Set((t?.fields ?? []).map((f) => f.key));
  const out: { to: string; field: string }[] = [];
  for (const [field, v] of Object.entries(o.properties)) {
    // The format: an inline edge names a field the type declares.
    if (typeof v !== "string" || !declared.has(field)) continue;
    for (const m of mentionsIn(v)) if (m.id !== o.id) out.push({ to: m.id, field });
  }
  return out;
}

const known = (id: string) => { try { getEntity(id); return true; } catch { return false; } };

onChange((_before, after) => {
  // One whose words live elsewhere has its edges set from there (syncText).
  if (after["talaris:textElsewhere"]) return;
  setInlineRelations(after.id, inlineOf(after).filter((e) => known(e.to)));
});

/** Every entity's mentions read again (after a revival, say): the edges agree with the text. */
export function remirror(): void {
  for (const r of allRecords()) if (!r.object["talaris:textElsewhere"]) setInlineRelations(r.object.id, inlineOf(r.object).filter((e) => known(e.to)));
}

/**
 * Text that lives outside the store — a writing page (its file), a canvas
 * note (its canvas) — and mentions things: an entity of its own stands for it,
 * known by where the text is (`source`), holding the mentions as its edges.
 * Its words stay where they live (`talaris:textElsewhere`), so the edges are
 * set from the text given here, not read from the entity. Made the first time
 * there is a mention to hold; kept, edges emptied, when the mentions go.
 * Answers the entity's id, or null when there is none.
 */
export function syncText(source: { kind: string; key: string }, title: string, text: string): string | null {
  const found = mentionsIn(text).filter((m) => known(m.id));
  let e = bySource(source);
  if (!e && !found.length) return null;
  if (!e) e = createEntity({ type: typeFor("note").id, properties: { title: title.slice(0, 120) }, sources: [source], "talaris:textElsewhere": true });
  else if (e.properties.title !== title.slice(0, 120)) e = updateEntity(e.id, { properties: { title: title.slice(0, 120) } });
  setInlineRelations(e.id, found.filter((m) => m.id !== e!.id).map((m) => ({ to: m.id, field: "body" })));
  return e.id;
}

/** Where a text lives moved (a page renamed): its entity is known by the new place. */
export function movedText(from: { kind: string; key: string }, to: { kind: string; key: string }): void {
  const e = bySource(from);
  if (!e) return;
  const sources = ((e["talaris:sources"] as { kind: string; key: string }[]) ?? []).filter((s) => !(s.kind === from.kind && s.key === from.key));
  updateEntity(e.id, { "talaris:sources": [...sources, to] });
}
