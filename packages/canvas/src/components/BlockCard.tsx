// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * A library block on a canvas, when no plugin is here to draw it.
 *
 * Hermes drew a live editor; Talaria a card from its mirror. In Talaris a
 * block belongs to whichever plugin placed it, and until that plugin is
 * installed the honest drawing is a placeholder: there is something here, it
 * is not lost, and this is not the place to edit it.
 */
export function BlockCard(props: { block: { id: string; properties?: Record<string, unknown> } } & Record<string, unknown>) {
  const title = typeof props.block.properties?.title === "string" ? props.block.properties.title : "";
  return (
    <div className="cv-missing">
      <span className="cv-missing-label">FROM A PLUGIN</span>
      <span>{title || "A library item"}</span>
    </div>
  );
}
