/* AI Radar Model History: small enhancements of two pre-rendered pages.
   Company page (design 1a): the family chips filter the chronology in place.
   Model timeline (design 3a): zoom buttons, the model picker, and the Today marker.
   Everything works without this file: the chips and tools stay hidden, the chronology and the
   event list are complete, the marker says "As of <date>". No requests, no cookies, no storage,
   nothing in the URL. */
(function () {
"use strict";

const DAY_MS = 86400000;
const TIMELINE_HREF = /^\/models\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/timeline\/$/;
const hasClass = (n, c) => (" " + (n.getAttribute("class") || "") + " ").indexOf(" " + c + " ") >= 0;
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
const setHidden = (n, h) => { if (n.hidden !== h) n.hidden = h; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The button a click landed on (or inside), if it carries attribute `attr`.
function buttonOf(e, root, attr) {
  for (let n = e.target; n && n !== root; n = n.parentNode) if (n.hasAttribute && n.hasAttribute(attr)) return n;
  return null;
}
function press(buttons, attr, value) {
  for (let i = 0; i < buttons.length; i++) {
    const p = buttons[i].getAttribute(attr) === value ? "true" : "false";
    if (buttons[i].getAttribute("aria-pressed") !== p) buttons[i].setAttribute("aria-pressed", p);
  }
}

/* ---------- Company page: family chips ----------
   Items of other families get `hidden`; a year, or a "<year> · exact date unknown" group,
   with nothing left is hidden too, and the year counts follow. */
function company() {
  const bar = document.getElementById("mh-family-chips"), chrono = document.getElementById("chronology");
  if (!bar || !chrono) return;
  const buttons = bar.getElementsByTagName("button"), items = [], years = [];
  const lis = chrono.getElementsByTagName("li");
  for (let i = 0; i < lis.length; i++) {
    if (hasClass(lis[i], "mh-chrono-item")) items.push(lis[i]);
    else if (hasClass(lis[i], "mh-year")) years.push(lis[i]);
  }
  const status = document.createElement("span");
  status.className = "mh-visually-hidden";
  status.setAttribute("role", "status");
  bar.appendChild(status);
  function apply(fam) {
    press(buttons, "data-family", fam);
    items.forEach(li => setHidden(li, fam !== "" && li.getAttribute("data-mh-family") !== fam));
    let total = 0;
    years.forEach(y => {
      let shown = 0, head = null, count = null;
      const kids = y.children;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (hasClass(k, "mh-year-head")) { const s = k.getElementsByTagName("span"); count = s.length ? s[s.length - 1] : null; }
        else if (hasClass(k, "mh-group-head")) head = k;
        else if (hasClass(k, "mh-chrono-items")) {
          const its = k.getElementsByTagName("li");
          let n = 0;
          for (let j = 0; j < its.length; j++) if (hasClass(its[j], "mh-chrono-item") && !its[j].hidden) n++;
          if (head) setHidden(head, n === 0);
          head = null;
          shown += n;
        }
      }
      setHidden(y, shown === 0);
      if (count && hasClass(count, "mh-year-count")) setText(count, plural(shown, "model", "models"));
      total += shown;
    });
    setText(status, fam === "" ? `All ${plural(items.length, "model", "models")}` : `Showing ${total} of ${plural(items.length, "model", "models")}`);
  }
  bar.addEventListener("click", e => {
    const b = buttonOf(e, bar, "data-family");
    if (b) apply(b.getAttribute("data-family"));
  });
  bar.hidden = false;
}

/* ---------- Model timeline ----------
   Zoom switches data-zoom on #mh-tl; models.css holds the three layouts the build computed.
   The picker opens another model's timeline only on its button (WCAG 3.2.2: a select that
   navigates on change moves keyboard users away on the first arrow key). */
const dayToYear = day => {
  const d = new Date(day * DAY_MS), y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1) / DAY_MS, len = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / DAY_MS;
  return y + (day - start) / len;
};
// Same position rule as timeline.mjs: the middle of today's UTC day, relative to T0.
const todayAt = (t0, now) => dayToYear(Math.floor(now / DAY_MS)) + 0.5 / 366 - t0;

function timeline() {
  const tl = document.getElementById("mh-tl");
  if (!tl) return;
  // Today: the build drew the marker at its as-of day. It moves to the real today only while
  // that still falls on the drawn axis (the build adds room after the as-of day).
  const t0 = parseFloat(tl.getAttribute("data-t0")), span = parseFloat(tl.getAttribute("data-span"));
  const label = document.getElementById("mh-tl-today-label");
  if (isFinite(t0) && isFinite(span) && label && tl.style) {
    const t = todayAt(t0, Date.now());
    if (t > 0 && t <= span) {
      tl.style.setProperty("--today", String(Math.round(t * 10000) / 10000));
      setText(label, "Today");
    }
  }
  // Open at the model's own date, a third from the left, not at the start of the axis.
  const sc = tl.parentNode, divs = tl.getElementsByTagName("div");
  for (let i = 0; i < divs.length; i++) {
    if (!divs[i].hasAttribute("data-focus")) continue;
    const parts = divs[i].getElementsByTagName("span");
    for (let j = 0; j < parts.length; j++) {
      const x = parts[j].offsetLeft;
      if (hasClass(parts[j], "mh-tl-dot") && typeof x === "number" && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3);
    }
    break;
  }
  const zoom = document.getElementById("mh-tl-zoom");
  if (zoom) {
    const buttons = zoom.getElementsByTagName("button");
    zoom.addEventListener("click", e => {
      const b = buttonOf(e, zoom, "data-zoom"), z = b && b.getAttribute("data-zoom");
      if (!z || z === tl.getAttribute("data-zoom")) return;
      // Keep the middle of the visible stretch in the middle.
      const w = sc.scrollWidth, mid = w ? (sc.scrollLeft + sc.clientWidth / 2) / w : null;
      tl.setAttribute("data-zoom", z);
      press(buttons, "data-zoom", z);
      if (mid !== null && isFinite(mid)) sc.scrollLeft = Math.max(0, mid * sc.scrollWidth - sc.clientWidth / 2);
    });
    zoom.hidden = false;
  }
  const picker = document.getElementById("mh-tl-picker"), pick = document.getElementById("mh-tl-pick"), go = document.getElementById("mh-tl-go");
  if (picker && pick && go) {
    const opts = pick.getElementsByTagName("option");
    let current = null;
    for (let i = 0; i < opts.length; i++) if (opts[i].hasAttribute("selected")) current = opts[i].getAttribute("value");
    go.addEventListener("click", () => {
      const v = pick.value;
      if (TIMELINE_HREF.test(v) && v !== current) location.assign(v);
    });
    // Back from the next page (back/forward cache) shows this model again, not the last pick.
    window.addEventListener("pageshow", () => { if (current !== null) pick.value = current; });
    picker.hidden = false;
  }
}

const api = { todayAt, dayToYear };
if (typeof globalThis !== "undefined" && globalThis.__MH_TEST__ === true) globalThis.__MHP__ = api;
if (typeof document !== "undefined") {
  const main = document.getElementsByTagName("main")[0], view = main && main.getAttribute("data-mh-view");
  if (view === "company") company();
  else if (view === "timeline") timeline();
}
})();
