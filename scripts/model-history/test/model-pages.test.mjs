/* Tests for assets/model-pages.js: the family chips on a company page (design 1a) and the
   zoom, picker and Today marker on a model timeline (design 3a). The pages are the
   generator's real output for the basic fixture, rendered in memory; the script runs in a
   node:vm sandbox against a fake DOM filled from each page's <main>.
   Run: node --test scripts/model-history/test/model-pages.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadDataset } from "../lib.mjs";
import { compile, renderSite } from "../build.mjs";
import { layoutTimeline } from "../timeline.mjs";
import { fakeDom } from "./fake-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(here, "..", "..", "..", "assets", "model-pages.js"), "utf8");
const SITE = compile(loadDataset(join(here, "fixtures", "basic")));
const FILES = renderSite(SITE).files;
const html = rel => { const t = FILES.get(rel); assert.ok(t, `missing ${rel}`); return t; };
const DAY_MS = 86400000;

// A clock fixed at `now` (ms) for the script; Date.UTC and friends are inherited.
const fixedDate = now => class extends Date { static now() { return now; } };

/* Runs the script against the <main> of a generated page. before(el) may set layout values
   (the fake DOM has no layout) before the script runs. */
function run(rel, { now = Date.UTC(2026, 9, 1, 12), before = null } = {}) {
  const { h, root, document, parse } = fakeDom();
  const main = parse(/<main[\s>][\s\S]*<\/main>/.exec(html(rel))[0]);
  root.appendChild(h("body", {}, main));
  const byId = id => document.getElementById(id);
  if (before) before(byId, main);
  const assigned = [], listeners = {};
  const sandbox = {
    document, Date: fixedDate(now),
    location: { assign: u => assigned.push(u) },
    window: { addEventListener: (t, fn) => { listeners[t] = fn; } }
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "model-pages.js" });
  return { byId, main, assigned, listeners, document };
}
const cls = (n, c) => (" " + (n.getAttribute("class") || "") + " ").includes(" " + c + " ");
const all = (root, tag, c) => root.getElementsByTagName(tag).filter(n => cls(n, c));

test("the script makes no requests, sets no cookies or storage and stays small", () => {
  const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const w of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "import(", "localStorage", "sessionStorage", "indexedDB",
    "cookie", "innerHTML", "insertAdjacentHTML", "document.write", "history."]) assert.ok(!code.includes(w), `model-pages.js must not use ${w}`);
  assert.ok(!/["'`]https?:/.test(code), "no absolute URLs");
  assert.ok(Buffer.byteLength(SCRIPT.replace(/\r\n/g, "\n")) <= 8 * 1024, "small: two page enhancements");
});

/* ---------- Company page: family chips ---------- */
test("company page: the family chips filter the chronology, hide empty years and groups, and update the counts", () => {
  const p = run("example-lab/index.html");
  const bar = p.byId("mh-family-chips"), chrono = p.byId("chronology");
  assert.equal(bar.hidden, false, "the chips appear once the script runs");
  const buttons = bar.getElementsByTagName("button");
  const status = bar.getElementsByTagName("span").find(s => s.getAttribute("role") === "status");
  assert.ok(status && cls(status, "mh-visually-hidden"));
  const shownItems = () => all(chrono, "li", "mh-chrono-item").filter(li => !li.hidden).map(li => li.getAttribute("data-mh-model"));
  const years = () => all(chrono, "li", "mh-year").filter(y => !y.hidden).map(y => y.getElementsByTagName("h3")[0].textContent + " " +
    all(y, "span", "mh-year-count")[0].textContent);
  const before = shownItems();
  assert.equal(before.length, 9);

  buttons.find(b => b.getAttribute("data-family") === "example-lab.orbit-lite").dispatch("click");
  assert.deepEqual(shownItems(), ["example-lab.orbit-lite-1"]);
  assert.deepEqual(years(), ["2025 1 model"]);
  const y2025 = all(chrono, "li", "mh-year").find(y => !y.hidden);
  assert.equal(all(y2025, "p", "mh-group-head")[0].hidden, false, "Orbit Lite 1 is year-only: its group stays");
  assert.deepEqual(buttons.map(b => b.getAttribute("aria-pressed")), buttons.map(b => String(b.getAttribute("data-family") === "example-lab.orbit-lite")));
  assert.equal(status.textContent, "Showing 1 of 9 models");

  buttons.find(b => b.getAttribute("data-family") === "example-lab.orbit").dispatch("click");
  assert.ok(!shownItems().includes("example-lab.orbit-lite-1"));
  assert.equal(all(y2025, "p", "mh-group-head")[0].hidden, true, "a group with nothing left is hidden");
  assert.ok(years().includes("2025 2 models"));

  // A click on the bar between the chips changes nothing; "All families" restores the page.
  bar.dispatch("click");
  assert.equal(status.textContent.startsWith("Showing"), true);
  buttons.find(b => b.getAttribute("data-family") === "").dispatch("click");
  assert.deepEqual(shownItems(), before);
  assert.deepEqual(years(), ["2025 3 models", "2024 4 models", "2021 1 model", "2019 1 model"]);
  assert.equal(status.textContent, "All 9 models");
  assert.ok(all(chrono, "p", "mh-group-head").every(g => !g.hidden));
});

test("company page without chips (one family): the script does nothing and is not even loaded", () => {
  assert.ok(!html("other-lab/index.html").includes("model-pages.js"));
  assert.ok(!html("other-lab/index.html").includes('id="mh-family-chips"'));
  assert.match(html("example-lab/index.html"), /<script src="\/assets\/model-pages\.js" defer><\/script>/);
});

/* ---------- Model timeline ---------- */
const TL = "example-lab/orbit-2/timeline/index.html";

test("timeline: the Today marker moves to the real today while it falls on the drawn axis", () => {
  const i = SITE.modelById.get("example-lab.orbit-2");
  assert.match(html(TL), /<span id="mh-tl-today-label">As of \d{1,2} \w+ \d{4}<\/span>/, "without the script: the build's as-of day");
  const now = Date.UTC(2026, 9, 1, 9);
  const p = run(TL, { now });
  const tl = p.byId("mh-tl");
  assert.equal(p.byId("mh-tl-today-label").textContent, "Today");
  // Same position rule as timeline.mjs for the same clock.
  const t = layoutTimeline(i.m, { byId: id => (SITE.modelById.get(id) || {}).m, href: () => null, graph: {}, sources: () => [], status: () => null, news: () => [], now: new Date(now) });
  assert.ok(Math.abs(Number(tl.style.getPropertyValue("--today")) - (t.today + t.T0 - Number(tl.getAttribute("data-t0")))) < 1e-3);
  // Far past the axis end: the marker keeps the build's as-of day.
  const later = run(TL, { now: Date.UTC(2031, 0, 1) });
  assert.match(later.byId("mh-tl-today-label").textContent, /^As of /);
  assert.equal(later.byId("mh-tl").style.getPropertyValue("--today"), "");
});

test("timeline: the page opens at the model's own date, a third from the left", () => {
  const p = run(TL, { before: byId => {
    const sc = byId("mh-tl").parentNode;
    Object.assign(sc, { scrollWidth: 3000, clientWidth: 900, scrollLeft: 0 });
    const focus = byId("mh-tl").getElementsByTagName("div").filter(d => d.hasAttribute("data-focus"));
    assert.equal(focus.length, 1, "exactly one node carries data-focus");
    all(focus[0], "span", "mh-tl-dot")[0].offsetLeft = 1500;
  } });
  assert.equal(p.byId("mh-tl").parentNode.scrollLeft, 1500 - 300);
  // A timeline that fits needs no scrolling.
  const q = run(TL, { before: byId => { Object.assign(byId("mh-tl").parentNode, { scrollWidth: 800, clientWidth: 900, scrollLeft: 0 }); } });
  assert.equal(q.byId("mh-tl").parentNode.scrollLeft, 0);
});

test("timeline: zoom buttons switch data-zoom and keep the middle of the visible stretch", () => {
  const WIDTH = { compact: 1200, normal: 2000, wide: 3200 };
  const p = run(TL, { before: byId => {
    const tl = byId("mh-tl"), sc = tl.parentNode;
    Object.defineProperty(sc, "scrollWidth", { get: () => WIDTH[tl.getAttribute("data-zoom")] });
    sc.clientWidth = 1000;
  } });
  const tl = p.byId("mh-tl"), sc = tl.parentNode, zoom = p.byId("mh-tl-zoom");
  assert.equal(zoom.hidden, false);
  const buttons = zoom.getElementsByTagName("button");
  const pressed = () => buttons.filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.getAttribute("data-zoom"));
  assert.deepEqual(pressed(), ["normal"]);
  sc.scrollLeft = 500;   // middle at 1000 of 2000: one half
  buttons.find(b => b.getAttribute("data-zoom") === "wide").dispatch("click");
  assert.equal(tl.getAttribute("data-zoom"), "wide");
  assert.deepEqual(pressed(), ["wide"]);
  assert.equal(sc.scrollLeft, 0.5 * 3200 - 500);
  buttons.find(b => b.getAttribute("data-zoom") === "compact").dispatch("click");
  assert.equal(tl.getAttribute("data-zoom"), "compact");
  assert.equal(sc.scrollLeft, 100, "0.5 of 1200 minus half the view");
  zoom.dispatch("click");
  assert.equal(tl.getAttribute("data-zoom"), "compact", "a click between the buttons changes nothing");
});

test("timeline: the picker opens another model's timeline only on its button, and resets on Back", () => {
  const p = run(TL);
  const picker = p.byId("mh-tl-picker"), pick = p.byId("mh-tl-pick"), go = p.byId("mh-tl-go");
  assert.equal(picker.hidden, false);
  const values = pick.getElementsByTagName("option").map(o => o.getAttribute("value"));
  assert.equal(values.length, SITE.models.filter(x => x.org === "example-lab").length, "the organisation's own models");
  assert.ok(values.every(v => /^\/models\/[a-z0-9-]+\/[a-z0-9-]+\/timeline\/$/.test(v)));
  go.dispatch("click");
  assert.deepEqual(p.assigned, [], "the current model: nothing to open");
  pick.value = "/models/other-lab/nova-7/timeline/";
  pick.dispatch("change");
  assert.deepEqual(p.assigned, [], "choosing is not navigating (WCAG 3.2.2)");
  go.dispatch("click");
  assert.deepEqual(p.assigned, ["/models/other-lab/nova-7/timeline/"]);
  pick.value = "javascript:alert(1)";
  go.dispatch("click");
  pick.value = "https://evil.example/models/a/b/timeline/";
  go.dispatch("click");
  assert.equal(p.assigned.length, 1, "only same-site timeline paths");
  pick.value = "/models/other-lab/nova-7/timeline/";
  p.listeners.pageshow();
  assert.equal(pick.value, "/models/example-lab/orbit-2/timeline/", "Back shows this model again");
});

test("timeline without the script: tools hidden, marker as of the build, the event list complete", () => {
  const t = html(TL);
  assert.match(t, /<div id="mh-tl-picker" class="mh-tl-picker" hidden>/);
  assert.match(t, /<div id="mh-tl-zoom" class="mh-seg" role="group" aria-label="Zoom" hidden>/);
  assert.match(t, /<script src="\/assets\/model-pages\.js" defer><\/script>/);
  assert.ok(!t.includes("/assets/models.js"), "the Explorer script is not loaded here");
});

test("dayToYear and todayAt: fractional years as in timeline.mjs", () => {
  const sandbox = { __MH_TEST__: true };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  const api = sandbox.__MHP__;
  assert.equal(api.dayToYear(Date.UTC(2024, 0, 1) / DAY_MS), 2024);
  assert.ok(Math.abs(api.dayToYear(Date.UTC(2024, 6, 2) / DAY_MS) - (2024 + 183 / 366)) < 1e-12);
  assert.ok(Math.abs(api.todayAt(2020, Date.UTC(2026, 9, 1, 23, 59)) - (2026 + 273 / 365 + 0.5 / 366 - 2020)) < 1e-12, "the UTC day, not the hour");
});
