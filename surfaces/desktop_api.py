# SPDX-License-Identifier: GPL-3.0-only
# Copyright (c) 2026 Jeff Moore
"""
The desktop's half of Talaris's MCP (DESIGN, *Morgan*: "The desktop is what
Morgan knows"). The core's MCP server (`talaris-core mcp`) holds projects,
pages, canvases and entities; what only this process knows — what is on the
screen, and the verbs that change it — it asks here, as a JSON line on the
control socket (`surfaces.py`, `_command`), answered with one.

**What is current is state, not a record**: read when asked, from Hyprland and
the panels, and nothing about it is kept.

The verbs are the ones a person already has, done the same way: `go` is the
bar's project menu, `open` the launcher's choices (`Launcher.act`), so Morgan
asking is never a second way of doing a thing.
"""

from __future__ import annotations

import json

import hypr


def answer(desktop, req: dict) -> dict:
    do = str(req.get("do", ""))
    try:
        if do == "now":
            return {"ok": True, "now": now(desktop)}
        if do == "windows":
            return {"ok": True, "windows": windows(desktop, bool(req.get("all")))}
        if do == "go":
            project = str(req.get("project", ""))
            if not project:
                return {"ok": False, "error": "go needs a project"}
            desktop.go_to_project(project, announce=True)
            return {"ok": True}
        if do == "open":
            return opened(desktop, req)
        if do == "show":
            return show(desktop, str(req.get("panel", "")))
        if do == "launch":
            return launch(desktop, str(req.get("app", "")))
        if do == "focus":
            return said(desktop.launcher.act({"kind": "window", "address": str(req.get("address", ""))}))
        if do == "close-window":
            address = str(req.get("address", ""))
            if address not in {w["address"] for w in hypr.windows()["windows"]}:
                return {"ok": False, "error": "That window has gone"}
            hypr.close(address)
            return {"ok": True}
        if do == "archive":
            return said(desktop.archive_project(str(req.get("project", ""))))
        if do == "changed":
            # A page or a canvas changed outside its drawer: the drawer showing it reads it again.
            changed(desktop, str(req.get("kind", "")), str(req.get("project", "")), str(req.get("where", "")))
            return {"ok": True}
    except Exception as e:  # noqa: BLE001 — a verb that fails says why, and the process carries on
        return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"no such thing to do: {do}"}


def said(error: str) -> dict:
    return {"ok": True} if not error else {"ok": False, "error": error}


def now(desktop) -> dict:
    """What is in front of the person: the project, the window with the keyboard, what is out."""
    w = hypr.windows()
    focused = next((x for x in w["windows"] if x["address"] == w["focused"]), None)
    here = [x for x in w["windows"] if x["workspace"] == w["active"] and not x["hidden"]]
    describe = lambda x: {"address": x["address"], "app": desktop.apps.lookup(x["class"]).get("name") or x["class"], "title": x["title"]}
    panels = [p.NAME for p in desktop.overlays() if getattr(p, "up", False) and p.NAME not in desktop.workspaces]
    drawers = {}
    for name, ws in desktop.workspaces.items():
        seen = getattr(ws, "here", None) or {}
        drawers[name] = {"out": bool(getattr(ws, "up", False)), **seen}
    p = desktop.project
    return {
        "project": {"id": p.get("id", ""), "name": p.get("name", ""), "home": bool(p.get("home"))},
        "desktop": w.get("activeName", ""),
        "focused": describe(focused) if focused else None,
        "windowsHere": [describe(x) for x in here],
        "panelsOut": panels,
        "drawers": drawers,
    }


def windows(desktop, everywhere: bool) -> list:
    w = hypr.windows()
    names = {s["id"]: s["name"] for s in w["workspaces"]}
    out = []
    for x in sorted(w["windows"], key=lambda x: x["recent"]):
        if not everywhere and x["workspace"] != w["active"]:
            continue
        out.append({"address": x["address"], "app": desktop.apps.lookup(x["class"]).get("name") or x["class"], "title": x["title"],
                    "desktop": names.get(x["workspace"], str(x["workspace"])), "hidden": x["hidden"], "focused": x["address"] == w["focused"]})
    return out


PANELS = ("tasks", "calendar", "people", "glance", "morgan", "new")


def show(desktop, panel: str) -> dict:
    if panel in desktop.workspaces:
        ws = desktop.workspaces[panel]
        if not ws.up:
            ws.toggle()
        return {"ok": True}
    if panel in PANELS:
        thing = getattr(desktop, panel)
        if not thing.up:
            thing.open()
        return {"ok": True}
    return {"ok": False, "error": f"no panel called {panel}: one of canvas, writing, {', '.join(PANELS)}"}


def opened(desktop, req: dict) -> dict:
    """A page, a canvas, a file or an entity, opened where it lives."""
    kind = str(req.get("kind", ""))
    project = str(req.get("project", "")) or desktop.project.get("id", "")
    if kind in ("page", "canvas"):
        desktop.open_place(kind, project, str(req.get("where", "")))
        return {"ok": True}
    if kind == "file":
        from files import open_project_file
        open_project_file(project, str(req.get("path", "")))
        return {"ok": True}
    if kind == "task":
        desktop.show_task(str(req.get("id", "")))
        return {"ok": True}
    if kind == "person":
        desktop.people.show_person(str(req.get("id", "")))
        return {"ok": True}
    if kind == "event":
        desktop.show_event(str(req.get("calendar", "")), str(req.get("uid", "")), str(req.get("start", "")))
        return {"ok": True}
    return {"ok": False, "error": f"cannot open a {kind or 'nothing'}"}


def launch(desktop, app: str) -> dict:
    """An application by its name or desktop id, as the launcher starts it."""
    want = app.strip().lower().removesuffix(".desktop")
    apps = desktop.apps.launchable()
    found = (next((a for a in apps if a["id"].lower().removesuffix(".desktop") == want), None)
             or next((a for a in apps if a["name"].lower() == want), None)
             or next((a for a in apps if a["name"].lower().startswith(want)), None)
             or next((a for a in apps if want in a["name"].lower()), None))
    if not found:
        return {"ok": False, "error": f"no application called {app}"}
    error = desktop.launcher.act({"kind": "app", "id": found["id"]})
    return {"ok": True, "app": found["name"]} if not error else {"ok": False, "error": error}


def changed(desktop, kind: str, project: str, where: str) -> None:
    name = "writing" if kind == "page" else "canvas" if kind == "canvas" else ""
    ws = desktop.workspaces.get(name)
    if not ws:
        return
    ask = f"window.talarisChanged && talarisChanged({json.dumps({'kind': kind, 'project': project, 'where': where})})"
    for view in (ws.view, getattr(ws, "window", None)):
        if view is not None:
            view.page().runJavaScript(ask)
