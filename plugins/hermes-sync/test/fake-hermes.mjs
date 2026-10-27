// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore
//
// A fake Hermes Notes for test/e2e.mjs: the live binding over HTTP, in
// memory, with Hermes' own types as they are once marked (a person, an
// event, a project), and two doors of the test's own to change things "in
// Hermes" and look at them.
import http from "node:http";
const types = [
  { id: "0de758cb-70a5-49f0-8582-5cb5bcd508d7", name: "Project", fields: [{ key: "title", kind: "text" }, { key: "description", kind: "richtext" }], profiles: { project: { title: "title", body: "description" } } },
  { id: "bb8d399a-355a-4981-9a0d-54eb15297743", name: "Task", fields: [{ key: "title", kind: "text" }, { key: "status", kind: "enum", options: ["not done", "done"] },
    { key: "project", kind: "reference", many: true }, { key: "schedule", kind: "datespan" }, { key: "notes", kind: "richtext" }],
    profiles: { task: { title: "title", status: "status", completeValues: ["done"], start: { field: "schedule", part: "start" }, due: { field: "schedule", part: "end" }, project: "project" } } },
  { id: "425dd868-cdf0-40e4-b195-f43d5a561c0e", name: "Person", fields: [{ key: "title", kind: "text" }, { key: "email", kind: "text" }, { key: "role", kind: "text" }],
    profiles: { contact: { title: "title", email: "email", role: "role" } } },
];
const P = "11111111-1111-4111-8111-111111111111", T1 = "22222222-2222-4222-8222-222222222222", R = "33333333-3333-4333-8333-333333333333";
const objects = new Map([
  [P, { id: P, type: types[0].id, properties: { title: "Retreat" }, version: 1 }],
  [T1, { id: T1, type: types[1].id, properties: { title: "Order food", status: "not done", project: [P] }, version: 1 }],
  [R, { id: R, type: types[2].id, properties: { title: "Rosa Diaz", email: "rosa@99.example", role: "Sergeant" }, version: 1 }],
]);
let seq = 3; const log = [{ seq: 1, object: P, op: "create" }, { seq: 2, object: T1, op: "create" }, { seq: 3, object: R, op: "create" }];
// Where a person opens each one, as Hermes says it (the format's `url`).
const withUrl = (o) => ({ ...o, url: `https://hermes.example/block/${o.id}` });
const changed = (id, op) => log.push({ seq: ++seq, object: id, op });
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s ? JSON.parse(s) : {})); });
const send = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
http.createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer test-key") return send(res, 401, { error: "no" });
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/hermes/api/interchange" && req.method === "GET") {
    const since = url.searchParams.get("since");
    if (since !== null) {
      const ch = log.filter((c) => c.seq > Number(since));
      return send(res, 200, { format: "pkm-interchange/0", cursor: String(seq), types, objects: ch.filter((c) => c.op !== "delete").map((c) => objects.get(c.object)).filter(Boolean).map(withUrl), changes: ch });
    }
    return send(res, 200, { format: "pkm-interchange/0", cursor: String(seq), types, objects: [...objects.values()].map(withUrl) });
  }
  const m = /^\/hermes\/api\/interchange\/objects\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "PUT") {
    const b = await body(req);
    if (objects.has(m[1])) return send(res, 200, { ok: true, created: false, object: objects.get(m[1]), fidelity: "full", reports: [] });
    const o = { id: m[1], type: b.type, properties: b.properties ?? {}, version: 1 };
    objects.set(o.id, o); changed(o.id, "create");
    return send(res, 201, { ok: true, created: true, object: o, fidelity: "full", reports: [] });
  }
  if (m && req.method === "PATCH") {
    const b = await body(req); const o = objects.get(m[1]);
    if (!o) return send(res, 404, { error: "no" });
    if (b.version !== undefined && b.version !== o.version) return send(res, 409, { ok: false, conflict: true, object: o, fidelity: "full", reports: [] });
    Object.assign(o.properties, b.set ?? {}); for (const k of b.unset ?? []) delete o.properties[k];
    if (typeof b.archived === "boolean") { if (b.archived) o.archived = true; else delete o.archived; }
    o.version++; changed(o.id, "update");
    return send(res, 200, { ok: true, object: o, fidelity: "full", reports: [] });
  }
  // The test's own door: change something "in Hermes".
  if (url.pathname === "/test/set" && req.method === "POST") {
    const b = await body(req); const o = objects.get(b.id); Object.assign(o.properties, b.set ?? {});
    if (typeof b.archived === "boolean") { if (b.archived) o.archived = true; else delete o.archived; }
    o.version++; changed(o.id, "update"); return send(res, 200, o);
  }
  if (url.pathname === "/test/all") return send(res, 200, [...objects.values()]);
  send(res, 404, { error: `no ${req.method} ${url.pathname}` });
}).listen(18800, "127.0.0.1", () => console.log("fake hermes up"));
