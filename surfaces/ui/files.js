// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Files in what is written — a writing page, a canvas note: what the editor's
// `files` (editor.js) asks of the page. A file dropped or pasted is kept in the
// project's `Files/` (the core seals it there if the project is encrypted) and
// linked by its path; a link clicked opens the file in its application,
// through the page's bridge (files.py). `project()` is the project the words
// belong to. A page sets this once as `window.talarisFileDefaults`, so an
// editor made without it (a canvas note, inside the drawer) still has it.

"use strict";

window.TalarisFiles = (api, project, bridge) => ({
  attach(file) {
    return new Promise((ok, fail) => {
      const reader = new FileReader();
      reader.onerror = () => fail(new Error(`${file.name} could not be read`));
      reader.onload = () => {
        // A data: URL; what follows its comma is the file, base64.
        const data = String(reader.result).split(",", 2)[1] || "";
        api("POST", `/projects/${encodeURIComponent(project())}/files`, { name: file.name || "file", data }).then(ok, fail);
      };
      reader.readAsDataURL(file);
    });
  },
  open(path) {
    if (bridge()) bridge().openProjectFile(project(), path);
  },
});
