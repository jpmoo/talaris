// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * The text inside a canvas note — the same editor as a writing page.
 *
 * It is imported at run time from the drawer's own `editor.js` rather than
 * bundled again, so a canvas note and a page are one editor: Obsidian-style
 * live preview, the same keys, and a fix to one is a fix to both. Compact,
 * because a note has no room for a fold margin or drag grips.
 */
import { useEffect, useRef } from "react";

interface Field {
  text: string;
  set(next: string): void;
  /** Color the selected words, or the colored words round the caret (editor's setColor). */
  setColor?(color: string | null): boolean;
  readonly selecting?: boolean;
  focus(): void;
  destroy(): void;
}

/** The editor of the note whose field holds `el`, for the note's menu to color its words. */
export function fieldEditor(el: Element | null | undefined): Field | null {
  const host = el?.closest?.(".longtext") as (HTMLElement & { talarisField?: Field }) | null;
  return host?.talarisField ?? null;
}

export function LongTextField({
  value,
  onChange,
  placeholder = "Write…",
  autofocus = false,
  onFocusChange,
}: {
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
  blockId?: string;
  autofocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<Field | null>(null);
  const latest = useRef<(text: string) => void>(onChange);
  latest.current = onChange;

  useEffect(() => {
    let dead = false;
    const initial = typeof value === "string" ? value : "";
    void (async () => {
      // Through a variable, so the bundler leaves it alone: the file belongs
      // to the drawer, beside this bundle, not inside it.
      const where = "../editor.js";
      const mod = (await import(/* @vite-ignore */ where)) as {
        createEditor: (host: HTMLElement, text: string, o: Record<string, unknown>) => Field;
      };
      if (dead || !host.current) return;
      field.current = mod.createEditor(host.current, initial, {
        live: true,
        compact: true,
        onChange: (text: string) => latest.current(text),
        onOpenUrl: (url: string) => window.parent.postMessage({ talaris: "open-url", url }, "*"),
      });
      // Found again from the menu (fieldEditor), by the element it lives in.
      (host.current as HTMLElement & { talarisField?: Field }).talarisField = field.current;
      // A note somebody has just made should take words without a click.
      if (autofocus) field.current.focus();
    })();
    return () => {
      dead = true;
      field.current?.destroy();
    };
    // Mounted once. `EphemeralNote` remounts this by key when the text changes
    // under it, which is how a note edited elsewhere catches up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="longtext"
      ref={host}
      data-placeholder={placeholder}
      // The canvas listens for keys everywhere — Delete removes a node — so
      // nothing typed in here may reach it.
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
    />
  );
}
