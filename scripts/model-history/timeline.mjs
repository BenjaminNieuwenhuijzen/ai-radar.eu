/* Model History: the per-model timeline (design 3a, /models/<org>/<slug>/timeline/).
   Collects every dated event of one model (lifecycle, milestones, variants, related models,
   source events, AI Radar coverage) and lays them out on one horizontal axis for the three
   zoom levels. The page switches zoom with CSS only (data-zoom on the container), so the
   build computes a label lane per zoom and the browser never recomputes the layout.
   Pure functions; the generator passes accessors so this file does not depend on its internals. */
import { parseDate, interval, sortKey, formatDate, toInstant } from "./lib.mjs";
import { timelineDate } from "./derive.mjs";

export const ZOOMS = { compact: 160, normal: 260, wide: 420 };   // px per year, as in the design
// LABEL_W fits "Milestone · 30 Sep 2024" in the 10px mono meta line.
export const LABEL_W = 140, LABEL_H = 52, AXIS = 280, PAD_X = 40, UNKNOWN_DX = 70, HEIGHT = 560;
// Label lanes: the design's six (three above, three below the axis). When a busy stretch
// fills them all, more lanes are added further out instead of letting labels overlap.
const LANE_STEP = 68, MAX_LANES = 16, TOP_ROOM = 40, BOTTOM_ROOM = 24;
const laneAt = i => ({ s: i % 2 === 0 ? -1 : 1, o: 22 + LANE_STEP * Math.floor(i / 2) });
export const KIND_LABEL = { life: "Lifecycle", mile: "Milestone", lin: "Lineage", src: "Source", news: "AI Radar" };
const KIND_ORDER = { life: 0, mile: 1, src: 2, lin: 3, news: 4 };
const SOURCE_NOUN = {
  announcement: "Announcement", "blog-post": "Blog post", "model-card": "Model card", "system-card": "System card",
  "technical-report": "Technical report", "research-paper": "Paper", documentation: "Documentation",
  "api-reference": "API reference", "release-notes": "Release notes", changelog: "Changelog",
  "deprecation-notice": "Deprecation notice", "press-release": "Press release", repository: "Repository",
  "code-release": "Code release", "model-hub-page": "Model page", "news-article": "News article",
  interview: "Interview", encyclopedia: "Encyclopedia entry", other: "Source"
};

/* ---------- Time as fractional years ---------- */
const DAY_MS = 86400000;
const dayToYear = day => {
  const d = new Date(day * DAY_MS), y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1) / DAY_MS, len = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / DAY_MS;
  return y + (day - start) / len;
};
// [start, end] of a date value in fractional years; end is the end of the last day.
export function yearRange(value) {
  const iv = interval(value);
  return iv ? [dayToYear(iv[0]), dayToYear(iv[1] + 1)] : null;
}
const isoDay = v => (typeof v === "string" ? v.slice(0, 10) : null);
const fmtDay = v => formatDate({ value: isoDay(v) });
// Labels on the axis are LABEL_W wide: "Lineage · 2 Dec 2024" fits, the full month does not.
const MONTH = /\b(January|February|March|April|June|July|August|September|October|November|December)\b/;
const shortDate = dv => formatDate(dv).replace(MONTH, m => m.slice(0, 3));

/* ---------- Events ----------
   Each event: { kind, label, dv: {value, qualifier} | null, note, href? }.
   ctx: { byId(id) -> model, href(model) -> url, graph (deriveGraph().byModel), sources(model) -> [source],
          status(sourceId) -> machine state | null, news(model) -> [{ publishedAt, title }] } */
export function modelEvents(m, ctx) {
  const ev = [];
  const add = (kind, label, dv, note, href) => ev.push({ kind, label, dv: dv && dv.value ? { value: dv.value, qualifier: dv.qualifier || null } : null, note: note || null, href: href || null });
  const d = m.dates || {};
  const td = timelineDate(m);
  if (d.announced && (!td || td.kind !== "announced")) add("life", "Announced", d.announced);
  if (td) { add("life", td.kind === "announced" ? "Announced" : "Released", td.dv); ev[ev.length - 1].focus = true; }
  else add("life", "Released", null, "No date in any source");
  if (d.deprecated) add("life", "Deprecated", d.deprecated);
  if (d.retired) add("life", "Retired", d.retired);
  for (const x of m.milestones || []) if (x && x.date) add("mile", x.label, x.date);
  for (const v of m.variants || []) {
    const vd = v.dates && (v.dates.released || v.dates.announced);
    if (vd) add("mile", `${v.name} ${v.dates.released ? "released" : "announced"}`, vd);
  }
  const g = (ctx.graph && ctx.graph[m.id]) || { predecessors: [], successors: [], parents: [], children: [] };
  const rel = (prefix, id) => {
    const o = ctx.byId(id); if (!o) return;
    const otd = timelineDate(o);
    add("lin", `${prefix} ${o.name}`, otd ? otd.dv : null, otd ? null : "Date unknown", ctx.href(o));
  };
  g.predecessors.forEach(id => rel("Predecessor", id));
  g.parents.forEach(id => rel("Based on", id));
  g.successors.forEach(id => rel("Successor", id));
  g.children.forEach(id => {
    const o = ctx.byId(id); if (!o) return;
    const r = (o.relations || []).find(x => x.target === m.id) || {};
    rel(r.type === "variant-of" ? "Variant" : r.type === "revision-of" ? "Revision" : "Derived", id);
  });
  // Source events: only the model's own (primary) documents; secondary coverage is not part of its life.
  for (const s of ctx.sources(m)) {
    if (s.provenance === "secondary") continue;
    const noun = SOURCE_NOUN[s.type] || "Source";
    if (s.publishedAt && parseDate(s.publishedAt.value)) add("src", `${noun} published`, s.publishedAt);
    if (s.archiveUrl && s.archivedAt && parseDate(isoDay(s.archivedAt))) add("src", `${noun} archived`, { value: isoDay(s.archivedAt) });
    const st = ctx.status(s.id);
    const archiveInUse = s.archiveUrl && !(st && st.archiveState === "gone") ? "Archived copy in use" : null;
    const machineWins = st && st.stateSince && (toInstant(s.lastCheckedAt) === null || Date.parse(st.stateSince) > toInstant(s.lastCheckedAt));
    if (machineWins && st.state === "unavailable" && parseDate(isoDay(st.stateSince))) {
      const checks = st.consecutiveFailures >= 3 && st.firstFailureAt ? `${ordinal(st.consecutiveFailures)} failed check since ${fmtDay(st.firstFailureAt)}` : null;
      add("src", `${noun} unavailable`, { value: isoDay(st.stateSince) }, [checks, archiveInUse].filter(Boolean).join(" · "));
    } else if (!machineWins && (s.availability === "unavailable" || s.availability === "archived") && s.lastCheckedAt && parseDate(isoDay(s.lastCheckedAt))) {
      add("src", `${noun} found unavailable`, { value: isoDay(s.lastCheckedAt) }, archiveInUse);
    }
  }
  return ev;
}
const ordinal = n => (["", "First", "Second", "Third", "Fourth", "Fifth"][n] || `${n}th`);

/* ---------- Layout ---------- */
export function layoutTimeline(m, ctx) {
  const events = modelEvents(m, ctx);
  const news = (ctx.news(m) || []).filter(n => n && n.publishedAt).slice().sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
  const now = ctx.now || new Date();
  const todayT = dayToYear(Math.floor(now.getTime() / DAY_MS)) + 0.5 / 366;

  // Items on the axis: dated events grouped per identical date value; news as one range item.
  const dated = events.filter(e => e.dv);
  const groups = new Map();
  for (const e of dated) { const k = e.dv.value + "|" + (e.dv.qualifier || ""); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const items = [];
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const head = sorted[0], r = yearRange(head.dv.value);
    // focus: the model's own timeline date; the page opens scrolled to it.
    items.push({ kind: head.kind, label: head.label + (sorted.length > 1 ? ` +${sorted.length - 1}` : ""), meta: `${KIND_LABEL[head.kind]} · ${shortDate(head.dv)}`, r, t: (r[0] + r[1]) / 2, ranged: parseDate(head.dv.value).precision !== "day", focus: list.some(e => e.focus) });
  }
  let newsItem = null;
  if (news.length) {
    const a = yearRange(isoDay(news[0].publishedAt)), b = yearRange(isoDay(news[news.length - 1].publishedAt));
    const m0 = isoDay(news[0].publishedAt).slice(0, 7), m1 = isoDay(news[news.length - 1].publishedAt).slice(0, 7);
    const rangeLabel = formatDate({ value: m0 }) + (m0 !== m1 ? ` – ${formatDate({ value: m1 })}` : "");
    // On the axis the label already says "news items"; the meta is only the (short) range.
    const shortRange = shortDate({ value: m0 }) + (m0 !== m1 ? ` – ${shortDate({ value: m1 })}` : "");
    newsItem = { kind: "news", label: `${news.length} ${news.length === 1 ? "news item" : "news items"}`, meta: shortRange, r: [a[0], b[1]], t: (a[0] + b[1]) / 2, ranged: news.length > 1, rangeLabel };
    items.push(newsItem);
  }
  const starts = items.map(i => i.r[0]), ends = items.map(i => i.r[1]);
  const T0 = Math.floor(starts.length ? Math.min(...starts) - 0.25 : todayT - 1);
  const T1 = Math.max(todayT, ...(ends.length ? ends : [todayT])) + 0.15;
  const span = T1 - T0;
  for (const e of events.filter(e => !e.dv)) items.push({ kind: e.kind, label: e.label, meta: `${KIND_LABEL[e.kind]} · Date unknown`, r: null, t: null, unknown: true });

  // Per zoom: x in px, then the first free label lane. The axis and the canvas height follow
  // the lanes in use, so a busy model gets a taller timeline rather than overlapping labels.
  const xAt = (i, z) => PAD_X + (i.unknown ? span * z + UNKNOWN_DX : (i.t - T0) * z);
  const lanes = {}, geometry = {};
  for (const [zk, z] of Object.entries(ZOOMS)) {
    const order = items.map((i, n) => ({ i, n, x: xAt(i, z) })).sort((a, b) => a.x - b.x || a.n - b.n);
    const last = Array.from({ length: 6 }, () => -1e9);
    for (const o of order) {
      let li = last.findIndex(v => v <= o.x - LABEL_W / 2 - 6);
      if (li < 0 && last.length < MAX_LANES) { last.push(-1e9, -1e9); li = last.length - 2; }
      if (li < 0) li = last.indexOf(Math.min(...last));
      last[li] = o.x + LABEL_W / 2;
      (lanes[o.n] = lanes[o.n] || {})[zk] = laneAt(li);
    }
    const used = Object.values(lanes).map(l => l[zk]);
    const above = Math.max(0, ...used.filter(l => l.s < 0).map(l => l.o)), below = Math.max(0, ...used.filter(l => l.s > 0).map(l => l.o));
    const axis = Math.max(AXIS, TOP_ROOM + above + LABEL_H);
    geometry[zk] = { axis, height: Math.max(HEIGHT, axis + below + LABEL_H + BOTTOM_ROOM) };
  }
  const nodes = items.map((i, n) => ({ ...i, rel: i.unknown ? null : { t: i.t - T0, r0: i.r[0] - T0, r1: i.r[1] - T0 }, lane: lanes[n] }));
  const years = [];
  for (let y = Math.ceil(T0); y <= Math.floor(T1); y++) years.push({ year: y, t: y - T0 });

  // Text list: every event separately (not grouped), plus the news range, in date order.
  const list = events.map(e => ({ date: e.dv ? formatDate(e.dv) : "Date unknown", dt: e.dv ? e.dv.value : null, kind: KIND_LABEL[e.kind], label: e.label, note: e.note, href: e.href, sk: e.dv ? sortKey(e.dv.value) : sortKey(null) }));
  if (newsItem) list.push({ date: newsItem.rangeLabel, dt: null, kind: KIND_LABEL.news, label: newsItem.label, note: "Snapshots kept after items leave the live feed", href: null, sk: sortKey(isoDay(news[0].publishedAt)) });
  list.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));

  return { T0, span, today: todayT - T0, nodes, years, list, geometry, count: events.length + (newsItem ? 1 : 0) };
}
