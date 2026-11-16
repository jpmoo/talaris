// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// Project chat: a conversation with one project, shown wherever a project is — the tasks app's project sheet, the
// project's card in the Library, Morgan's panel (its pulldown). The conversation itself is Morgan's brain's (heymorgan,
// projects.mjs), so it is the same on every machine; this draws it and sends to it through the panel's bridge
// (`projectChat` → `projectReply`, core.py), which passes only the `project` command.
//
// A project answers as itself, and always weighs itself against the day: its standing (now, soon, later, and why) is
// shown above what was said, as it last said it.
//
//   ProjectChat.mount(host, { bridge, id, name })   → { focus(), destroy() }
//   ProjectChat.list(bridge)                        → Promise<[{ id, name, open, home }]>  (Talaris's projects)
//
// `id` is the Talaris project's: its conversation is kept by it on the brain, and each turn carries the project's brief
// from Talaris (core.py adds it) — its pages, canvases, files, tasks, people, what is tied to it, and the day.

(() => {
  const waiting = new Map();
  const wired = new WeakSet();
  let seq = 0;

  /** One request to the brain, answered as its JSON (or { ok: false, error }). */
  function call(bridge, body) {
    return new Promise((resolve) => {
      if (!bridge || typeof bridge.projectChat !== "function") { resolve({ ok: false, error: "Project chat isn't available here" }); return; }
      if (!wired.has(bridge)) {
        wired.add(bridge);
        bridge.projectReply.connect((text) => {
          let got;
          try { got = JSON.parse(text); } catch { return; }
          const done = waiting.get(got.id);
          if (!done) return;
          waiting.delete(got.id);
          let answer;
          try { answer = JSON.parse(got.answer); } catch { answer = { ok: false, error: "Morgan didn't answer" }; }
          done(answer);
        });
      }
      const id = `pc${++seq}`;
      waiting.set(id, resolve);
      bridge.projectChat(id, JSON.stringify(body));
    });
  }

  let markdown = null;
  const rendering = () => (markdown ??= import("./markdown.js").then((m) => m.render).catch(() => null));

  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) node.append(kid);
    return node;
  };

  const WHEN = { now: "Today", soon: "This week", later: "Can wait" };

  function mount(host, { bridge, id, name }) {
    const standing = el("div", { class: "pchat-standing", hidden: true });
    const log = el("div", { class: "pchat-log" });
    const box = el("textarea", { class: "pchat-box", rows: "2", placeholder: `Talk with ${name}…` });
    const send = el("button", { class: "t-btn small primary pchat-send", title: "Send (Enter)" }, "Send");
    const clear = el("button", { class: "t-btn small pchat-clear", title: "Forget this conversation" }, "Clear");
    const root = el("div", { class: "pchat" },
      el("div", { class: "pchat-head" }, standing, el("span", { class: "spacer" }), clear),
      log,
      el("div", { class: "pchat-compose" }, box, send));
    host.replaceChildren(root);
    let gone = false, sending = false, render = null;
    rendering().then((r) => { render = r; });

    const showStanding = (s) => {
      standing.hidden = !s;
      if (!s) return;
      standing.className = `pchat-standing ${s.today}`;
      standing.replaceChildren(el("b", {}, WHEN[s.today] ?? s.today), " ", el("span", {}, s.why || ""));
      standing.title = s.why || "";
    };
    const bubble = (role, text, extra = "") => {
      const body = el("div", { class: "pchat-text" });
      if (role === "assistant" && render) body.replaceChildren(render(text));
      else body.textContent = text;
      const node = el("div", { class: `pchat-msg ${role === "user" ? "mine" : "theirs"} ${extra}` }, body);
      log.append(node);
      log.scrollTop = log.scrollHeight;
      return node;
    };
    const note = (text) => { log.append(el("div", { class: "pchat-note" }, text)); log.scrollTop = log.scrollHeight; };

    const load = async () => {
      log.replaceChildren(el("div", { class: "pchat-note" }, "…"));
      await rendering().then((r) => { render = r; });
      const got = await call(bridge, { op: "history", project: id, name });
      if (gone) return;
      log.replaceChildren();
      if (!got.ok) { note(got.error || "Couldn't reach the project"); box.disabled = send.disabled = clear.disabled = true; return; }
      showStanding(got.standing);
      if (!got.messages?.length) note(`Ask ${got.name || name} anything — it knows its pages, canvases, tasks, people and today.`);
      for (const m of got.messages ?? []) bubble(m.role, m.content);
    };

    const go = async () => {
      const text = box.value.trim();
      if (!text || sending) return;
      sending = true;
      send.disabled = true;
      box.value = "";
      log.querySelector(".pchat-note:only-child")?.remove();
      bubble("user", text);
      const thinking = bubble("assistant", "…", "thinking");
      const got = await call(bridge, { op: "chat", project: id, name, text });
      if (gone) return;
      thinking.remove();
      sending = false;
      send.disabled = false;
      if (!got.ok) { note(got.error || "No answer"); box.value = box.value || text; return; }
      bubble("assistant", got.reply);
      showStanding(got.standing);
    };

    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
      // Typing is the chat's, not the panel's (its arrows and letters); Escape still closes the panel.
      if (e.key !== "Escape") e.stopPropagation();
    });
    send.addEventListener("click", go);
    clear.addEventListener("click", async () => {
      const got = await call(bridge, { op: "clear", project: id, name });
      if (got.ok && !gone) { log.replaceChildren(); note("Forgotten. Start again whenever you like."); }
    });
    load();
    return {
      focus: () => box.focus(),
      destroy: () => { gone = true; root.remove(); },
    };
  }

  async function list(bridge) {
    const got = await call(bridge, { op: "list" });
    return got.ok ? got.projects : [];
  }

  window.ProjectChat = { mount, list };
})();
