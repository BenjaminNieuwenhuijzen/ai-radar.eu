/* AI Radar redesign prototype: routing between the screens in index.html and just
   enough behaviour to click through them. Static sample data, no requests. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement, body = document.body;
  var screens = $$(".screen"), main = $("#main");
  var current = null;

  /* ---------- storage (own keys: never touches the live site's data) ---------- */
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function announce(t) { var a = $("#announcer"); if (a) a.textContent = t; }

  /* ---------- routing ---------- */
  function routeOf() {
    var h = location.hash;
    if (h.indexOf("#/") !== 0) return "/";
    var r = h.slice(1).replace(/\/+$/, "");
    return r || "/";
  }
  function pretty(slug) {
    return slug.split("-").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }
  function show() {
    var r = routeOf();
    var scr = screens.find(function (s) { return s.dataset.route === r || s.dataset.altRoute === r; });
    if (!scr) {
      var under = r.indexOf("/models/") === 0;
      scr = screens.find(function (s) { return s.dataset.route === (under ? "/not-built" : "/404"); });
      if (under) {
        var parts = r.split("/").filter(Boolean);
        var name = parts[2] ? pretty(parts[2]) + (parts[3] === "timeline" ? ", timeline" : "") : pretty(parts[1] || "this page");
        var slot = $("[data-notbuilt-name]", scr);
        if (slot) slot.textContent = name;
      }
    }
    var changed = scr !== current;
    screens.forEach(function (s) { s.hidden = s !== scr; });
    current = scr;
    document.title = scr.dataset.title + " | AI Radar redesign prototype";
    $$("#siteNav a").forEach(function (a) {
      if (a.dataset.nav && a.dataset.nav === scr.dataset.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    $("#siteNav").classList.remove("is-open");
    $("#menuBtn").setAttribute("aria-expanded", "false");
    if (scr.classList.contains("screen--home")) setView(r === "/timeline" ? "timeline" : "company", changed);
    if (changed) { window.scrollTo(0, 0); }
    var p = $(".proto"); if (p) p.open = false;
  }
  window.addEventListener("hashchange", show);

  /* in-page anchors (sources, sections, the subscribe band) must not disturb the hash route */
  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (!a) return;
    var h = a.getAttribute("href");
    if (h.indexOf("#/") === 0 || h === "#") return;
    ev.preventDefault();
    var go = function () {
      var t = document.getElementById(h.slice(1));
      if (!t) return;
      t.scrollIntoView({ block: "start" });
      if (t.tabIndex < 0 && !t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
      t.focus({ preventScroll: true });
    };
    if (h === "#subscribe" && !(current && current.classList.contains("screen--home"))) {
      location.hash = "#/";
      setTimeout(go, 30);
    } else go();
  });

  /* ---------- theme mode ---------- */
  var modeBtn = $("#modeBtn");
  function isDark() {
    var m = root.getAttribute("data-mode");
    if (m) return m === "dark";
    return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function syncMode() {
    var d = isDark();
    modeBtn.textContent = d ? "Light mode" : "Dark mode";
    modeBtn.setAttribute("aria-pressed", String(d));
  }
  modeBtn.addEventListener("click", function () {
    var next = isDark() ? "light" : "dark";
    root.setAttribute("data-mode", next);
    write("airadar-proto-mode", next);
    syncMode();
  });
  syncMode();

  /* ---------- menu on narrow screens ---------- */
  $("#menuBtn").addEventListener("click", function () {
    var open = $("#siteNav").classList.toggle("is-open");
    this.setAttribute("aria-expanded", String(open));
  });

  /* ---------- status strip: the countdown is data, so it ticks ---------- */
  var cd = $("#countdown");
  var left = (function () { var p = cd.textContent.split(":").map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; })();
  setInterval(function () {
    if (body.classList.contains("is-offline")) return;
    left = left > 0 ? left - 1 : 7200;
    var h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
    cd.textContent = h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }, 1000);

  /* ---------- dashboard: top stories ---------- */
  var tabs = $$(".top__tab");
  function pick(i, focus) {
    tabs.forEach(function (t, k) {
      var on = k === i, p = document.getElementById(t.getAttribute("aria-controls"));
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      p.classList.toggle("is-on", on);
    });
    if (focus) tabs[i].focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { pick(i, false); });
    t.addEventListener("keydown", function (ev) {
      var d = ev.key === "ArrowDown" || ev.key === "ArrowRight" ? 1 : ev.key === "ArrowUp" || ev.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      ev.preventDefault();
      pick((i + d + tabs.length) % tabs.length, true);
    });
  });

  /* ---------- dashboard: feed ---------- */
  var st = { view: "company", cat: "all", q: "", savedOnly: false, more: false };
  var saved = new Set((read("airadar-proto-saved") || "").split(",").filter(Boolean));
  var viewCompany = $("#viewCompany"), viewTimeline = $("#viewTimeline"), empty = $("#empty");
  var feedTitle = $("#feedTitle"), search = $("#search"), savedBtn = $("#savedBtn");

  function setView(v, quiet) {
    st.view = v;
    $$("[data-view]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.view === v)); });
    feedTitle.textContent = v === "company" ? "Posts by company" : "Timeline";
    applyFilters();
    if (!quiet) { /* the view switch keeps the reader at the feed */ }
  }
  $$("[data-view]").forEach(function (b) {
    b.addEventListener("click", function () {
      var y = window.scrollY;
      location.hash = b.dataset.view === "timeline" ? "#/timeline" : "#/";
      requestAnimationFrame(function () { window.scrollTo(0, y); });
    });
  });

  function matches(p) {
    var cats = (p.dataset.cats || "").split(" ");
    return (st.cat === "all" || cats.indexOf(st.cat) !== -1) &&
      (!st.q || (p.dataset.q || "").indexOf(st.q) !== -1) &&
      (!st.savedOnly || saved.has(p.dataset.post));
  }
  function applyFilters() {
    var filtering = st.cat !== "all" || !!st.q || st.savedOnly, any = false;
    if (st.view === "company") {
      var visible = [];
      $$(".co", viewCompany).forEach(function (co) {
        var open = co.classList.contains("is-open"), n = 0;
        $$(".post", co).forEach(function (p, i) {
          var ok = matches(p) && (filtering || open || !p.classList.contains("is-extra"));
          p.hidden = !ok;
          p.classList.toggle("post--first", ok && n === 0);
          if (ok) n++;
        });
        var more = $(".co__more", co);
        if (more) more.hidden = filtering;
        co.hidden = n === 0;
        co.style.removeProperty("--span");
        co.classList.remove("co--wide");
        if (n) visible.push(co);
      });
      var rest = visible.length % 3;
      var wide = rest === 1 ? visible.slice(-1) : rest === 2 ? visible.slice(-2) : [];
      wide.forEach(function (c) { c.style.setProperty("--span", rest === 1 ? "6" : "3"); c.classList.add("co--wide"); });
      any = visible.length > 0;
    } else {
      var shown = 0;
      $$(".day", viewTimeline).forEach(function (day) {
        var n = 0;
        $$(".post", day).forEach(function (p) {
          var ok = matches(p) && (st.more || !p.classList.contains("is-extra"));
          p.hidden = !ok;
          if (ok) n++;
        });
        day.hidden = n === 0;
        shown += n;
      });
      any = shown > 0;
      var moreRow = $(".tl__more", viewTimeline);
      moreRow.hidden = filtering;
      $("#tlShown").textContent = String(shown);
    }
    viewCompany.hidden = st.view !== "company" || !any;
    viewTimeline.hidden = st.view !== "timeline" || !any;
    if (!any && empty.hidden) announce("Nothing matches these filters.");
    empty.hidden = any;
  }
  $$(".chip[data-cat]").forEach(function (c) {
    c.addEventListener("click", function () {
      st.cat = c.dataset.cat;
      $$(".chip[data-cat]").forEach(function (o) { o.setAttribute("aria-pressed", String(o === c)); });
      applyFilters();
    });
  });
  search.addEventListener("input", function () { st.q = search.value.trim().toLowerCase(); applyFilters(); });
  savedBtn.addEventListener("click", function () {
    st.savedOnly = !st.savedOnly;
    savedBtn.setAttribute("aria-pressed", String(st.savedOnly));
    applyFilters();
  });
  function syncSaved() {
    $$(".save").forEach(function (b) { b.setAttribute("aria-pressed", String(saved.has(b.dataset.save))); });
    $("#savedCount").textContent = String(saved.size);
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest && ev.target.closest(".save");
    if (b) {
      var id = b.dataset.save;
      if (saved.has(id)) saved.delete(id); else saved.add(id);
      write("airadar-proto-saved", Array.from(saved).join(","));
      syncSaved();
      if (st.savedOnly) applyFilters();
      return;
    }
    var m = ev.target.closest && ev.target.closest("[data-more]");
    if (m) {
      var co = m.closest(".co"), open = co.classList.toggle("is-open");
      m.setAttribute("aria-expanded", String(open));
      m.textContent = open ? "Show less" : m.dataset.label;
      applyFilters();
      return;
    }
    if (ev.target.closest && ev.target.closest("[data-clearfilters]")) clearFilters();
  });
  function clearFilters() {
    st.cat = "all"; st.q = ""; st.savedOnly = false; search.value = "";
    savedBtn.setAttribute("aria-pressed", "false");
    $$(".chip[data-cat]").forEach(function (o) { o.setAttribute("aria-pressed", String(o.dataset.cat === "all")); });
    applyFilters();
  }
  var loadMore = $("[data-loadmore]");
  loadMore.addEventListener("click", function () {
    st.more = true;
    applyFilters();
    loadMore.disabled = true;
    loadMore.textContent = "All sample posts shown";
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    var f = current && current.classList.contains("screen--home") ? search : current && current.classList.contains("screen--explorer") ? $("#xSearch") : null;
    if (f) { ev.preventDefault(); f.focus(); }
  });
  syncSaved();

  /* ---------- dashboard states (from the prototype map) ---------- */
  var pill = $("#newPill"), errbar = $("#errorBar"), liveLabel = $("#liveLabel");
  function clearState() {
    body.classList.remove("is-offline", "is-loading", "is-failed");
    pill.hidden = true; errbar.hidden = true; liveLabel.textContent = "Live";
    $("[data-loadfail]").hidden = true;
  }
  function setState(s) {
    clearState();
    if (!(current && current.classList.contains("screen--home"))) location.hash = "#/";
    if (s === "new") pill.hidden = false;
    if (s === "offline") { body.classList.add("is-offline"); errbar.hidden = false; liveLabel.textContent = "Offline"; }
    if (s === "loading") body.classList.add("is-loading");
    if (s === "failed") { body.classList.add("is-failed"); $("[data-loadfail]").hidden = false; }
    if (s === "empty") { clearFilters(); search.value = "zeppelin"; st.q = "zeppelin"; applyFilters(); }
    if (s === "new" || s === "empty") setTimeout(function () { $("#feed").scrollIntoView({ block: "start" }); }, 40);
    else window.scrollTo(0, 0);
  }
  $$("[data-state]").forEach(function (b) { b.addEventListener("click", function () { setState(b.dataset.state); $(".proto").open = false; }); });
  $$("[data-state-clear]").forEach(function (b) { b.addEventListener("click", function () { clearState(); clearFilters(); $(".proto").open = false; }); });
  pill.addEventListener("click", function () { pill.hidden = true; });
  document.addEventListener("click", function (ev) { var pr = $(".proto"); if (pr.open && !pr.contains(ev.target)) pr.open = false; });

  /* ---------- Model History: explorer ---------- */
  var xBody = $("#xBody"), xRows = $$("tr", xBody), xSearch = $("#xSearch"), xEmpty = $("#xEmpty");
  var xSort = "date-desc";
  function xApply() {
    var q = xSearch.value.trim().toLowerCase();
    var sel = function (n) { return $$('.facets input[name="' + n + '"]:checked').map(function (i) { return i.value; }); };
    var orgs = sel("org"), years = sel("year"), lifes = sel("life");
    var n = 0;
    xRows.forEach(function (r) {
      var ok = (!q || r.dataset.q.indexOf(q) !== -1) && (!orgs.length || orgs.indexOf(r.dataset.org) !== -1) &&
        (!years.length || years.indexOf(r.dataset.year) !== -1) && (!lifes.length || lifes.indexOf(r.dataset.life) !== -1);
      r.hidden = !ok; if (ok) n++;
    });
    var by = { "date-desc": function (a, b) { return a.dataset.date < b.dataset.date ? 1 : -1; }, "date-asc": function (a, b) { return a.dataset.date > b.dataset.date ? 1 : -1; }, "name": function (a, b) { return a.dataset.name.localeCompare(b.dataset.name); }, "org": function (a, b) { return a.dataset.orgname.localeCompare(b.dataset.orgname) || (a.dataset.date < b.dataset.date ? 1 : -1); } }[xSort];
    xRows.slice().sort(by).forEach(function (r) { xBody.appendChild(r); });
    xEmpty.hidden = n > 0;
    $(".x__table").hidden = n === 0;
  }
  xSearch.addEventListener("input", xApply);
  $$(".facets input").forEach(function (i) { i.addEventListener("change", xApply); });
  $$("#xSort button").forEach(function (b) {
    b.addEventListener("click", function () {
      xSort = b.dataset.sort;
      $$("#xSort button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      xApply();
    });
  });
  $("[data-xclear]").addEventListener("click", function () {
    xSearch.value = ""; $$(".facets input").forEach(function (i) { i.checked = false; }); xApply();
  });
  var facetWrap = $(".facets__wrap");
  if (facetWrap && window.matchMedia && matchMedia("(max-width: 60rem)").matches) facetWrap.open = false;

  /* ---------- Model History: organisation, family chips ---------- */
  $$("[data-family-chips]").forEach(function (group) {
    var scr = group.closest(".screen");
    $$(".chip", group).forEach(function (c) {
      c.addEventListener("click", function () {
        $$(".chip", group).forEach(function (o) { o.setAttribute("aria-pressed", String(o === c)); });
        var f = c.dataset.family;
        $$("[data-year]", scr).forEach(function (y) {
          var n = 0;
          $$(".chrono__item", y).forEach(function (it) { var ok = !f || it.dataset.family === f; it.hidden = !ok; if (ok) n++; });
          y.hidden = n === 0;
        });
      });
    });
  });

  /* ---------- Model History: timeline ---------- */
  $$("[data-zoomseg]").forEach(function (seg) {
    var chart = $(".tlc__chart", seg.closest(".screen"));
    $$("button", seg).forEach(function (b) {
      b.addEventListener("click", function () {
        chart.dataset.zoom = b.dataset.zoom;
        $$("button", seg).forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      });
    });
  });
  $$("[data-pick-go]").forEach(function (b) {
    b.addEventListener("click", function () { location.hash = $("[data-pick]", b.parentNode).value; });
  });

  /* a picture that fails to load leaves no empty frame */
  $$(".photo img").forEach(function (im) {
    var gone = function () { var f = im.closest(".photo"); if (f) f.hidden = true; };
    if (im.complete && !im.naturalWidth) gone(); else im.addEventListener("error", gone, { once: true });
  });

  show();
})();
