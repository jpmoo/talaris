// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// The colors a person picks from, in one place: the theme's accents
// (design/theme-tuner.html), the colors a calendar or a word may wear (Google's
// and Outlook's own, then the accents), the muted tints that tell kinds
// apart (tokens.css --tint-*), and the marks a status or region may wear. Settings, the drawers, People and Glance read
// these rather than keep copies.

"use strict";

const Palette = (() => {
  const ACCENTS = ["#c98a5b", "#8aa878", "#7f9fbf", "#c7a55a", "#b97f8e"];
  const COLORS = ["#d50000", "#e67c73", "#f4511e", "#f6bf26", "#33b679", "#0b8043", "#039be5", "#3f51b5", "#7986cb", "#8e24aa", "#616161", ...ACCENTS];
  const TINTS = ["var(--accent)", "var(--danger)", "var(--tint-1)", "var(--tint-2)", "var(--tint-3)", "var(--tint-4)"];
  // What a status or a region of the matrix may wear: muted, beside the theme rather than over it.
  const MARKS = ["#868c92", "#5fa4b5", "#5f7fb5", "#7f9fbf", "#8f7fb5", "#8aa878", "#c7a55a", "#b59a5f", "#c98a5b", "#c26b6b", "#b97f8e", "#6c7277"];
  return { ACCENTS, COLORS, TINTS, MARKS };
})();
