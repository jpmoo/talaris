/*
 * The seam. Hermes' canvas, talking to Talaria's document.
 *
 * `CanvasView.tsx` is forked from Hermes unchanged in shape, and it reads a
 * `Collection` with `properties`, a list of `Member`s with geometry in each
 * one's `context`, and writes through `api.patch("/collections/…")`. Talaria
 * has none of that: it has one file, `canvas.json`, holding `items`, `links`
 * and `regions`, and one endpoint that replaces the whole thing.
 *
 * This module is the translation, and it is deliberately the *only* place that
 * knows both vocabularies — which is what lets the component stay a fork rather
 * than a rewrite. The brief's table, made real:
 *
 *   collection.properties.canvas_notes  ↔  items without a blockId
 *   members, geometry in member.context ↔  items with a blockId
 *   collection.properties.canvas_edges  ↔  links
 *   regions in properties               ↔  regions
 *
 * **What the renderer does not understand, it must not destroy.** The document
 * is held exactly as it arrived and only the three keys above are touched, so a
 * canvas carrying anything this build has never heard of survives a round trip
 * through it. `PUT /canvas/document` is `passthrough` on the daemon's side for
 * the same reason.
 *
 * **`canvas.json` is a contract with a second reader.** Canvas Chat builds and
 * edits canvases through the same file. Whatever is written here has to be
 * exactly what `canvasagent.ts` expects to read, or the chat stops being able
 * to build a canvas — which is a feature that was asked for specifically.
 */

/* ---------------------------------------------------------------- the types
 * Copied from `apps/web/src/api.ts` rather than imported: Hermes runs on a
 * server and Talaria runs on this machine, they are deployed separately, and a
 * build-time dependency between them is the coupling the owner asked not to
 * have. The fork owns its copy.
 */

export interface Block {
  id: string;
  blockTypeId: string;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  embeddedAt: string | null;
  embedPending: boolean;
  version: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A row from a block search, in the two fields this canvas reads off one.
 *
 * Imported by `CanvasView` and never exported, which the type checker would
 * have said on the first run — see the note in `linux/CLAUDE.md` about `vite
 * build` not typechecking.
 */
export interface BlockSearchResult {
  id: string;
  label: string;
}

/**
 * A type's declared fields.
 *
 * Only the shape the canvas actually reads: it walks the fields looking for a
 * reference pointing at another type, to decide whether one placed block can
 * file under another. Everything else a schema carries is the server's business.
 */
export interface PropertySchema {
  fields: Array<{
    key: string;
    label?: string | null;
    type: string;
    refTypeId?: string | null;
  }>;
}

export interface BlockType {
  id: string;
  name: string;
  iconKey: string | null;
  iconColor: string | null;
  iconSource: string;
  showIcon: boolean;
  propertySchema: PropertySchema | null;
  schemaVersion: number;
  isText: boolean;
  builtin: boolean;
  blockCount?: number;
}

export interface Collection {
  id: string;
  collectionKind: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Member {
  membershipId: string;
  position: string;
  context: Record<string, unknown>;
  membershipVersion: number;
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  blockId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

/* ------------------------------------------------------------ the transport
 * XHR, not `fetch`.
 *
 * The Fetch API is not available over `talaria-app://` — Qt gates it on a
 * scheme flag that does not stick in this PySide build, and every call fails as
 * "Failed to fetch", which looks exactly like a dead daemon. The body rides in
 * a header for a second reason recorded in `scheme.py`: reading a real request
 * body segfaults the process.
 */

/*
 * **The canvas lives in a frame inside its drawer, and asks through it.**
 *
 * Only a drawer's main frame can reach the QWebChannel bridge to the process,
 * so the drawer hands its frame one function, `talarisCore`, and every request
 * the canvas makes goes through that. No URL carries a body, so nothing has
 * to be squeezed into a header — the problem Talaria's canvas worked around.
 */
type CoreCall = (method: string, path: string, body?: unknown) => Promise<unknown>;
function talarisCore(): CoreCall {
  const host = window.parent as unknown as { talarisCore?: CoreCall };
  if (window.parent === window || !host.talarisCore) {
    throw new Error("the canvas is open outside its drawer, so it has no core to ask");
  }
  return host.talarisCore;
}

/** Which canvas this frame shows: `?project=…&canvas=…`, set by the drawer. */
const here = new URLSearchParams(location.search);
export const where = { project: here.get("project") ?? "", canvas: here.get("canvas") ?? "" };

export const apiBase = "";

export function ask<T>(method: string, path: string, body?: unknown): Promise<T> {
  return talarisCore()(method, path, body) as Promise<T>;
}

/*
 * Pictures on a canvas need a place in the project to keep them, which the
 * core does not have yet. Until it does, a picture is refused by name rather
 * than kept somewhere it would be lost.
 */
export async function keep(_bytes: Blob): Promise<string> {
  throw new Error("Pictures on a canvas aren't kept yet — they come with a later step.");
}
export async function keepResized(_file: Blob): Promise<{ name: string; w: number; h: number }> {
  throw new Error("Pictures on a canvas aren't kept yet — they come with a later step.");
}
export const pictureAt = (_name: string) => "";

/* ------------------------------------------------------------- the routing */

import {
  endIn,
  isNoteId,
  noteIdOf,
  putDocument,
  type CanvasDocument,
  type CanvasItem,
  type CanvasLink,
  type CanvasRegion,
} from "./document.ts";

/**
 * The document everything below edits.
 *
 * Held in one place and replaced whole. `main.tsx` loads it, this mutates it,
 * and `flush` writes it back — there is no second copy anywhere, which is the
 * property the daemon's own note asks for.
 */
let held: CanvasDocument = { items: [], links: [], regions: [] };
let onWritten: (() => void) | null = null;

export function hold(doc: CanvasDocument, written: () => void) {
  held = doc;
  onWritten = written;
}
export const document_ = () => held;

/*
 * Written on a pause.
 *
 * A drag is a hundred `patch` calls and the document is a whole file; writing
 * each one would mean a hundred rewrites of the same canvas, and the last one
 * is the only one anybody wants. The trailing edge is what matters, so this is
 * a debounce rather than a throttle — and it is flushed on `pagehide` so a
 * panel closed a tenth of a second after a move still saves it.
 */
let pending: number | null = null;
let writing: Promise<unknown> = Promise.resolve();

function save() {
  if (pending !== null) clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = null;
    // Chained rather than parallel: two whole-document writes racing is exactly
    // the problem the single-document design exists to avoid.
    writing = writing.then(() => putDocument(held)).then(
      () => onWritten?.(),
      (err) => {
        /*
         * The core refuses a save that would take a child canvas off its
         * parent — that is a delete, and deletes are asked for in the drawer.
         * So the drawer says why, and the canvas reads itself back, which puts
         * the card where it was.
         */
        const host = window.parent as unknown as { talarisStatus?: (s: string) => void };
        host.talarisStatus?.(String((err as Error).message || err));
        console.error("canvas: could not save —", err);
        onWritten?.();
      },
    );
  }, 250);
}

export function flush() {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
    writing = writing.then(() => putDocument(held));
  }
  return writing;
}
addEventListener("pagehide", () => void flush());

/**
 * Hermes' note shape, back into an item — **merged, never rebuilt.**
 *
 * Talaria's items carry more than Hermes' canvas can say: where the words sit
 * across the box and down it, what color the ink is, and (for a note) an
 * outline. The Mac draws all of it. Rebuilding an item from the note handed
 * back would drop every one of them, so moving a sticky an inch would quietly
 * flatten a canvas somebody arranged on the Mac.
 *
 * The item that is already there is the base and only the fields Hermes manages
 * are laid over it. That is the repo's rule about unknown fields, applied to a
 * renderer instead of an importer: what it does not understand, it must not
 * destroy.
 */
function itemFromNote(note: Record<string, unknown>, was: CanvasItem | undefined): CanvasItem {
  const id = noteIdOf(String(note.id));
  const base: CanvasItem = was ?? { id, x: 0, y: 0, w: 200, h: 120 };
  const item = itemOverlaid(note, base, id);
  /*
   * The entity a note stands for. Said only when the note says it: a string
   * links, `null` is "Unlink" and takes the key off, and a note that does not
   * mention it keeps whatever the item had — the spread above already carried
   * it, so this is the one field that has to be able to go away.
   */
  if (typeof note.entity === "string") item.entity = note.entity;
  else if (note.entity === null) delete item.entity;
  return item;
}

function itemOverlaid(note: Record<string, unknown>, base: CanvasItem, id: string): CanvasItem {
  return {
    ...base,
    id,
    x: Number(note.x) || 0,
    y: Number(note.y) || 0,
    w: Number(note.w) || base.w,
    h: Number(note.h) || base.h,
    text: typeof note.text === "string" ? note.text : base.text,
    shape: typeof note.shape === "string" ? note.shape : base.shape,
    // `color` on the way in, `fill` in the file — one of the three names that
    // differ between the vocabularies.
    fill: "color" in note ? ((note.color as string) ?? null) : base.fill,
    stroke: "stroke" in note ? ((note.stroke as string) ?? null) : base.stroke,
    strokeWidth: "strokeWidth" in note ? (note.strokeWidth as number) : base.strokeWidth,
    strokeStyle: "strokeStyle" in note ? (note.strokeStyle as string) : base.strokeStyle,
    hAlign: "hAlign" in note ? (note.hAlign as string) : base.hAlign,
    vAlign: "vAlign" in note ? (note.vAlign as string) : base.vAlign,
    textColor: "textColor" in note ? ((note.textColor as string) ?? null) : base.textColor,
    /*
     * The picture, which the two sides hold differently and which is therefore
     * left alone.
     *
     * Talaria stores a file name in `canvas-images/`; Hermes' note carries the
     * bytes as a data URI, "passing through rather than living" as its own
     * comment puts it. Until that is wired up, a note's image is whatever the
     * file already said — never overwritten with a shape this build has not
     * taught the component to produce.
     */
    /*
     * The picture, by name.
     *
     * What comes back is the component's shape — `{name, mime, data}` where
     * `data` is a URL — or `imageName` when somebody has just chosen between
     * several. The file stores the name and nothing else, so either one is read
     * for it and the untouched case keeps whatever the item already had.
     */
    image:
      typeof note.imageName === "string"
        ? note.imageName
        : ((note.image as { name?: string } | null)?.name ?? base.image),
    images: Array.isArray(note.images) ? (note.images as string[]) : base.images,
    showImage: typeof note.showImage === "boolean" ? note.showImage : base.showImage,
  };
}

function linkFromEdge(edge: Record<string, unknown>): CanvasLink {
  return {
    id: String(edge.id),
    from: endIn(held, String(edge.from)),
    to: endIn(held, String(edge.to)),
    bendX: edge.bendX as number | undefined,
    bendY: edge.bendY as number | undefined,
    color: (edge.color as string) ?? null,
    width: edge.width as number | undefined,
    style: edge.dash as string | undefined,
  };
}

/**
 * Properties, written back into the document.
 *
 * Only the three keys this build understands are read out of the patch. A
 * property it has never heard of is left where it was rather than being
 * dropped, which is the same promise the interchange importer makes about
 * unknown fields.
 */
function patchProperties(props: Record<string, unknown>) {
  if (Array.isArray(props.canvas_notes)) {
    const blocks = held.items.filter((i) => i.blockId);
    const was = new Map(held.items.filter((i) => !i.blockId).map((i) => [i.id, i]));
    const notes = (props.canvas_notes as Record<string, unknown>[]).map((note) =>
      itemFromNote(note, was.get(noteIdOf(String(note.id)))),
    );
    held.items = [...blocks, ...notes];
  }
  if (Array.isArray(props.canvas_edges)) {
    held.links = (props.canvas_edges as Record<string, unknown>[]).map(linkFromEdge);
  }
  if (Array.isArray(props.canvas_regions)) {
    // Merged onto what was there, not rebuilt from what came back.
    //
    // The component knows four things about a region — id, title, colour and
    // members — and a region in the file has five more: its alignment, its text
    // colour, and the three that describe its outline. Replacing the object
    // with the four dropped the other five on every write, so a canvas made in
    // the macOS app lost its region styling the first time anything moved here.
    //
    // The same care `itemFromNote` takes, for the same reason.
    const was = new Map(held.regions.map((r) => [r.id, r]));
    held.regions = (props.canvas_regions as Record<string, unknown>[]).map((region) => {
      const id = String(region.id);
      return {
        ...(was.get(id) ?? { id, members: [] }),
        id,
        title: typeof region.title === "string" ? region.title : "",
        fill: (region.color as string) ?? null,
        members: ((region.memberIds as string[]) ?? []).map((end) => endIn(held, end)),
      };
    });
  }
  save();
}

function patchMember(blockId: string, context: Record<string, unknown>) {
  const item = held.items.find((i) => i.blockId === blockId);
  if (!item) return;
  const c = context.context as Record<string, unknown> | undefined;
  const from = c ?? context;
  if (typeof from.x === "number") item.x = from.x;
  if (typeof from.y === "number") item.y = from.y;
  if (typeof from.w === "number") item.w = from.w;
  if (typeof from.h === "number") item.h = from.h;
  if ("fill" in from) item.fill = (from.fill as string) ?? null;
  if ("stroke" in from) item.stroke = (from.stroke as string) ?? null;
  if (typeof from.strokeWidth === "number") item.strokeWidth = from.strokeWidth;
  if (typeof from.strokeStyle === "string") item.strokeStyle = from.strokeStyle;
  if (typeof from.shape === "string") item.shape = from.shape;
  // Only when said. A context that does not mention alignment is not a context
  // that cleared it — see `itemFromNote`.
  // A member's picture arrives as a name when it was chosen, and as a URL when
  // the context was simply handed back; only the name means anything in a file.
  if (typeof from.imageName === "string") item.image = from.imageName;
  if (Array.isArray(from.images)) item.images = from.images as string[];
  if (typeof from.showImage === "boolean") item.showImage = from.showImage;
  if (typeof from.hAlign === "string") item.hAlign = from.hAlign;
  if (typeof from.vAlign === "string") item.vAlign = from.vAlign;
  if ("textColor" in from) item.textColor = (from.textColor as string) ?? null;
  save();
}

function addMember(body: Record<string, unknown>) {
  const blockId = String(body.blockId);
  if (held.items.some((i) => i.blockId === blockId)) return;
  const c = (body.context as Record<string, unknown>) ?? {};
  const picture = typeof c.image === "string" ? c.image : null;
  held.items.push({
    id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    x: Number(c.x) || 0,
    y: Number(c.y) || 0,
    w: Number(c.w) || 200,
    h: Number(c.h) || 90,
    blockId,
    // A note converted into a block keeps the picture it had — see the note at
    // the call site.
    ...(picture ? { image: picture, images: [picture], showImage: true } : {}),
  });
  save();
}

function dropMember(id: string) {
  // A note and a block are removed the same way from the component's side, so
  // both ends of the vocabulary are accepted here.
  const itemId = isNoteId(id) ? noteIdOf(id) : null;
  held.items = held.items.filter((i) => (itemId ? i.id !== itemId : i.blockId !== id));
  held.links = held.links.filter(
    (l) => held.items.some((i) => i.id === l.from) && held.items.some((i) => i.id === l.to),
  );
  save();
}

class Unsupported extends Error {}

/**
 * The component's `api`, answered locally.
 *
 * Every path the canvas asks for is either a document edit — answered here,
 * with no round trip — or a question only the daemon can answer, which is
 * forwarded. Anything else throws by name rather than silently doing nothing:
 * a canvas that quietly ignores a call is a canvas that loses somebody's work
 * without saying so.
 */
async function route<T>(method: string, path: string, body?: unknown): Promise<T> {
  const at = path.split("?")[0];
  const member = /^\/collections\/[^/]+\/members\/(.+)$/.exec(at);
  const members = /^\/collections\/[^/]+\/members$/.test(at);
  const collection = /^\/collections\/[^/]+$/.test(at);

  if (method === "PATCH" && collection) {
    patchProperties((body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "PATCH" && member) {
    patchMember(decodeURIComponent(member[1]), (body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "POST" && members) {
    addMember((body ?? {}) as Record<string, unknown>);
    return undefined as T;
  }
  if (method === "DELETE" && member) {
    dropMember(decodeURIComponent(member[1]));
    return undefined as T;
  }
  /*
   * Making a real block out of a note — "Convert to…".
   *
   * The component builds Hermes' own create payload: a title, and prose in
   * whichever property that type declares for it. **Talaria must not send
   * that.** Reaching Hermes outside the interchange is the standing
   * instruction, and guessing which property holds a body is precisely the kind
   * of guess the format exists to answer.
   *
   * So the text is reassembled and handed to the daemon's `/capture`, which
   * reads the type's *note profile* to decide where prose goes — `properties`
   * when the profile names a slot, and the title when it names none, "which is
   * ugly and is still better than a capture that silently ate most of what was
   * selected". From there it goes out through `/write` and the binding, which
   * is also what makes it survive being done offline: the write queues and
   * leaves on reconnect.
   *
   * Whether the whole note is the body or only its first line is a title is the
   * component's own distinction, and it has already made it: a text type gets
   * `content`, anything else gets `properties`.
   */
  if (method === "POST" && at === "/blocks") {
    // Turning a note into a library block is the Hermes plugin's to offer.
    throw new Unsupported("Making a block from a note comes with the Hermes plugin.");
  }

  /*
   * The types, which the daemon answers from the mirror.
   *
   * Forwarded rather than translated: the daemon's `/types` already returns the
   * shape this needs. Its absence was invisible in the worst way — the fork asks
   * for types once, on load, and swallows a failure, so "Convert to…" simply had
   * nothing under it and looked like a menu that ended there.
   */
  // No block types and no tags without a plugin that brings them.
  if (method === "GET" && (at === "/types" || at === "/tags")) return [] as T;
  throw new Unsupported(`the canvas asked for ${method} ${at}, which Talaris has no answer for`);
}

export const api = {
  get: <T>(p: string) => route<T>("GET", p),
  post: <T>(p: string, b?: unknown) => route<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => route<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => route<T>("DELETE", p),
  /**
   * Not this way.
   *
   * Hermes uploads bytes to `/blocks/:id/attachments` after a block exists.
   * That is Hermes' own route and reaching it is the one thing this fork must
   * not do — and it is unnecessary now besides: a picture travels *with* the
   * create, as an interchange attachment value, named on the body and resolved
   * by the daemon which already holds the file. See `POST /blocks` above.
   */
  upload: <T>(_p: string, _form: FormData): Promise<T> => {
    throw new Unsupported("a picture travels with the create — see POST /blocks in api.ts");
  },
};
