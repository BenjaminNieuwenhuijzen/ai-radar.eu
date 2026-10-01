/* FICTIONAL registry for the Model History build tests: same shape as assets/registry.js
   (window.AIRadarRegistry = { logos, companies, logoFor }). Both logos use the "__U__"
   placeholder in their internal ids, like the real Google and Meta logos, so the tests
   can check that every occurrence on a page gets a unique id (AC-27). */
(function () {
"use strict";
const LOGOS = {
  acme: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="acmegrad__U__" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#335"/><stop offset="1" stop-color="#99c"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="4" fill="url(#acmegrad__U__)"/></svg>`,
  zenith: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="zenclip__U__"><circle cx="12" cy="12" r="10"/></clipPath></defs><rect width="24" height="24" fill="#c63" clip-path="url(#zenclip__U__)"/></svg>`
};
const COMPANIES = [
  { id: "acme", name: "Acme AI", display: "Acme", hue: 255, official: true, logo: LOGOS.acme },
  { id: "zenith", name: "Zenith Labs", display: "Zenith", hue: 285, official: true, logo: LOGOS.zenith },
  { id: "across", name: "Across AI", display: "Across AI", hue: null, official: false, aggregate: true, logo: "" }
];
let logoUid = 0;
function logoFor(logo) {
  if (!logo) return "";
  return logo.includes("__U__") ? logo.replaceAll("__U__", "u" + (logoUid++)) : logo;
}
window.AIRadarRegistry = { logos: LOGOS, companies: COMPANIES, logoFor };
})();
