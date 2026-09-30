/* AI Radar content pages: theme and motion buttons, live theme/motion sync.
   The inline script in <head> has already set data-theme and data-motion
   before first paint; this file only handles changes after that. Keys are
   shared with the dashboard, so a choice made there applies here too. */
(function () {
  "use strict";

  var THEME_KEY = "airadar-theme";
  var MOTION_KEY = "airadar-motion";
  var BG = { light: "#f7f6f2", dark: "#111215" };  // --bg per theme
  var root = document.documentElement;

  function query(q) {
    try { return window.matchMedia ? window.matchMedia(q) : null; } catch (e) { return null; }
  }
  var darkQuery = query("(prefers-color-scheme: dark)");
  var reduceQuery = query("(prefers-reduced-motion: reduce)");

  function read(key, a, b) {
    try {
      var v = localStorage.getItem(key);
      return v === a || v === b ? v : null;
    } catch (e) { return null; }
  }

  function systemTheme() { return darkQuery && darkQuery.matches ? "dark" : "light"; }
  function systemMotion() { return reduceQuery && reduceQuery.matches ? "off" : "on"; }

  // Both theme-color metas get the effective colour, so the browser bar
  // follows an explicit choice even when it differs from the system theme.
  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", BG[theme]);
  }

  // The label is switched by CSS on data-motion; the title says what a click does.
  var motionButtons = document.querySelectorAll("[data-motion-toggle]");
  function applyMotion(motion) {
    root.setAttribute("data-motion", motion);
    for (var i = 0; i < motionButtons.length; i++) {
      motionButtons[i].title = motion === "off" ? "Turn animations on" : "Turn animations off";
    }
  }

  applyTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
  applyMotion(root.getAttribute("data-motion") === "off" ? "off" : "on");

  var buttons = document.querySelectorAll("[data-theme-toggle]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    });
  }

  for (var j = 0; j < motionButtons.length; j++) {
    motionButtons[j].addEventListener("click", function () {
      var next = root.getAttribute("data-motion") === "off" ? "on" : "off";
      applyMotion(next);
      try { localStorage.setItem(MOTION_KEY, next); } catch (e) {}
    });
  }

  // Follow system changes live, but only while no explicit choice is stored.
  function listen(mq, fn) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener("change", fn);
    else if (mq.addListener) mq.addListener(fn);
  }
  listen(darkQuery, function () {
    if (!read(THEME_KEY, "light", "dark")) applyTheme(systemTheme());
  });
  listen(reduceQuery, function () {
    if (!read(MOTION_KEY, "on", "off")) applyMotion(systemMotion());
  });

  // A choice made in another tab (for example on the dashboard) applies here too.
  window.addEventListener("storage", function (e) {
    if (e.key === THEME_KEY || e.key === null) applyTheme(read(THEME_KEY, "light", "dark") || systemTheme());
    if (e.key === MOTION_KEY || e.key === null) applyMotion(read(MOTION_KEY, "on", "off") || systemMotion());
  });
})();
