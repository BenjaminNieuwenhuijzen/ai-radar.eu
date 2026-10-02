/* Tests for the per-model timeline (design 3a): event collection and the per-zoom layout. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataset } from "../lib.mjs";
import { buildIndex, deriveGraph, modelClaims } from "../derive.mjs";
import { modelEvents, layoutTimeline, yearRange, ZOOMS, LABEL_W } from "../timeline.mjs";

const ds = loadDataset(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "basic"));
const idx = buildIndex(ds);
const graph = deriveGraph(ds).byModel;
const ctx = (news = {}) => ({
  byId: id => idx.modelById.get(id),
  href: o => `/models/${idx.routeOrg(o)}/${o.slug}/`,
  graph,
  sources: m => { const ids = new Set(); for (const c of modelClaims(m)) for (const r of c.claim.sources || []) ids.add(r.id); return [...ids].map(id => idx.srcById.get(id)).filter(Boolean); },
  status: id => idx.status[id] || null,
  news: m => news[m.id] || [],
  now: new Date("2026-10-01T12:00:00Z")
});
const M = id => idx.modelById.get(id);

test("yearRange covers the whole period of month and year precision", () => {
  const [a, b] = yearRange("2024-06");
  assert.ok(a > 2024.41 && a < 2024.42 && b > 2024.49 && b < 2024.5, `${a} ${b}`);
  const [c, d] = yearRange("2019");
  assert.equal(c, 2019); assert.equal(d, 2020);
  const [e, f] = yearRange("2024-06-11");
  assert.ok(f > e && f - e < 0.003);
});

test("Orbit 2: lifecycle, milestone, variant, lineage and source events", () => {
  const ev = modelEvents(M("example-lab.orbit-2"), ctx());
  const labels = ev.map(e => e.label);
  for (const l of ["Announced", "Released", "Retired", "Open weights published", "Orbit 2 Mini released",
    "Predecessor Orbit 1", "Successor Orbit 2.5", "Successor Orbit 3", "Successor Orbit Lite 1",
    "Variant Orbit 2 Vision", "Revision Orbit 2 (September 2024 revision)", "Announcement published", "Blog post published"]) {
    assert.ok(labels.includes(l), `missing ${l}`);
  }
  // Secondary coverage is not an event in the model's life.
  assert.ok(!ev.some(e => e.kind === "src" && /News article/.test(e.label)));
  // Related-model events link to that model's page.
  assert.equal(ev.find(e => e.label === "Successor Orbit 3").href, "/models/example-lab/orbit-3/");
});

test("no invented precision: month and year stay month and year", () => {
  const t = layoutTimeline(M("example-lab.orbit-1"), ctx());
  const rel = t.list.find(e => e.label === "Released");
  assert.equal(rel.date, "March 2021");
  assert.equal(rel.dt, "2021-03");
  const node = t.nodes.find(n => n.label.startsWith("Released"));
  assert.equal(node.ranged, true);
  assert.ok(node.rel.r1 - node.rel.r0 > 0.08 && node.rel.r1 - node.rel.r0 < 0.09);   // one month wide
});

test("source events: archived copy, and a machine-detected disappearance with its failed checks", () => {
  const e1 = modelEvents(M("example-lab.orbit-1"), ctx());
  assert.ok(e1.some(e => e.label === "Documentation archived" && e.dv.value === "2021-04-01"));
  assert.ok(e1.some(e => e.label === "Documentation found unavailable" && e.note === "Archived copy in use"));
  const e0 = modelEvents(M("example-lab-research.orbit-0"), ctx());
  const gone = e0.find(e => e.label === "Model card unavailable");
  assert.ok(gone, "orbit-0 model card event");
  assert.equal(gone.dv.value, "2026-10-05");
  assert.match(gone.note, /^Third failed check since 26 September 2026$/);
});

test("a model without any date sits in the Date unknown zone and is listed last", () => {
  const t = layoutTimeline(M("other-lab.nova-6"), ctx());
  const rel = t.nodes.find(n => n.label === "Released");
  assert.equal(rel.unknown, true);
  assert.equal(rel.rel, null);
  assert.equal(t.list[t.list.length - 1].date, "Date unknown");
  assert.equal(t.list[t.list.length - 1].note, "No date in any source");
});

test("events on the same date are grouped on the axis but listed separately", () => {
  const t = layoutTimeline(M("example-lab.orbit-2"), ctx());
  const node = t.nodes.find(n => n.label.startsWith("Released"));
  assert.equal(node.label, "Released +2");   // release, Mini and the launch post on 11 June 2024
  assert.equal(node.meta, "Lifecycle · 11 Jun 2024");
  assert.equal(t.list.filter(e => e.date === "11 June 2024").length, 3);
  // The page opens scrolled to the model's own timeline date: exactly that node is marked.
  assert.deepEqual(t.nodes.filter(n => n.focus).map(n => n.label), ["Released +2"]);
  assert.equal(layoutTimeline(M("other-lab.nova-6"), ctx()).nodes.some(n => n.focus), false, "no date, no focus");
  assert.equal(layoutTimeline(M("example-lab.orbit-lite-1"), ctx()).nodes.find(n => n.focus).meta, "Lifecycle · 2025?");
});

test("AI Radar coverage is one range item; the list notes that snapshots are kept", () => {
  const t = layoutTimeline(M("example-lab.orbit-2"), ctx({ "example-lab.orbit-2": [{ publishedAt: "2026-07-02T15:00:00Z" }, { publishedAt: "2026-08-14T00:00:00Z" }] }));
  const n = t.nodes.find(x => x.kind === "news");
  assert.equal(n.label, "2 news items");
  assert.equal(n.meta, "Jul 2026 – Aug 2026", "short months on the axis label; the list has the full range");
  const l = t.list.find(x => x.kind === "AI Radar");
  assert.equal(l.date, "July 2026 – August 2026");
  assert.equal(l.note, "Snapshots kept after items leave the live feed");
  assert.equal(t.count, modelEvents(M("example-lab.orbit-2"), ctx()).length + 1);
});

test("labels never overlap within a lane, for every zoom", () => {
  for (const id of ds.models.map(m => m.id)) {
    const t = layoutTimeline(M(id), ctx());
    for (const [zk, z] of Object.entries(ZOOMS)) {
      const byLane = new Map();
      for (const n of t.nodes) {
        const lane = n.lane[zk], key = `${lane.s}:${lane.o}`;
        const x = 40 + (n.unknown ? t.span * z + 70 : n.rel.t * z);
        if (!byLane.has(key)) byLane.set(key, []);
        byLane.get(key).push(x);
      }
      // Only six lanes exist, so a crowded model may reuse the least-recently-used lane; the fixture must not.
      for (const xs of byLane.values()) {
        xs.sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= LABEL_W + 6, `${id} ${zk}: labels overlap`);
      }
    }
  }
});

test("the axis starts before the first event and ends after today", () => {
  const t = layoutTimeline(M("example-lab.orbit-2"), ctx());
  assert.ok(t.nodes.every(n => n.unknown || (n.rel.r0 >= 0 && n.rel.r1 <= t.span)));
  assert.ok(t.today > 0 && t.today < t.span);
  assert.ok(t.years.every(y => y.t >= 0 && y.t <= t.span));
});

test("a document published before the model's first date is not an event in its timeline", () => {
  for (const m of ds.models) {
    const d = m.dates || {}, firsts = [d.announced, d.released].filter(x => x && x.value).map(x => yearRange(x.value)[0]);
    if (!firsts.length) continue;
    const first = Math.min(...firsts);
    for (const e of modelEvents(m, ctx()).filter(e => e.kind === "src" && / published$/.test(e.label)))
      assert.ok(yearRange(e.dv.value)[1] > first, `${m.id}: "${e.label}" (${e.dv.value}) predates the model`);
  }
});