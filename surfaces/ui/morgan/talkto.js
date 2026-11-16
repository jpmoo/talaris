// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Who the panel talks to: Morgan, or one project (projectchat.js) — a pulldown at the head of the panel. A project
// chosen, Morgan's conversation and composer step aside for the project's own; Morgan chosen again, they come back as
// they were. Text only: what is said aloud is always Morgan's.

window.TalkTo = (() => {
  let bridge = null, chat = null, current = null, projects = [];
  const $ = (id) => document.getElementById(id);

  const label = () => {
    const b = $("talkto");
    b.replaceChildren(Object.assign(document.createElement("span"), { textContent: current ? current.name : "Morgan" }),
      Object.assign(document.createElement("span"), { className: "chev", textContent: "▾" }));
    b.title = current ? `Talking with the project ${current.name} — choose who to talk to` : "Talking with Morgan — choose a project to talk with instead";
  };

  function choose(project) {
    if (chat) { chat.destroy(); chat = null; }
    current = project;
    document.body.classList.toggle("talking-to-project", !!project);
    if (project) {
      chat = ProjectChat.mount($("pchat-host"), { bridge, name: project.name });
      setTimeout(() => chat && chat.focus(), 50);
    }
    label();
  }

  async function open(anchor) {
    if (Kit.openedBy() === anchor) { Kit.popAway(); return; }
    // The list as Hermes has it, asked each time: projects come and go.
    const got = await ProjectChat.list(bridge);
    if (got.length) projects = got;
    const byOpen = [...projects].sort((a, b) => (b.open - a.open) || a.name.localeCompare(b.name));
    Kit.menu(anchor, [
      { label: "Morgan", on: !current, act: () => choose(null) },
      ...(byOpen.length ? ["sep"] : []),
      ...byOpen.map((p) => ({ label: p.open ? `${p.name} · ${p.open}` : p.name, on: current?.id === p.id, act: () => choose(p) })),
      ...(byOpen.length ? [] : [{ label: "No projects (is Hermes connected?)", act: () => {} }]),
    ]);
  }

  function init(b) {
    bridge = b;
    if (!window.ProjectChat || typeof bridge.projectChat !== "function") { $("talkto").hidden = true; return; }
    $("talkto").addEventListener("click", (e) => open(e.currentTarget));
    label();
  }

  return { init, choose, get project() { return current; } };
})();
