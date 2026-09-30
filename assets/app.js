/* AI Radar dashboard (redesign 1c "Hybrid").
   Plain JS, no dependencies, no build step. The page reads /data.json (rebuilt every two
   hours by a GitHub Action) and, when the build has an API key, /digest.json for the
   "Today in AI" carousel. Everything is same-origin: no CDNs, proxies or analytics.

   Sections: config · logos · companies & categories · helpers · taxonomy · storage ·
   state · data · render helpers · header · carousel · latest · feed · live updates ·
   theme & motion · events · init. */
(function () {
"use strict";

/* ---------- Config ---------- */
const SLIDE_SECONDS = 7;          // carousel autoplay interval
const MAX_SLIDES = 5;
const POSTS_PER_CARD = 4;         // collapsed card: lead + 3 rows (mobile: lead + 2)
const CARD_MAX = 12;              // posts in an expanded card
const TIMELINE_PAGE = 50;         // timeline rows per "Load more"
const LATEST_COUNT = 5;
const POLL_MS = 5 * 60 * 1000;    // background check for a new build
const FRESH_MS = 3500;            // how long new posts keep their highlight class
const HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
// Build schedule: cron "17 */2 * * *" (minute 17 of every even UTC hour). Same
// arithmetic as nextCronSlot() in scripts/build-feed.mjs.
const CRON_PERIOD_MS = 2 * HOUR, CRON_OFFSET_MS = 17 * 60000;
const nextSlot = t => (Math.floor((t - CRON_OFFSET_MS) / CRON_PERIOD_MS) + 1) * CRON_PERIOD_MS + CRON_OFFSET_MS;

const KEY_SAVED = "airadar-saved", KEY_THEME = "airadar-theme", KEY_MOTION = "airadar-motion";
// Keys of features the redesign dropped (feed cache, "new since last visit", company
// selection, manual card order, remembered view). Removed once so they don't linger.
const OBSOLETE_KEYS = ["ai-dashboard-cache-v3", "mm-seen-v1", "mm-companies-v1", "mm-order-v1", "mm-view"];

/* Logos, companies and logoFor() live in assets/registry.js, which index.html loads
   before this file; the Model History pages use the same registry. */
const REGISTRY = window.AIRadarRegistry;

/* Source labels per company type (the companies themselves come from the registry). */
const SRC_LABELS = {
  official: ["Official feed", "Read from the company's own feed(s)."],
  community: ["Community feed", "No official RSS feed; updates come from a community-maintained feed and may lag behind."],
  industry: ["Industry news", "Stories from across the AI world, aggregated from general AI news feeds: industry-wide, policy, society and emerging labs."]
};
const COMPANIES = REGISTRY.companies.map((c, order) => {
  const [srcLabel, srcTitle] = SRC_LABELS[c.aggregate ? "industry" : c.official ? "official" : "community"];
  return Object.assign({}, c, { order, srcLabel, srcTitle, aggregate: !!c.aggregate });
});
const COMPANY_BY_NAME = new Map(COMPANIES.map(c => [c.name, c]));
const COMPANY_BY_ID = new Map(COMPANIES.map(c => [c.id, c]));

// Category chips: label, the taxonomy key from categorizeAll(), and the URL slug.
const CATEGORIES = [
  { key: "all", label: "All", slug: "" },
  { key: "model", label: "Model releases", slug: "model-releases" },
  { key: "product", label: "Products", slug: "products" },
  { key: "onderzoek", label: "Research", slug: "research" },
  { key: "developer", label: "Developer", slug: "developer" },
  { key: "hardware", label: "Hardware", slug: "hardware" },
  { key: "applied", label: "Applied AI", slug: "applied-ai" },
  { key: "funding", label: "Business", slug: "business" },
  { key: "safety_policy", label: "Safety & policy", slug: "safety-policy" },
  { key: "overig", label: "Other", slug: "other" }
];
const CAT_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));
const CAT_BY_SLUG = Object.fromEntries(CATEGORIES.filter(c => c.slug).map(c => [c.slug, c]));

/* "Across AI" items often centre on one tracked company; `about` names it so the right
   logo shows. Items with an `id` come from a build that sets `about` itself (no field =
   no tracked company), and normalize() uses that as is. Only older data.json files
   without ids are matched here: ABOUT_RULES and aboutCompany() are copies of the ones in
   scripts/build-feed.mjs (the reasons for each pattern are noted there) and must stay
   identical, same order and flags. */
const ABOUT_RULES = [
  ["OpenAI", /\b(OpenAI|ChatGPT|GPT-?\d)/i],
  ["OpenAI", /\b(Sora|Codex)\b/],
  ["Anthropic", /(?:^|[^\w-])(Anthropic|Claude)\b/i],
  ["Google (AI & DeepMind)", /\b(Google|DeepMind|Gemini|Alphabet)\b/],
  ["Meta AI", /\b(Meta|Llama|Zuckerberg)\b/],
  ["Microsoft AI", /\b(Microsoft|Copilot)\b/],
  ["NVIDIA", /\bNVIDIA\b/i],
  ["Hugging Face", /\bHugging ?Face\b/i],
  ["xAI (Grok)", /\b(xAI|Grok)\b/],
  ["Perplexity", /\bPerplexity\b/],
  ["Mistral AI", /\bMistral\b/],
  ["Cohere", /\bCohere\b/],
  ["DeepSeek", /\bDeepSeek\b/i]
];
// The company mentioned earliest in the title wins, else earliest in the summary;
// "" when neither names a tracked company. On a tie the first rule listed wins.
function aboutCompany(title, summary) {
  for (const text of [title || "", summary || ""]) {
    let best = "", at = Infinity;
    for (const [company, re] of ABOUT_RULES) {
      const i = text.search(re);
      if (i !== -1 && i < at) { at = i; best = company; }
    }
    if (best) return best;
  }
  return "";
}

/* ---------- Helpers ---------- */
// Stable post id: must stay byte-identical to postId() in scripts/build-feed.mjs, so
// bookmarks and digest items keep pointing at the same post across builds.
const cyrb53 = (str, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
const postKey = link => (link || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
const postId = link => cyrb53(postKey(link)).toString(36);

// Feed text is untrusted: everything interpolated into markup goes through here.
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
const esc = escapeHtml;
// Only http(s) links become hrefs; images only as same-origin paths from the build.
const safeLink = s => (typeof s === "string" && /^https?:\/\/\S+$/i.test(s.trim()) ? s.trim() : "");
function safeImage(s) {
  if (typeof s !== "string") return "";
  s = s.trim();
  if (!s || s.startsWith("//") || s.includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(s) || !/^[\w./-]+$/.test(s)) return "";
  return "/" + s.replace(/^\/+/, "");      // data.json paths are relative to the site root
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = n => String(n).padStart(2, "0");
// The whole site speaks UTC, like the build schedule in the header.
const hhmm = t => { const d = new Date(t); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); };
const shortDate = t => { const d = new Date(t); return DAYS[d.getUTCDay()].slice(0, 3) + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()].slice(0, 3); };
const dayLabel = t => { const d = new Date(t); return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; };
const dayKey = t => Math.floor(t / DAY);
const utcDay = t => new Date(t).toISOString().slice(0, 10);
function relShort(t, now) {
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h";
  return Math.round(h / 24) + "d";
}
function relText(t, now, ago, dateOnly) {
  // Date-only posts (stored at 00:00 UTC) count in UTC days: no false hours.
  if (dateOnly) {
    const days = dayKey(now) - dayKey(t);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days + "d" + (ago ? " ago" : "");
  }
  const r = relShort(t, now);
  return ago ? (r === "now" ? "just now" : r + " ago") : r;
}
function fmtCountdown(sec) {
  return Math.floor(sec / 3600) + ":" + pad(Math.floor(sec / 60) % 60) + ":" + pad(sec % 60);
}
const $ = id => document.getElementById(id);

/* ---------- Taxonomy (unchanged from the previous dashboard) ---------- */
/* Heuristic: flag posts that seem to be about a new or updated AI model.
   Signals: a model name with a version number, a known model name, or a
   model word combined with a release word. Not foolproof. */
const VERSION_PAT = /\b(gpt|claude|gemini|gemma|llama|grok|mistral|codex|sonar|veo|imagen|sora|deepseek|qwen|opus|sonnet|haiku|fable|mythos)[ -]?v?\d+(\.\d+)?\b/i;
const NAMED_MODEL = /\b(voxtral|magistral|sam[ -]?\d|glm-?\d|olmo\w*|diffusiongemma|gpt-image|seamless interaction|dinov?\d|granite[ -]?\d|molmo\w*|phi-?\d|qwen|paddleocr|speciesnet|weathernext|alphafold|alphago)\b/i;
const MODEL_WORDS = /\b(model|llm|foundation model|frontier model|reasoning model|multimodal|vision model|weights|checkpoint)\b/i;
const RELEASE_WORDS = /\b(introduc\w+|announc\w+|releas\w+|launch\w*|unveil\w*|now available|general availability|preview|upgrade\w*|updated?|new (model|family|version))\b/i;
function isModelUpdate(it) {
  const t = (it.title || "") + " " + (it.summary || "");
  return VERSION_PAT.test(t) || NAMED_MODEL.test(t) || (MODEL_WORDS.test(t) && RELEASE_WORDS.test(t));
}

/* Category classification per post, based on title and summary. A post can have
   several categories; the first one is its primary label. An automated estimate. */
function categorizeAll(it) {
  const t = ((it.title || "") + " " + (it.summary || "")).toLowerCase();
  const cats = [];
  if (/(fundrais|\bfunding\b|\braise[sd]?\b|valuation|valued at|\bseries [abc]\b|\bipo\b|\bs-1\b|\bm&a\b|acquisition|acquir\w+|\bmerger\b|backed by|\binvest(ment|or|ed|ing)?\b|\bstake\b|\$\s?\d+(\.\d+)?\s?(b|bn|billion|m|mn|million)|\d+\s?gigawatt|partner(ship|s|ing|ed)?\b|collaborat\w+|\bdeal\b|in talks|\bmulls\b|\beyes\b|\bweighs\b|revenue|earnings|\bprofit|appoint\w*|board of directors|representative director|general manager|\bceo\b|\bcfo\b)/.test(t)) cats.push("funding");
  if (/(safety|\bsecur|cyber|threat|\bpolic(y|ies)|regulat|governance|privacy|misuse|jailbreak|red.?team|alignment|biodefense|guardrail|responsible ai|content moderation|\bteens?\b|child safety|\bminors?\b|age verif|watermark|confidential comput|blacklist|\bban(s|ned)?\b|sanction|export control|national security|security risk|antitrust|lawsuit|\bchina\b|chinese|beijing|\bmilitary\b|espionage)/.test(t)) cats.push("safety_policy");
  if (/(\bgpus?\b|\bchips?\b|\bhardware\b|blackwell|\bcuda\b|\bkernels?\b|instinct|\bmi3\d\d|\bmtia\b|\btpu\b|data cent|datacenter|data center|\bgigawatt|\bcompute\b|infrastructure|ai factor|infiniband|optical backbone|silicon|\bwafer|\bfab\b|semiconductor|accelerat\w*|private cloud compute|\brtx\b|interconnect|fusion kernel|robot\w*|sovereign|supercomput\w*|\bgrid\b|on-device)/.test(t)) cats.push("hardware");
  if (isModelUpdate(it)) cats.push("model");
  if (/(benchmark\w*|mlperf|leaderboard|state.of.the.art|\bsota\b|\beval(uation|s)?\b|\bpaper\b|arxiv|\bresearch\b|scaling law|ablation|\bstudy\b|novel method|theorem|hypothesis|we trained|reasoning|self-supervised|interpretability|\bscience\b|scientific|biolog\w*|genom\w*|chemist\w*|chemistry|physics|mathemat\w*|protein|molecul\w*|neuron\w*|\bbrain\b|quantum|forecasting|simulat\w*)/.test(t)) cats.push("onderzoek");
  if (/(how to|how-to|tutorial|\bguide\b|developer.s guide|walkthrough|deep dive|explained|recipe|cookbook|getting started|step.by.step|fine-tun\w*|\blora\b|quantiz\w*|profiling|pytorch|transformers\.js|\btensors?\b|softmax|low-precision|\bsdk\b|\bapis?\b|integrat\w+|connector|\bextensions?\b|\bmigrat\w+|\bmcp\b|build(ing)? (a|your)|code review|\bdebug|agent framework|agent platform|orchestrat\w*|\ba2a\b|agent skills|scaffold|\bharness\b|multi-agent|\binference\b|continuous batching|distributed (ai )?training|\bembeddings?\b)/.test(t)) cats.push("developer");
  if (/(uses ai|using ai|ai-powered|powered by ai|\bhelps?\b|how .* uses|diagnos\w*|\bpatient|clinic\w*|hospital|\bdiseases?\b|genetic|\bdrugs?\b|medicine|cancer|\bhealth\b|conservation|wildlife|species|\bclimate|weather|\bstorms?\b|\bflood|restoration|case study|customer|deploy\w*|real-world|freelanc|aged care|\bfans\b|race operations|\beducation\b|farming|agricultur\w*|insurance|\bretail\b|\bfinance\b|\blegal\b|government|public sector|workforce|\bjobs\b)/.test(t)) cats.push("applied");
  if (/(new feature|\bfeatures?\b|now available|available now|rolling out|\brollout|general availability|\bbeta\b|\bpreview\b|redesign|custom voice|custom skills|\bmemories\b|record & replay|spend controls|usage analytics|scheduling|subscription|pricing|open.sourc\w*|\bapps?\b|desktop|\bupdates?\b|\blaunch\w*|introduc\w+|\bagents?\b|agentic|generally available|\bis here\b|available to)/.test(t)) cats.push("product");
  return cats.length ? cats : ["overig"];
}

const logoFor = REGISTRY.logoFor;

/* ---------- Storage ---------- */
// localStorage can throw (private mode, blocked site data); every access is guarded.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not persisted */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } }
};
function migrateStorage() {
  // Bookmarks used to be stored as links (mm-saved-v1); they are now post ids.
  if (store.get(KEY_SAVED) === null) {
    try {
      const old = JSON.parse(store.get("mm-saved-v1"));
      if (Array.isArray(old)) {
        const ids = old.filter(l => typeof l === "string" && l).map(postId);
        store.set(KEY_SAVED, JSON.stringify([...new Set(ids)]));
      }
    } catch (e) { /* unreadable old value: start empty */ }
  }
  store.del("mm-saved-v1");
  store.del("mm-theme");          // migrated by the pre-paint script in index.html
  OBSOLETE_KEYS.forEach(k => store.del(k));
}
function loadSaved() {
  try {
    const a = JSON.parse(store.get(KEY_SAVED));
    return new Set(Array.isArray(a) ? a.filter(x => typeof x === "string") : []);
  } catch (e) { return new Set(); }
}

/* ---------- State ---------- */
const state = {
  data: null,             // the data.json on screen
  posts: [],              // normalised posts, newest first
  byId: new Map(),
  latest: null,           // newest data.json seen by polling (may hold pending posts)
  pendingPosts: null,     // normalised posts of `latest`, waiting for the pill click
  pendingIds: [],
  fresh: new Set(),       // ids highlighted after the pill click
  digest: null,           // valid, recent digest.json v2 or null
  view: "company",        // "company" | "timeline" (URL)
  cat: "all",             // category key (URL)
  company: "",            // company id: timeline limited to one company (URL)
  query: "",
  savedOnly: false,
  saved: new Set(),
  expanded: {},           // company id -> expanded card
  shown: TIMELINE_PAGE,   // timeline rows rendered
  motion: true,
  loaded: false,
  failed: false,          // last refresh failed
  lastCheck: 0,
  nextRefreshAt: nextSlot(Date.now())
};

/* ---------- Data ---------- */
async function fetchData() {
  // no-cache revalidates with the server (ETag) instead of busting the cache.
  const res = await fetch("/data.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("data.json: HTTP " + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.items)) throw new Error("data.json: no items");
  return data;
}

// digest.json only exists when the build has an API key. data.json says whether it
// does ("digest": true), so the file is only requested when it is really there.
async function fetchDigest(data) {
  if (!data || data.digest !== true) return null;
  try {
    const res = await fetch("/digest.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const d = await res.json();
    const now = Date.now();
    const recent = d && (d.date === utcDay(now) || d.date === utcDay(now - DAY));
    return d && d.v === 2 && recent && Array.isArray(d.items) && d.items.length ? d : null;
  } catch (e) { return null; }
}

function normalize(data) {
  const out = [], seen = new Set();
  for (const it of data.items) {
    const co = it && COMPANY_BY_NAME.get(it.company);
    if (!co) continue;                                   // unknown company: ignored
    const link = safeLink(it.link);
    const t = Date.parse(it.date);
    if (!link || !isFinite(t)) continue;                 // nothing to open or to place in time
    // Ids end up in attributes and selectors: accept only the build's base-36 format.
    // A valid id also marks the current data format (see ABOUT_RULES).
    const built = typeof it.id === "string" && /^[0-9a-z]{1,16}$/.test(it.id);
    const id = built ? it.id : postId(link);
    if (seen.has(id)) continue;
    seen.add(id);
    const rawTitle = String(it.title || "").trim(), summary = String(it.summary || "").trim();
    let title = rawTitle, via = String(it.source || "").trim();
    // Google News titles end in " - Outlet": show the outlet as the source instead.
    if (via === "Google News") {
      const i = title.lastIndexOf(" - ");
      if (i > 0 && title.length - i <= 60) { via = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); }
    }
    if (!title) continue;
    const d = new Date(t);
    // Date-only feeds are stored at exactly 00:00:00 UTC: don't print a fake time.
    const dateOnly = !d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds() && !d.getUTCMilliseconds();
    const raw = { title: rawTitle, summary };
    let about = null;
    if (co.aggregate) {
      // The build's verdict when there is one (no `about` = none), derived only for old data.
      const name = built ? it.about : aboutCompany(rawTitle, summary);
      about = (typeof name === "string" && COMPANY_BY_NAME.get(name)) || null;
      if (about && about.aggregate) about = null;
    }
    out.push({
      id, co, title, link, t, dateOnly, desc: summary, image: safeImage(it.image), via, about,
      cats: categorizeAll(raw), model: isModelUpdate(raw),
      hay: (title + " " + summary + " " + co.display + " " + co.name).toLowerCase()
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

function applyData(data, posts) {
  state.data = data;
  state.latest = data;
  state.posts = posts;
  state.byId = new Map(posts.map(p => [p.id, p]));
  state.pendingPosts = null;
  state.pendingIds = [];
  const next = Date.parse(data.nextFetchAt), now = Date.now();
  state.nextRefreshAt = next > now ? next : nextSlot(now);
  renderStatus();
  updateSavedBtn();
}

function filtered() {
  const q = state.query.trim().toLowerCase();
  return state.posts.filter(p =>
    (state.cat === "all" || p.cats.includes(state.cat)) &&
    (!state.company || p.co.id === state.company) &&
    (!state.savedOnly || state.saved.has(p.id)) &&
    (!q || p.hay.includes(q)));
}

/* ---------- Render helpers ---------- */
const BOOKMARK = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
const coClass = co => (co.hue == null ? " co-neutral" : "");
const coStyle = co => (co.hue == null ? "" : ` style="--h:${co.hue}"`);
const freshClass = p => (state.fresh.has(p.id) ? " is-fresh" : "");
const fullDate = p => shortDate(p.t) + " " + new Date(p.t).getUTCFullYear() + (p.dateOnly ? "" : ", " + hhmm(p.t) + " UTC");

// Metadata label: the post's primary category, or the active chip when the post has it.
function catLabel(p) {
  const k = state.cat !== "all" && p.cats.includes(state.cat) ? state.cat : p.cats[0];
  return CAT_BY_KEY[k].label;
}

function logoBox(co, size) {
  return `<span class="logo logo-${size}" aria-hidden="true">${logoFor(co.logo)}</span>`;
}
function initials(via) {
  return String(via || "").replace(/^the\s+/i, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "AI";
}
// Across AI posts show the logo of the company they are about, else the outlet's initials.
function postLogo(p, size) {
  if (p.about) return logoBox(p.about, size);
  if (p.co.aggregate) return `<span class="logo logo-${size} logo-initials" aria-hidden="true">${esc(initials(p.via))}</span>`;
  return logoBox(p.co, size);
}

// Image box with a fixed aspect; missing or broken images show the logo on --soft.
const fallbackKey = p => (p.about || p.co).id;
function fallbackHtml(key) {
  const co = COMPANY_BY_ID.get(key) || COMPANY_BY_ID.get("across");
  return `<span class="media-fb" aria-hidden="true">${logoFor(co.logo)}</span>`;
}
function mediaHtml(p, cls, opts = {}) {
  const inner = p.image
    ? `<img src="${esc(p.image)}" alt="" ${opts.eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async">`
    : fallbackHtml(fallbackKey(p));
  const attrs = `class="media ${cls}" data-fb="${fallbackKey(p)}"`;
  // A second link to the same post: kept out of the tab order and the accessibility tree.
  return opts.link
    ? `<a ${attrs} href="${esc(p.link)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${inner}</a>`
    : `<span ${attrs}>${inner}</span>`;
}

function relHtml(p, ago) {
  return `<time class="rel" datetime="${new Date(p.t).toISOString()}" data-t="${p.t}"${ago ? " data-ago" : ""}${p.dateOnly ? " data-day" : ""} title="${esc(fullDate(p))}">${relText(p.t, Date.now(), ago, p.dateOnly)}</time>`;
}
const metaHtml = p => `<span class="meta">${esc(catLabel(p))} · ${relHtml(p)}</span>`;

// The name says which post; aria-pressed carries the state. Only the tooltip changes.
const saveTip = on => (on ? "Remove from saved" : "Save post");
function saveHtml(p) {
  const on = state.saved.has(p.id);
  return `<button type="button" class="save hit" data-save="${p.id}" aria-pressed="${on}" aria-label="Save: ${esc(p.title)}" title="${saveTip(on)}">${BOOKMARK}</button>`;
}

/* ---------- Header ---------- */
function renderStatus() {
  const d = state.data;
  const at = d ? Date.parse(d.lastFetchedAt || d.generated) : NaN;
  el.updated.textContent = "Updated " + (isFinite(at) ? hhmm(at) : "--:--") + " UTC";
  // "Sources" = the build's feed count (data.json "sources"); older data lacks it,
  // then the number of cards stands in.
  const feeds = d && d.sources > 0 ? d.sources : COMPANIES.length;
  el.sources.textContent = feeds + " sources";
  el.sources.title = d && d.sources > 0
    ? d.sources + " source feeds behind " + (COMPANIES.length - 1) + " company cards and Across AI"
    : (COMPANIES.length - 1) + " companies plus Across AI";
  el.live.classList.toggle("is-offline", state.failed);
  el.liveLabel.textContent = state.failed ? "Offline" : "Live";
}

// Every second: the countdown. At zero, check for the new build and move to the next slot.
function tick() {
  const now = Date.now();
  if (state.nextRefreshAt <= now) {
    state.nextRefreshAt = nextSlot(now);
    poll();
  }
  el.countdown.textContent = fmtCountdown(Math.max(0, Math.ceil((state.nextRefreshAt - now) / 1000)));
}

// Every minute: relative times ("12m", "3h") without re-rendering.
function refreshRelTimes() {
  const now = Date.now();
  document.querySelectorAll("time.rel").forEach(n => {
    const s = relText(+n.dataset.t, now, n.hasAttribute("data-ago"), n.hasAttribute("data-day"));
    if (n.textContent !== s) n.textContent = s;
  });
}

/* ---------- Carousel ---------- */
// stopped = autoplay switched off for this carousel with its pause button.
const car = { slides: [], index: 0, hover: false, focus: false, stopped: false, key: "" };

// Slides come from the digest (AI-written text) when there is a recent one, else they
// are picked automatically: recent model releases first, one per company, with image.
function pickSlides() {
  const d = state.digest;
  if (d) {
    const slides = [];
    for (const it of d.items) {
      const p = it && state.byId.get(it.sourcePostId);
      if (!p || slides.length >= MAX_SLIDES) continue;
      slides.push({ post: p, title: String(it.title || p.title), text: String(it.text || "") });
    }
    if (slides.length) return { digest: true, date: Date.parse(d.date + "T12:00:00Z"), slides };
  }
  const now = Date.now(), picks = [], used = new Set();
  const withImage = state.posts.filter(p => p.image && p.t <= now + HOUR);
  const take = (list, pred) => {
    for (const p of list) {
      if (picks.length >= MAX_SLIDES) return;
      if (!used.has(p.co.id) && pred(p)) { picks.push(p); used.add(p.co.id); }
    }
  };
  for (const hours of [72, 168]) {        // widen to 7 days only when 72 hours is too thin
    if (picks.length >= MAX_SLIDES) break;
    const recent = withImage.filter(p => now - p.t <= hours * HOUR);
    take(recent, p => p.model);
    take(recent, () => true);
  }
  return { digest: false, date: now, slides: picks.map(p => ({ post: p, title: p.title, text: p.desc })) };
}

function slideHtml(s, i, n) {
  const p = s.post;
  // A div: ARIA in HTML does not allow role="group" on <article>.
  return `<div class="slide${coClass(p.co)}"${coStyle(p.co)} role="group" aria-roledescription="slide" aria-label="${i + 1} of ${n}">
  <div class="slide-text">
    <p class="slide-kicker">${postLogo(p, 28)}<span class="co-name">${esc(p.co.display)}</span><span class="slide-cat">${esc(CAT_BY_KEY[p.cats[0]].label)}</span></p>
    <h3 class="slide-title">${esc(s.title)}</h3>
    ${s.text ? `<p class="slide-desc">${esc(s.text)}</p>` : ""}
    <p class="slide-foot"><a class="slide-link hit" href="${esc(p.link)}" target="_blank" rel="noopener">Read the original<span class="visually-hidden">: ${esc(p.title)}</span> →</a><span class="slide-meta">${p.via ? `<span class="slide-via">${esc(p.via)}</span>&nbsp;·&nbsp;` : ""}${relHtml(p, true)}</span></p>
  </div>
  ${mediaHtml(p, "media-slide", { link: true, eager: i === 0 })}
</div>`;
}

function renderCarousel() {
  const pick = pickSlides(), n = pick.slides.length;
  const key = pick.slides.map(s => s.post.id + s.title).join("|") + pick.digest;
  el.hero.classList.toggle("no-carousel", !n);
  el.carousel.hidden = !n;
  el.carouselTitle.textContent = "Today in AI";
  el.carouselDate.textContent = " · " + shortDate(pick.date);
  el.carouselBadge.hidden = false;
  el.carouselBadge.textContent = pick.digest ? "AI-generated" : "Auto-selected";
  el.carouselBadge.title = pick.digest
    ? "Written by an AI model from the linked posts. Check the original before relying on it."
    : "Picked automatically from the latest posts: recent model releases first, one per company. Not AI-generated.";
  el.carouselCtrl.hidden = n < 2;
  el.progress.hidden = n < 2;
  if (key === car.key) return;             // same slides: keep position and progress
  car.key = key;
  car.slides = pick.slides;
  car.index = 0;
  el.slides.innerHTML = pick.slides.map((s, i) => slideHtml(s, i, n)).join("");
  el.progress.innerHTML = pick.slides.map((s, i) =>
    `<button type="button" class="seg" data-seg="${i}" aria-label="Slide ${i + 1} of ${n}: ${esc(s.title)}" title="${esc(s.title)}"><span class="seg-track"><span class="seg-fill"></span></span></button>`).join("");
  goSlide(0, false);
}

function goSlide(i, manual) {
  const n = car.slides.length;
  if (!n) return;
  car.index = ((i % n) + n) % n;
  // Announce slide changes the reader asked for, not the ones autoplay makes.
  el.slides.setAttribute("aria-live", manual ? "polite" : "off");
  // Focus on the outgoing slide's link would fall to <body> once that slide is inert:
  // it moves to the new slide's link instead, so arrow keys keep working.
  const hadFocus = el.slides.contains(document.activeElement);
  [...el.slides.children].forEach((s, k) => {
    const on = k === car.index;
    s.classList.toggle("is-active", on);
    s.inert = !on;
    if (on) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
  });
  if (hadFocus) {
    const link = el.slides.children[car.index].querySelector(".slide-link");
    if (link) link.focus({ preventScroll: true });
  }
  [...el.progress.children].forEach((b, k) => {
    b.classList.toggle("is-past", k < car.index);
    b.classList.toggle("is-active", k === car.index);
    if (k === car.index) {
      b.setAttribute("aria-current", "true");
      // A fresh element restarts the fill animation from zero (manual navigation resets progress).
      const f = b.firstElementChild.firstElementChild;
      f.replaceWith(f.cloneNode(false));
    } else b.removeAttribute("aria-current");
  });
  syncCarousel();
}

// Autoplay runs as a CSS animation on the active segment; pausing only flips its
// play-state, and the slide advances on animationend.
const PAUSE_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="2" y="1.5" width="2.8" height="9"/><rect x="7.2" y="1.5" width="2.8" height="9"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 1.5v9l7.5-4.5z"/></svg>';
function syncCarousel() {
  const n = car.slides.length, auto = state.motion && n > 1 && !car.stopped;
  const paused = car.hover || car.focus || document.hidden;
  el.carousel.classList.toggle("no-autoplay", !auto);
  el.carousel.classList.toggle("is-paused", auto && paused);
  el.slideCount.textContent = (n ? car.index + 1 : 0) + " / " + n + (!auto || paused ? " · paused" : "");
  // The pause button only matters while autoplay is possible (Motion on). With Motion off
  // nothing moves, so it is hidden on phones too: there is nothing to stop.
  el.carToggle.hidden = !state.motion;
  const label = car.stopped ? "Start automatic slide changes" : "Pause automatic slide changes";
  if (el.carToggle.getAttribute("aria-label") !== label || !el.carToggle.firstChild) {
    el.carToggle.setAttribute("aria-label", label);
    el.carToggle.title = label;
    el.carToggle.innerHTML = car.stopped ? PLAY_ICON : PAUSE_ICON;
  }
}
function toggleRotation() {
  car.stopped = !car.stopped;
  if (!car.stopped) goSlide(car.index, false);   // resume: the active segment fills from zero
  else syncCarousel();
}

/* ---------- Latest ---------- */
// Clock time like the design; date-only posts show their day instead of a fake 00:00.
function latestTime(p) {
  const d = new Date(p.t);
  return p.dateOnly ? d.getUTCDate() + " " + MONTHS[d.getUTCMonth()].slice(0, 3) : hhmm(p.t);
}
function renderLatest() {
  el.latestList.innerHTML = state.posts.slice(0, LATEST_COUNT).map(p =>
    `<a class="latest-row post${freshClass(p)}${coClass(p.co)}"${coStyle(p.co)} href="${esc(p.link)}" target="_blank" rel="noopener">
  <span class="latest-text"><span class="latest-meta">${postLogo(p, 18)}<span class="co-name">${esc(p.co.display)}</span><time datetime="${new Date(p.t).toISOString()}" title="${esc(fullDate(p))}">${latestTime(p)}</time></span><span class="latest-title">${esc(p.title)}</span></span>
  ${mediaHtml(p, "media-latest")}
</a>`).join("");
}

/* ---------- Feed: by company ---------- */
// Cards: most posts this week first, then the most recent post, then config order.
function buildCards(list) {
  const weekAgo = Date.now() - WEEK, groups = new Map();
  for (const p of list) {
    let g = groups.get(p.co.id);
    if (!g) groups.set(p.co.id, (g = []));
    g.push(p);
  }
  return [...groups.values()].map(posts => ({
    co: posts[0].co, posts, newest: posts[0].t, week: posts.filter(p => p.t >= weekAgo).length
  })).sort((a, b) => b.week - a.week || b.newest - a.newest || a.co.order - b.co.order);
}

function leadHtml(p) {
  return `<div class="lead post${freshClass(p)}">
    ${mediaHtml(p, "media-lead", { link: true })}
    <div class="lead-body"><a class="lead-link" href="${esc(p.link)}" target="_blank" rel="noopener"><span class="lead-title">${esc(p.title)}</span>${metaHtml(p)}</a>${saveHtml(p)}</div>
  </div>`;
}
function rowHtml(p, extra) {
  return `<div class="row post${extra ? " is-extra" : ""}${freshClass(p)}">
    <a class="row-link" href="${esc(p.link)}" target="_blank" rel="noopener"><span class="row-text"><span class="row-title">${esc(p.title)}</span>${metaHtml(p)}</span>${mediaHtml(p, "media-thumb")}</a>${saveHtml(p)}
  </div>`;
}

function cardHtml({ co, posts, week }) {
  const open = !!state.expanded[co.id], total = posts.length;
  const [lead, ...rest] = posts.slice(0, open ? CARD_MAX : POSTS_PER_CARD);
  const count = week ? week + " this week" : total + (total === 1 ? " post" : " posts");
  let more = "";
  // Mobile collapses to lead + 2 rows, so a card with exactly 4 posts only needs the
  // button there.
  if (total > POSTS_PER_CARD - 1) {
    const label = open ? "Show less" : total <= CARD_MAX ? `View all ${total} posts →` : `View ${CARD_MAX} latest posts →`;
    const mobileOnly = !open && total === POSTS_PER_CARD ? " only-mobile" : "";
    const toTimeline = open && total > CARD_MAX
      ? `<button type="button" class="more-tl" data-tl="${co.id}">All ${total} in Timeline →</button>` : "";
    more = `<div class="card-more${mobileOnly}"><button type="button" class="more-btn" data-more="${co.id}" aria-expanded="${open}">${label}</button>${toTimeline}</div>`;
  }
  return `<article class="card${coClass(co)}"${coStyle(co)} data-co="${co.id}">
  <div class="card-bar"></div>
  <div class="card-head">
    ${logoBox(co, 34)}
    <div class="card-id"><h3 class="card-name">${esc(co.display)}</h3><span class="card-src"><span title="${esc(co.srcTitle)}">${esc(co.srcLabel)}</span> · ${count}</span></div>
    <span class="card-count" aria-hidden="true">${week || total}</span>
  </div>
  ${leadHtml(lead)}
  ${rest.map((p, i) => rowHtml(p, !open && i >= POSTS_PER_CARD - 2)).join("")}
  ${more}
</article>`;
}

function renderCompany(list) {
  el.viewCompany.innerHTML = buildCards(list).map(cardHtml).join("");
}

// View all / Show less: re-render just that card (order doesn't change) and keep focus.
function toggleCard(id) {
  state.expanded[id] = !state.expanded[id];
  const node = el.viewCompany.querySelector(`.card[data-co="${id}"]`);
  const card = buildCards(filtered()).find(c => c.co.id === id);
  if (!node || !card) return render();
  const wasAbove = node.getBoundingClientRect().top < 0;
  node.outerHTML = cardHtml(card);
  const fresh = el.viewCompany.querySelector(`.card[data-co="${id}"]`);
  if (!state.expanded[id] && wasAbove) fresh.scrollIntoView({ block: "start" });
  const btn = fresh.querySelector("[data-more]");
  if (btn) btn.focus({ preventScroll: true });
}

/* ---------- Feed: timeline ---------- */
function tlRowHtml(p) {
  const time = p.dateOnly ? "" : hhmm(p.t);
  return `<div class="tl-row post${freshClass(p)}${coClass(p.co)}"${coStyle(p.co)}>
    <span class="tl-time"${p.dateOnly ? ' title="No time given by the source"' : ""}>${time || "—"}</span>
    <span class="tl-co">${postLogo(p, 24)}<span class="co-name">${esc(p.co.display)}</span>${time ? `<span class="tl-co-time">${time}</span>` : ""}</span>
    <div class="tl-body">
      <a class="tl-title" href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      ${p.desc ? `<p class="tl-desc">${esc(p.desc)}</p>` : ""}
      <span class="meta meta-tl">${esc(catLabel(p))}${p.via ? " · " + esc(p.via) : ""}</span>
    </div>
    ${mediaHtml(p, "media-tl", { link: true })}
    ${saveHtml(p)}
  </div>`;
}

function renderTimeline(list) {
  const shown = list.slice(0, state.shown), counts = new Map();
  for (const p of list) { const k = dayKey(p.t); counts.set(k, (counts.get(k) || 0) + 1); }   // full day counts
  let html = "", day = null;
  for (const p of shown) {
    const k = dayKey(p.t);
    if (k !== day) {
      if (day !== null) html += "</section>";
      day = k;
      const n = counts.get(k);
      html += `<section class="day"><div class="day-head"><h3>${dayLabel(p.t)}</h3><span class="day-count">${n} ${n === 1 ? "post" : "posts"}</span></div>`;
    }
    html += tlRowHtml(p);
  }
  if (day !== null) html += "</section>";
  if (list.length > shown.length) {
    html += `<div class="load-more"><button type="button" class="more-btn" data-loadmore>Load more</button><span class="load-count">Showing ${shown.length} of ${list.length}</span></div>`;
  }
  el.viewTimeline.innerHTML = html;
}

function loadMore() {
  const from = state.shown;
  state.shown += TIMELINE_PAGE;
  renderTimeline(filtered());
  const row = el.viewTimeline.querySelectorAll(".tl-row")[from];
  if (row) row.querySelector(".tl-title").focus({ preventScroll: true });
}

/* ---------- Feed: dispatcher ---------- */
// animate = the staggered entrance, only for chip, view and Saved changes.
function render(animate) {
  if (!state.loaded) return;
  const list = filtered(), company = state.view === "company";
  const only = !company && COMPANY_BY_ID.get(state.company);
  el.feed.removeAttribute("aria-busy");
  // Status message for screen readers when a filter or search leaves nothing to show.
  if (!list.length && el.empty.hidden) announce("Nothing matches these filters.");
  el.empty.hidden = list.length > 0;
  el.viewCompany.hidden = !company || !list.length;
  el.viewTimeline.hidden = company || !list.length;
  el.feedTitle.textContent = company ? "Posts by company" : only ? "Timeline: " + only.display : "Timeline";
  el.coFilter.hidden = !only;
  if (only) el.coFilter.innerHTML = `<span>Only <strong>${esc(only.display)}</strong> posts</span><button type="button" class="chip hit" data-clearco>Show all companies</button>`;
  if (list.length) (company ? renderCompany : renderTimeline)(list);
  syncControls();
  if (animate && state.motion && list.length) {
    const items = company ? el.viewCompany.children : el.viewTimeline.querySelectorAll(".tl-row");
    [...items].forEach((n, i) => { n.style.setProperty("--i", Math.min(i, 14)); n.classList.add("enter"); });
  }
}
function renderAll() {
  renderLatest();
  renderCarousel();
  render(false);
}

function syncControls() {
  el.segButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  el.chipButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cat === state.cat)));
  el.savedBtn.setAttribute("aria-pressed", String(state.savedOnly));
  updateSavedBtn();
}
function updateSavedBtn() {
  // Only count bookmarks that still exist in the data (old posts age out of the feed);
  // until the data is in, no number rather than a wrong one.
  let n = 0;
  state.saved.forEach(id => { if (state.byId.has(id)) n++; });
  el.savedBtn.textContent = state.loaded ? "Saved · " + n : "Saved";
}

// View, category and the timeline's company live in the URL so filtered views can be shared.
const own = (o, k) => k != null && Object.prototype.hasOwnProperty.call(o, k);   // "?cat=constructor" is not a category
function readUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get("view") === "timeline") state.view = "timeline";
  const slug = q.get("cat");
  if (own(CAT_BY_SLUG, slug)) state.cat = CAT_BY_SLUG[slug].key;
  const co = q.get("company");
  if (state.view === "timeline" && COMPANY_BY_ID.has(co)) state.company = co;
}
function syncUrl() {
  const q = new URLSearchParams(location.search);
  q.delete("view");
  q.delete("cat");
  q.delete("company");
  if (state.view === "timeline") q.set("view", "timeline");
  if (CAT_BY_KEY[state.cat].slug) q.set("cat", CAT_BY_KEY[state.cat].slug);
  if (state.company) q.set("company", state.company);
  const s = q.toString();
  history.replaceState(history.state, "", location.pathname + (s ? "?" + s : "") + location.hash);
}

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  state.company = "";          // the company filter belongs to one trip into the timeline
  state.shown = TIMELINE_PAGE;
  syncUrl();
  render(true);
}
function setCat(c) {
  if (c === state.cat || !own(CAT_BY_KEY, c)) return;
  state.cat = c;
  state.shown = TIMELINE_PAGE;
  syncUrl();
  render(true);
}
function toggleSavedOnly() {
  state.savedOnly = !state.savedOnly;
  state.shown = TIMELINE_PAGE;
  render(true);
}
// "All N in Timeline →": exactly the card's N posts (same filters, one company) in the
// timeline. The search the reader typed stays as it is.
function openInTimeline(id) {
  const co = COMPANY_BY_ID.get(id);
  if (!co) return;
  state.view = "timeline";
  state.company = id;
  state.shown = TIMELINE_PAGE;
  syncUrl();
  render(true);
  scrollToFeed();
  // The clicked button went away with the company view.
  el.feedTitle.focus({ preventScroll: true });
  const n = filtered().length;
  announce("Timeline: " + co.display + ", " + n + (n === 1 ? " post" : " posts"));
}
function clearCompany() {
  state.company = "";
  state.shown = TIMELINE_PAGE;
  syncUrl();
  render(true);
  el.feedTitle.focus({ preventScroll: true });
}

function toggleSave(btn) {
  const id = btn.dataset.save;
  if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
  store.set(KEY_SAVED, JSON.stringify([...state.saved]));
  const on = state.saved.has(id);
  syncSaveButtons(id);
  if (state.motion) {
    btn.classList.remove("is-pop");
    void btn.offsetWidth;                // restart the pop when clicked twice quickly
    btn.classList.add("is-pop");
  }
  updateSavedBtn();
  if (state.savedOnly && !on) {
    // The unsaved post leaves the Saved list. Keep keyboard focus nearby: on the next
    // bookmark (or the previous one when it was the last), else on the Saved button.
    const view = () => [...(state.view === "company" ? el.viewCompany : el.viewTimeline).querySelectorAll("[data-save]")];
    const had = document.activeElement === btn, at = view().indexOf(btn);
    render(false);
    if (had) {
      const left = el.empty.hidden ? view() : [];   // an empty list leaves the old view hidden
      (left[Math.min(at, left.length - 1)] || el.savedBtn).focus();
    }
  }
}
function syncSaveButtons(id) {
  const on = state.saved.has(id);
  document.querySelectorAll(`[data-save="${id}"]`).forEach(b => {
    b.setAttribute("aria-pressed", String(on));
    b.title = saveTip(on);
  });
}

function scrollToFeed() {
  const top = el.feedWrap.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, behavior: state.motion ? "smooth" : "auto" });
}

/* ---------- Skeletons (shown until data.json arrives) ---------- */
function timelineSkeleton() {
  const row = `<div class="tl-row sk-row" aria-hidden="true"><span class="sk sk-time"></span><span class="tl-co"><span class="logo logo-24 sk"></span><span class="sk sk-co"></span></span><div class="tl-body"><span class="sk sk-t"></span><span class="sk sk-t sk-short"></span><span class="sk sk-meta"></span></div><span class="media media-tl sk"></span><span></span></div>`;
  return `<div class="day-head sk-head" aria-hidden="true"><span class="sk sk-day"></span></div>` + row.repeat(6);
}

/* ---------- Live updates ---------- */
let polling = false;
// manual = the reader pressed Retry: a repeated failure is announced again.
async function poll(manual) {
  if (polling) return;
  if (!state.loaded) {
    // The first load failed: the countdown, the 5-minute check and Retry try it again.
    state.lastCheck = Date.now();
    initialLoad();
    return;
  }
  polling = true;
  state.lastCheck = Date.now();
  try {
    const data = await fetchData();
    setOnline();
    if (data.generated !== state.latest.generated) {
      state.latest = data;
      const posts = normalize(data);
      const ids = posts.filter(p => !state.byId.has(p.id)).map(p => p.id);
      if (ids.length) {
        // New posts wait behind the pill, so nothing jumps while someone is reading.
        state.pendingPosts = posts;
        state.pendingIds = ids;
        const n = ids.length;
        el.newCount.textContent = n + (n === 1 ? " new post" : " new posts");
        showPill();
        announce(n + (n === 1 ? " new post available" : " new posts available"));
      } else {
        // Nothing new: swap the data in. The hero redraws in place (fixed height); the
        // feed only when the reader isn't inside it, so the page never jumps. Otherwise
        // the next filter change redraws it.
        applyData(data, posts);
        hidePill();
        renderLatest();
        renderCarousel();
        if (el.feed.getBoundingClientRect().top >= 0 && !el.feed.contains(document.activeElement)) render(false);
      }
      refreshDigest();
    }
  } catch (e) {
    setOffline(manual === true);
  } finally {
    polling = false;
  }
}

// The pill takes its own row (as designed) while the top of the feed is in view; further
// down it floats under the filter bar, so the text being read doesn't move.
function showPill() {
  const dock = el.newPill.parentElement;
  // Strictly below the bar: then something above the feed is still in view, so scroll
  // anchoring keeps that in place and the reserved row really appears above the cards.
  if (el.newPill.hidden) dock.classList.toggle("is-reserved", el.feed.getBoundingClientRect().top > (parseFloat(getComputedStyle(dock).top) || 0) + 1);
  el.newPill.hidden = false;
}
function hidePill() {
  el.newPill.hidden = true;
  el.newPill.parentElement.classList.remove("is-reserved");
}

function applyPending() {
  if (!state.pendingPosts) return;
  const ids = state.pendingIds;
  applyData(state.latest, state.pendingPosts);
  hidePill();
  state.fresh = new Set(ids);
  renderAll();
  scrollToFeed();
  el.feedTitle.focus({ preventScroll: true });
  setTimeout(() => state.fresh.clear(), FRESH_MS);
}

async function refreshDigest() {
  const d = await fetchDigest(state.latest || state.data);
  if ((d && d.generated) !== (state.digest && state.digest.generated)) {
    state.digest = d;
    if (state.loaded) renderCarousel();
  }
}

// Going offline is announced once (and again after a Retry that fails), not every 5 minutes.
function setOffline(manual) {
  const was = state.failed;
  state.failed = true;
  const at = state.data ? Date.parse(state.data.lastFetchedAt || state.data.generated) : NaN;
  el.errorText.textContent = "Couldn't refresh. Showing data from " + (isFinite(at) ? hhmm(at) : "--:--") + " UTC.";
  el.errorBar.hidden = false;
  renderStatus();
  if (!was || manual) announce(el.errorText.textContent);
}
function setOnline() {
  if (!state.failed) return;
  state.failed = false;
  // The bar's Retry button may have focus: keep it on the page, at the posts heading.
  if (el.errorBar.contains(document.activeElement)) el.feedTitle.focus({ preventScroll: true });
  el.errorBar.hidden = true;
  renderStatus();
  if (state.loaded) announce("Back online.");
}

function announce(msg) {
  el.announcer.textContent = "";
  setTimeout(() => { el.announcer.textContent = msg; }, 60);
}

/* ---------- Theme & motion ---------- */
const root = document.documentElement;
const mq = q => (window.matchMedia ? matchMedia(q) : { matches: false });
const mqDark = mq("(prefers-color-scheme: dark)"), mqReduce = mq("(prefers-reduced-motion: reduce)");
const onChange = (m, fn) => { if (m.addEventListener) m.addEventListener("change", fn); else if (m.addListener) m.addListener(fn); };
const THEME_BG = { light: "#f7f6f2", dark: "#111215" };

/* The reader's choices live in memory first and are written to storage as a bonus, so the
   buttons still work when localStorage is blocked (they then last until the page closes). */
const readTheme = () => { const v = store.get(KEY_THEME); return v === "light" || v === "dark" ? v : null; };
const readMotion = () => { const v = store.get(KEY_MOTION); return v === "on" || v === "off" ? v : null; };
let themeMem = readTheme(), motionMem = readMotion();
function themeChoice() { return themeMem; }
function applyTheme() {
  const choice = themeChoice(), theme = choice || (mqDark.matches ? "dark" : "light");
  root.setAttribute("data-theme", theme);
  el.themeBtn.innerHTML = (theme === "dark" ? "Light" : "Dark") + '<span class="narrow-hide"> mode</span>';
  // Browser UI colour: an explicit choice wins over the media-query defaults in <head>.
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.content = choice ? THEME_BG[choice] : m.media ? THEME_BG.dark : THEME_BG.light;
  });
}
function toggleTheme() {
  themeMem = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  store.set(KEY_THEME, themeMem);
  applyTheme();
}

function applyMotion() {
  const v = motionMem;
  state.motion = v === "on" ? true : v === "off" ? false : !mqReduce.matches;
  root.setAttribute("data-motion", state.motion ? "on" : "off");
  // Stable name "Motion"; aria-pressed carries the state the visible text shows.
  el.motionBtn.textContent = state.motion ? "Motion on" : "Motion off";
  el.motionBtn.setAttribute("aria-pressed", String(state.motion));
  el.motionBtn.title = state.motion ? "Turn animations off" : "Turn animations on";
  syncCarousel();
}
function toggleMotion() {
  motionMem = state.motion ? "off" : "on";
  store.set(KEY_MOTION, motionMem);
  applyMotion();
}

/* ---------- Events (delegated) ---------- */
function onClick(e) {
  const t = e.target.closest("button, a");
  if (!t) return;
  const ds = t.dataset;
  if (ds.save) toggleSave(t);
  else if (ds.view) setView(ds.view);
  else if (ds.cat) setCat(ds.cat);
  else if (ds.more) toggleCard(ds.more);
  else if (ds.tl) openInTimeline(ds.tl);
  else if ("clearco" in ds) clearCompany();
  else if ("loadmore" in ds) loadMore();
  else if (ds.seg) goSlide(+ds.seg, true);
  else if (ds.car) goSlide(car.index + (ds.car === "next" ? 1 : -1), true);
  else if ("retry" in ds) poll(true);
  else if (t === el.carToggle) toggleRotation();
  else if (t === el.savedBtn) toggleSavedOnly();
  else if (t === el.newPill) applyPending();
  else if (t === el.loadRetry) initialLoad(true);
  else if (t === el.themeBtn) toggleTheme();
  else if (t === el.motionBtn) toggleMotion();
}

function bindCarousel() {
  const c = el.carousel;
  c.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") { car.hover = true; syncCarousel(); } });
  c.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") { car.hover = false; syncCarousel(); } });
  // Keyboard focus pauses; focus from a tap or click does not. On touch screens the tapped
  // Pause/Play button keeps focus, so Play would otherwise seem to do nothing. Browsers
  // without :focus-visible pause on any focus, as before.
  const keyboardFocus = n => { try { return n.matches(":focus-visible"); } catch (e) { return true; } };
  c.addEventListener("focusin", e => { car.focus = keyboardFocus(e.target); syncCarousel(); });
  c.addEventListener("focusout", e => { if (!c.contains(e.relatedTarget)) { car.focus = false; syncCarousel(); } });
  c.addEventListener("keydown", e => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    goSlide(car.index + (e.key === "ArrowRight" ? 1 : -1), true);
  });
  el.progress.addEventListener("animationend", e => {
    if (e.target.classList.contains("seg-fill") && e.target.closest(".seg.is-active")) goSlide(car.index + 1, false);
  });
  // Touch swipe; touch-action: pan-y in CSS keeps vertical scrolling native.
  let start = null;
  el.slides.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") start = { x: e.clientX, y: e.clientY }; });
  el.slides.addEventListener("pointercancel", () => { start = null; });
  el.slides.addEventListener("pointerup", e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) goSlide(car.index + (dx < 0 ? 1 : -1), true);
  });
}

function bindEvents() {
  document.addEventListener("click", onClick);
  el.search.addEventListener("input", () => {
    state.query = el.search.value;
    state.shown = TIMELINE_PAGE;
    render(false);
  });
  // "/" jumps to the search field (as before the redesign).
  document.addEventListener("keydown", e => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) return;
    e.preventDefault();
    el.search.focus();
  });
  // Broken images fall back to the logo block (error events don't bubble: capture them).
  document.addEventListener("error", e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const box = img.closest(".media[data-fb]");
    if (!box) return;
    img.remove();
    box.insertAdjacentHTML("beforeend", fallbackHtml(box.dataset.fb));
  }, true);
  document.addEventListener("visibilitychange", () => {
    syncCarousel();
    if (!document.hidden && Date.now() - state.lastCheck > POLL_MS) poll();
  });
  onChange(mqDark, () => { if (!themeChoice()) applyTheme(); });
  onChange(mqReduce, () => { if (!motionMem) applyMotion(); });
  // Choices made in another tab (a content page or a second dashboard) apply here too.
  window.addEventListener("storage", e => {
    if (e.key === KEY_THEME || e.key === null) { themeMem = readTheme(); applyTheme(); }
    if (e.key === KEY_MOTION || e.key === null) { motionMem = readMotion(); applyMotion(); }
    if (e.key === KEY_SAVED || e.key === null) {
      const before = state.saved;
      state.saved = loadSaved();
      new Set([...before, ...state.saved]).forEach(id => { if (state.byId.has(id)) syncSaveButtons(id); });
      updateSavedBtn();
      if (state.savedOnly) render(false);
    }
  });
  // The pill floats just below the sticky filter bar, whatever height the bar wraps to.
  const syncBarHeight = () => root.style.setProperty("--filterbar-h", el.filterbar.offsetHeight + "px");
  syncBarHeight();
  if (window.ResizeObserver) new ResizeObserver(syncBarHeight).observe(el.filterbar);
  else window.addEventListener("resize", syncBarHeight);
  bindCarousel();
}

/* ---------- Init ---------- */
const el = {};
function collectElements() {
  ["hero", "carousel", "carouselTitle", "carouselDate", "carouselBadge", "carouselCtrl", "slideCount",
    "slides", "progress", "latestList", "feedWrap", "filterbar", "search", "savedBtn", "newPill", "newCount",
    "feed", "feedTitle", "viewCompany", "viewTimeline", "empty", "errorBar", "errorText", "loadError",
    "loadRetry", "themeBtn", "motionBtn", "announcer", "countdown", "sources", "carToggle", "coFilter"].forEach(id => { el[id] = $(id); });
  el.updated = $("updatedAt");
  el.live = $("liveState");
  el.liveLabel = $("liveLabel");
  el.segButtons = [...document.querySelectorAll("[data-view]")];
  el.chipButtons = [...document.querySelectorAll("[data-cat]")];
}

/* A link to /#subscribe (the content pages' Subscribe button) arrives while the page is
   still the short skeleton, so the browser's jump to the anchor ends up mid-feed once the
   posts render above it. The first render repeats the jump, unless the reader has
   already scrolled or pressed a key by then. */
let readerMoved = false;
function watchReader() {
  ["wheel", "touchmove", "keydown", "pointerdown"].forEach(type =>
    window.addEventListener(type, () => { readerMoved = true; }, { capture: true, passive: true, once: true }));
}
function scrollToHash() {
  if (readerMoved || location.hash.length < 2) return;
  let target = null;
  try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) { /* malformed hash */ }
  if (!target) return;
  // Instant, also with Motion on: this corrects a position, it is no navigation.
  try { target.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) { target.scrollIntoView(true); }
}

// One load at a time (Retry, the countdown and the 5-minute check can all start one). While
// a retry runs, the error message stays up so the Retry button keeps focus.
let loading = false;
// manual = the reader pressed Retry (a failure is then announced again).
async function initialLoad(manual) {
  if (loading) return;
  loading = true;
  const retrying = !el.loadError.hidden;
  if (retrying) el.loadRetry.textContent = "Retrying…";
  try {
    const data = await fetchData();
    const digestP = fetchDigest(data);
    // Wait briefly for the digest so the carousel renders once; a slow digest follows later.
    const late = {};
    const digest = await Promise.race([digestP, new Promise(r => setTimeout(() => r(late), 1500))]);
    state.lastCheck = Date.now();
    state.digest = digest === late ? null : digest;
    const hadFocus = el.loadError.contains(document.activeElement), first = !state.loaded;
    el.loadError.hidden = true;
    el.hero.hidden = el.feedWrap.hidden = false;
    applyData(data, normalize(data));
    state.loaded = true;
    setOnline();
    renderAll();
    if (hadFocus) el.feedTitle.focus({ preventScroll: true });
    if (first) scrollToHash();
    if (digest === late) digestP.then(d => { if (d) { state.digest = d; renderCarousel(); } });
  } catch (e) {
    // First load failed: a friendly message with Retry instead of empty skeletons.
    el.hero.hidden = el.feedWrap.hidden = true;
    el.loadError.hidden = false;
    state.failed = true;
    renderStatus();
    if (!retrying) announce("The latest posts couldn't be loaded.");
    else if (manual === true) announce("Still couldn't load the latest posts.");
  } finally {
    loading = false;
    el.loadRetry.textContent = "Retry";
  }
}

function init() {
  watchReader();
  collectElements();
  migrateStorage();
  state.saved = loadSaved();
  readUrl();
  applyTheme();
  applyMotion();
  el.carousel.style.setProperty("--slide-duration", SLIDE_SECONDS + "s");
  syncControls();
  if (state.view === "timeline") {
    el.viewCompany.hidden = true;
    el.viewTimeline.hidden = false;
    el.viewTimeline.innerHTML = timelineSkeleton();
  }
  bindEvents();
  tick();
  setInterval(tick, 1000);
  setInterval(refreshRelTimes, 60000);
  setInterval(poll, POLL_MS);
  initialLoad();
}

// Debug hook (harmless in production): lets a console session trigger a refresh.
window.__airadar = { poll, load: initialLoad, applyPending, goSlide, state };

init();
})();
