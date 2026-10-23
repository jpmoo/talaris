// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/*
 * Hermes' canvas switched to a locked, phone-style mode on any viewport 720px
 * wide or less. In Talaris the canvas sits in a drawer that is often narrower
 * than that — and locking it there took away writing in notes and dragging
 * them, on a desktop with a mouse. A desktop canvas is never a phone.
 */
export function useIsMobile(): boolean {
  return false;
}
