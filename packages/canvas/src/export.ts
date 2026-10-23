// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A canvas as a picture or a page — the whole drawing, not the part on screen.
 *
 * Talaria photographed a second copy of the canvas in a hidden window. In
 * Talaris every window the surfaces process opens is a layer surface on the
 * screen, so a hidden copy would flash across the desktop; instead the canvas
 * draws its own layer into an image, right here in its frame (html-to-image),
 * moved so the drawing's corner is the picture's corner and at its true size,
 * none of the view's pan or zoom. Then the core keeps it in the project's
 * `Exports/` folder.
 *
 * The PDF is that picture on a page the drawing's size, at twice its
 * resolution, written by hand below — a picture in a PDF, not a vector
 * drawing, which is the honest cost of drawing it with a browser.
 */

import { toCanvas } from "html-to-image";
import { ask, document_, where } from "./api.ts";

/** Room around the drawing, in canvas points. */
const MARGIN = 40;
/** A ceiling for either edge, so an enormous canvas makes a large file, not a crash. */
const MAX_EDGE = 8000;

/** The drawing's extent, in canvas coordinates, read off what is drawn. */
function extent(wrap: HTMLElement, layer: HTMLElement) {
  const m = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
  const z = m.a || 1;
  const w = wrap.getBoundingClientRect();
  const toDoc = (x: number, y: number) => ({ x: (x - w.left - m.e) / z, y: (y - w.top - m.f) / z });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // The connections as well as the things they connect: a curve bows outside
  // both of its ends. Not the arrowheads in <defs>, whose boxes sit at 0,0.
  const parts = [...layer.querySelectorAll<HTMLElement | SVGGraphicsElement>(".cv-node, .cv-region, .cv-svg path")]
    .filter((el) => !el.closest("defs"));
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const a = toDoc(r.left, r.top);
    const b = toDoc(r.right, r.bottom);
    minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, b.x); maxY = Math.max(maxY, b.y);
  }
  if (!isFinite(minX)) return null;
  return { x: minX - MARGIN, y: minY - MARGIN, w: maxX - minX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN };
}

async function render(): Promise<HTMLCanvasElement> {
  const wrap = document.querySelector<HTMLElement>(".cv-wrap");
  const layer = document.querySelector<HTMLElement>(".cv-layer");
  if (!wrap || !layer) throw new Error("There is no canvas to export.");
  const box = extent(wrap, layer);
  if (!box) throw new Error("This canvas is empty — there is nothing to export.");
  const scale = Math.min(1, MAX_EDGE / Math.max(box.w, box.h));
  // Selection is a moment, not part of the drawing; take it off for the photograph.
  const selected = [...document.querySelectorAll(".cv-sel")];
  selected.forEach((el) => el.classList.remove("cv-sel"));
  try {
    return await toCanvas(layer, {
      width: Math.ceil(box.w * scale),
      height: Math.ceil(box.h * scale),
      pixelRatio: 2,
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--desk").trim() || "#16181a",
      style: { transform: `scale(${scale}) translate(${-box.x}px, ${-box.y}px)`, transformOrigin: "0 0" },
      // The handles a node wears for editing are not the drawing.
      filter: (n) => !(n instanceof HTMLElement && n.matches?.(".cv-corner, .cv-grab, .cv-handle, .cv-connect, .cv-make-region, .cv-region-add")),
    });
  } finally {
    selected.forEach((el) => el.classList.add("cv-sel"));
  }
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/** One page, one picture: the smallest PDF that is a PDF. */
function pdfOf(jpeg: Uint8Array, iw: number, ih: number, pw: number, ph: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
    put("endobj\n");
  };
  const draw = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
  put("%PDF-1.4\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  object(4, `<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  object(5, `<< /Length ${draw.length} >>`, draw);
  const xref = length;
  put(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Export this canvas; resolves to where it went, relative to the project folder. */
export async function exportCanvas(kind: "png" | "pdf"): Promise<{ path: string; folder: string }> {
  const sheet = await render();
  const day = new Date();
  const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const name = `${(document_() as { title?: string }).title || "Canvas"} ${stamp}`;
  let data: string;
  if (kind === "png") {
    data = base64Of(sheet.toDataURL("image/png"));
  } else {
    const jpeg = Uint8Array.from(atob(base64Of(sheet.toDataURL("image/jpeg", 0.95))), (c) => c.charCodeAt(0));
    // The page is the drawing's size in points; the picture is twice as dense.
    data = base64(pdfOf(jpeg, sheet.width, sheet.height, Math.round(sheet.width / 2), Math.round(sheet.height / 2)));
  }
  return ask("POST", `/projects/${where.project}/exports`, { name, kind, data });
}

