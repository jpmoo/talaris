// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * The demo world's things (demo.ts), made the first time demo mode starts,
 * and again after Reset: a few projects with their writing and files, people,
 * tasks in every state a task can be in, collections of each kind, notes,
 * daily notes — and the calendar's events, written for the surfaces to read.
 * Every date counts from the day it is made, and the events from the day they
 * are shown, so a demo is always of this week.
 *
 * Made-up, all of it: the people at `example.org` addresses, the places
 * nowhere in particular.
 *
 * Made to show off how things tie together (suggest.ts, Glance), so it holds
 * on purpose what suggests a tie and has none yet: names written plainly, not
 * as mentions ("Call Priya", two people called Daniel); a person entered
 * twice, and one known by the same address under another name; a task
 * written twice; a page called by a person's name; pages and files of no
 * project that are plainly about one; a PDF and text files whose words name
 * people and projects.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_ROOT } from "./demo.js";
import { createEntity, typeFor } from "./entities.js";
import { addMember, createList } from "./lists.js";
import { createDay, createNote } from "./notes.js";
import { createPage, writePage } from "./pages.js";
import { putProjectFile } from "./projects.js";
import { attachFile, createTask, createTaskProject, setRecurrence } from "./tasks.js";
import { newId } from "./store.js";

const SEEDED = () => join(DEMO_ROOT, "seeded");

const pad = (n: number) => String(n).padStart(2, "0");
/** A day this many days from today, as a date. */
function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A one-page PDF of these lines, by hand: enough for `pdftotext` to read, so the demo has a PDF found by its words. */
function pdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = `BT /F1 13 Tf 72 740 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objects.forEach((o, i) => { at.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The demo world made, once: answers whether it was made now. */
export function seedDemo(): boolean {
  if (existsSync(SEEDED())) return false;

  // ---- people
  const personType = typeFor("person").id;
  const person = (title: string, extra: Record<string, unknown>) => createEntity({ type: personType, properties: { title, ...extra } });
  const maya = person("Maya Chen", { emails: ["maya@brightline.example.org"], organization: "Brightline Studio", role: "Designer", phones: ["555-0142"] });
  const daniel = person("Daniel Okafor", { emails: ["daniel.okafor@example.org"], organization: "Riverbend Commons", role: "Board chair" });
  const priya = person("Priya Raman", { emails: ["priya@brightline.example.org"], organization: "Brightline Studio", role: "Developer" });
  const sam = person("Sam Whitaker", { emails: ["sam@whitakerbuild.example.org"], organization: "Whitaker Build", role: "Contractor", phones: ["555-0187"] });
  const lena = person("Lena Novak", { emails: ["lena.novak@example.org"], organization: "Riverbend Commons", role: "Volunteer coordinator" });
  const marcus = person("Marcus Bell", { emails: ["marcus@bellaccounts.example.org"], role: "Accountant" });
  // Ties to be found: a second Daniel (so "Daniel" is one of two); Sam twice, as an address book and a phone might each have him;
  // Marcus again by his address, as an invitation names him.
  person("Daniel Park", { emails: ["dpark@example.org"], organization: "Park & Sons Hardware", role: "Shop owner" });
  person("Sam Whitaker", { phones: ["555-0187"], notes: "Met at the hardware store" });
  person("M. Bell", { emails: ["marcus@bellaccounts.example.org"] });
  const m = (p: { id: string; properties: Record<string, unknown> }) => `[@${String(p.properties.title)}](talaris:${p.id})`;

  // ---- projects, each with its task-side self
  const web = createTaskProject("Website Refresh");
  const garden = createTaskProject("Community Garden");
  const board = createTaskProject("Board Report");
  const kitchen = createTaskProject("Kitchen Remodel");
  const folder = (e: { [k: string]: unknown }) => ((e["talaris:sources"] as { kind: string; key: string }[]) ?? []).find((s) => s.kind === "talaris-project")!.key;

  // ---- tasks: overdue, today, spanning days, next week, waiting, done, repeating
  const task = (title: string, project: { id: string }, opts: { start?: number; due?: number; status?: string; tags?: string[]; description?: string } = {}) =>
    createTask({
      title, projects: [project.id],
      ...(opts.start !== undefined ? { start: day(opts.start) } : {}),
      ...(opts.due !== undefined ? { due: day(opts.due) } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    });
  const t = {
    mockups: task(`Review homepage mockups from ${m(maya)}`, web, { start: 0, due: 1, tags: ["decide"] }),
    copy: task("Write new About page copy", web, { start: -2, due: 2, status: "in_progress", tags: ["do"] }),
    staging: task(`Set up staging site with ${m(priya)}`, web, { start: 1, due: 4 }),
    analytics: task("Pull last year's traffic numbers", web, { due: -2, tags: ["do"] }),
    launch: task("Plan the launch announcement", web, { start: 5, due: 9 }),
    photos: task("Choose photos for the gallery", web, { due: -6, status: "done" }),
    seeds: task("Order spring seed catalogue", garden, { due: 0, tags: ["do"] }),
    schedule: task(`Volunteer schedule for the workday with ${m(lena)}`, garden, { start: 0, due: 3, tags: ["delegate"] }),
    beds: task("Build two more raised beds", garden, { start: 2, due: 6, tags: ["defer"] }),
    compost: task("Fix the compost bin latch", garden, { due: -1 }),
    water: task("Water the seedlings", garden, { start: 0, due: 0 }),
    budget: task(`Reconcile the budget with ${m(marcus)}`, board, { start: -1, due: 2, status: "in_progress", tags: ["do"] }),
    outline: task("Draft the report outline", board, { due: -3, status: "done" }),
    charts: task("Make charts for membership growth", board, { start: 1, due: 5, tags: ["decide"] }),
    chair: task(`Send the draft to ${m(daniel)} for comments`, board, { start: 6, due: 8, tags: ["delegate"] }),
    quote: task(`Get a second quote from ${m(sam)}`, kitchen, { due: 1, status: "blocked", tags: ["delegate"], description: "Waiting on measurements for the island." }),
    tiles: task("Pick backsplash tiles", kitchen, { start: 3, due: 10, tags: ["defer"] }),
    permit: task("Check whether the electrical work needs a permit", kitchen, { due: 4 }),
    lighting: task("Compare under-cabinet lighting", kitchen, { due: -10, status: "wont_do" }),
    // Names written plainly, not yet mentions: each a suggestion to make one.
    priya: task("Call Priya about the donate button on phones", web, { due: 1, tags: ["do"] }),
    lena: task("Ask Lena for the volunteer sign-up sheet", garden, { due: 2 }),
    daniel: task("Send Daniel the board packet", board, { start: 4, due: 7 }),
    island: task("Measure for the island with Sam Whitaker", kitchen, { due: 3 }),
  };
  // The same task twice — once in its project, once caught on the run with no project: one to merge.
  createTask({ title: "Fix the compost bin latch", due: day(1) });
  // Of no project, but plainly about one: to be filed.
  createTask({ title: "Buy cedar boards for the raised beds", due: day(2) });
  createTask({ title: "Find a printer for the annual report charts", due: day(5) });
  setRecurrence(t.water.id, { anchor: "schedule", freq: "daily", interval: 2, end: { type: "never" } });

  // ---- writing, files: each project's
  const page = (project: { [k: string]: unknown }, title: string, text: string) => {
    const p = createPage(folder(project), null, title);
    writePage(folder(project), p.path, text);
  };
  page(web, "Brief", `# Website Refresh\n\nThe site was built five years ago and shows it. Goals:\n\n- Clear story on the home page\n- Events calendar people can find\n- A donate button that works on phones\n\nDesign by ${m(maya)}; build by ${m(priya)}. Launch before the board meets.\n`);
  page(web, "Kickoff notes", `## Kickoff\n\n- Agreed on three page templates\n- ${m(maya)} sends mockups by the end of the week\n- Hosting stays where it is\n\n**Open question:** do we move the blog?\n`);
  page(garden, "Planting plan", `# Planting plan\n\n| Bed | Spring | Summer |\n|---|---|---|\n| 1 | Peas, lettuce | Tomatoes |\n| 2 | Spinach | Beans |\n| 3 | Radishes | Squash |\n\n${m(lena)} is finding volunteers for the workday.\n`);
  page(board, "Report outline", `# Annual report\n\n1. Year in numbers\n2. Programs\n3. Finances — with ${m(marcus)}\n4. What's next\n`);
  page(kitchen, "Ideas", `# Kitchen\n\n- Open shelving on the window wall\n- Keep the old pantry door\n- ${m(sam)} thinks the island can be moved 30cm\n`);
  putProjectFile(folder(web), "sitemap.md", Buffer.from("# Sitemap\n\n- Home\n- About\n- Programs\n- Events\n- Donate\n"));
  putProjectFile(folder(board), "budget.csv", Buffer.from("Item,Planned,Actual\nPrograms,42000,39850\nOutreach,8000,8420\nAdmin,12000,11760\n"));
  putProjectFile(folder(garden), "volunteers.txt", Buffer.from("Saturday workday\n\n9:00 Setup\n10:00 Beds\n12:00 Lunch\n"));
  attachFile(t.budget.id, Buffer.from("Item,Q1,Q2,Q3\nPrograms,10400,9800,10150\nOutreach,1900,2210,2050\n"), "quarterly.csv", "text/csv");
  // Files whose words name people and projects: read for search, and suggested where they belong.
  putProjectFile(folder(board), "March minutes.md", Buffer.from("# Board meeting — March\n\nPresent: Daniel Okafor (chair), Lena Novak, Marcus Bell.\n\n"
    + "- Marcus Bell walked through the budget: programs under plan, outreach slightly over.\n- The Website Refresh should launch before the annual report goes out.\n"
    + "- Lena Novak asked for more volunteers for the Community Garden workday.\n"));
  putProjectFile(folder(web), "Donate button notes.txt", Buffer.from("Donate button\n\nOn phones the button sits below the fold. Priya Raman suggests a sticky bar;\n"
    + "Maya Chen wants it in the header instead. Decide at the design review.\n"));
  putProjectFile(folder(kitchen), "Permit checklist.pdf", pdf(["Kitchen permit checklist", "", "Electrical: new circuit for the island needs a permit.",
    "Plumbing: moving the sink 30cm does not.", "Sam Whitaker will pull the permit once the quote is signed."]));
  attachFile(t.quote.id, Buffer.from("Island: 240 x 90 cm\nClearance to the range: 105 cm\nMeasured with Sam Whitaker.\n"), "island measurements.txt", "text/plain");

  // ---- notes of no project, and daily notes
  createNote(newId("e"), "Reading list", "# Reading list\n\n- *The Design of Everyday Things*\n- *Braiding Sweetgrass*\n- *Four Thousand Weeks*\n");
  createNote(newId("e"), "Ideas", `# Ideas\n\n- A tool library for the neighborhood\n- Ask ${m(daniel)} about a spring fundraiser\n`);
  // A page called by a person's name: likely about them, and not yet said to be.
  createNote(newId("e"), "Maya", "# Maya\n\nDesigner at Brightline Studio. Prefers sketches on paper before Figma. Coffee, not tea. Ask about her pottery class.\n");
  // Of no project, and plainly about one: to be filed, or tied.
  createNote(newId("e"), "Raised bed lumber", "# Raised bed lumber\n\nCedar lasts longest. Two beds of 1.2 x 2.4 m need about twelve boards.\n"
    + "Lena thinks the hardware store will donate some for the Community Garden.\n");
  createNote(newId("e"), "Spring fundraiser", "# Spring fundraiser\n\nA dinner in the garden, tickets sold through the new website.\n"
    + "Daniel wants a number for the annual report: the board meets next week.\n");
  createNote(newId("e"), "Lemon pasta", "# Lemon pasta\n\nZest two lemons into butter, add pasta water, parmesan, lots of pepper. Ten minutes.\n");
  createDay(newId("e"), day(-1), `Good call with ${m(maya)} about the mockups. Garden bin latch still broken.`);
  createDay(newId("e"), day(0), "- Seed catalogue today\n- Budget with Marcus this week\n");

  // ---- collections: a matrix, a board, a table, a list
  const open = { kind: "group" as const, match: "all" as const, items: [{ kind: "profile" as const, profile: "task" }, { kind: "state" as const, value: "open" as const }] };
  const matrix = createList({
    name: "Eisenhower", kind: "matrix", query: open,
    placement: { semantic: true, "talaris:columns": 2, regions: [
      { name: "do", label: "Do", "talaris:color": "#557f5a", "talaris:enter": { tag: "do", untagOnLeave: true } },
      { name: "decide", label: "Decide", "talaris:color": "#a8ab80", "talaris:enter": { tag: "decide", untagOnLeave: true } },
      { name: "delegate", label: "Delegate", "talaris:color": "#6f93a9", "talaris:enter": { tag: "delegate", untagOnLeave: true } },
      { name: "defer", label: "Defer", "talaris:color": "#813b46", "talaris:enter": { tag: "defer", untagOnLeave: true } },
    ] },
  });
  for (const [k, region] of Object.entries({ copy: "do", analytics: "do", seeds: "do", budget: "do", mockups: "decide", charts: "decide",
    schedule: "delegate", quote: "delegate", chair: "delegate", beds: "defer", tiles: "defer" })) {
    addMember(matrix.id, t[k as keyof typeof t].id, { region });
  }
  createList({ name: "By status", kind: "board", query: open, bind: "status" });
  createList({ name: "This week", kind: "table", query: { kind: "group", match: "all", items: [...open.items, { kind: "property", key: "schedule.end", op: "lt", value: "today+7" }] },
    order: { sort: [{ by: { field: "schedule", part: "end" }, direction: "ascending" }] } });
  createList({ name: "Done recently", kind: "list", query: { kind: "group", match: "all", items: [{ kind: "profile", profile: "task" }, { kind: "state", value: "complete" }] } });

  // ---- the calendar's, read by the surfaces (calendard.py, demo): days counted from the day shown
  writeFileSync(join(DEMO_ROOT, "calendar.json"), JSON.stringify({
    calendars: [
      { id: "demo-work", name: "Work", color: "#5b8def", account: "demo@example.org", writable: true },
      { id: "demo-home", name: "Home", color: "#5fb37a", account: "demo@example.org", writable: true },
    ],
    events: [
      { calendar: "demo-work", uid: "standup", title: "Team standup", weekdays: true, at: "09:30", minutes: 15, location: "Video call" },
      { calendar: "demo-work", uid: "maya-lunch", title: "Lunch with Maya", day: 0, at: "12:30", minutes: 60, location: "Corner Café" },
      { calendar: "demo-work", uid: "design-review", title: "Design review", day: -1, at: "15:00", minutes: 60, notes: "Homepage mockups, round two." },
      { calendar: "demo-work", uid: "board-prep", title: "Board report prep", day: 1, at: "10:00", minutes: 90, location: "Riverbend Commons" },
      { calendar: "demo-work", uid: "budget-call", title: "Budget call with Marcus", day: 2, at: "14:00", minutes: 45 },
      { calendar: "demo-home", uid: "garden-day", title: "Garden workday", day: 3, allDay: true, location: "Riverbend Community Garden" },
      { calendar: "demo-home", uid: "contractor", title: "Kitchen walkthrough with Sam", day: 4, at: "08:00", minutes: 60 },
      { calendar: "demo-work", uid: "board-meeting", title: "Board meeting", day: 8, at: "18:30", minutes: 120, location: "Riverbend Commons" },
      { calendar: "demo-home", uid: "trip", title: "Weekend away", day: 12, allDay: true, days: 3 },
      { calendar: "demo-home", uid: "dentist", title: "Dentist", day: -3, at: "11:00", minutes: 45 },
    ],
    made: [],
  }, null, 1), { mode: 0o600 });

  writeFileSync(SEEDED(), new Date().toISOString());
  return true;
}
