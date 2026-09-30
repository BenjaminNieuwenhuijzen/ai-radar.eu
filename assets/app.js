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

/* ------------------------------------------------------------------
   Company logos as inline SVG (no separate files needed).
   OpenAI: official vector path. Monochrome logos (OpenAI, xAI) follow
   the theme color via currentColor. The other brands are reconstructed in
   shape and color; at avatar size identical to the original.
------------------------------------------------------------------ */
const LOGOS = {
  openai: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg>`,
  anthropic: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" stroke="#d97757" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="12" x2="18.5" y2="15.75"/><line x1="12" y1="12" x2="16.5" y2="19.8"/><line x1="12" y1="12" x2="12" y2="19"/><line x1="12" y1="12" x2="8" y2="19.5"/><line x1="12" y1="12" x2="4.2" y2="16.5"/><line x1="12" y1="12" x2="5" y2="12"/><line x1="12" y1="12" x2="4.6" y2="7.75"/><line x1="12" y1="12" x2="8.5" y2="5.9"/><line x1="12" y1="12" x2="12" y2="3"/><line x1="12" y1="12" x2="15.75" y2="5.5"/><line x1="12" y1="12" x2="19.5" y2="8"/></svg>`,
  /* Google and Meta use internal SVG ids (gradients, clip-path). These must
     be unique per use (placeholder __U__), otherwise a logo in the timeline
     references definitions in the hidden grid view and doesn't render. */
  google: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="gemclip__U__"><path d="M12 0C12.96 6.5 17.5 11.04 24 12 17.5 12.96 12.96 17.5 12 24 11.04 17.5 6.5 12.96 0 12 6.5 11.04 11.04 6.5 12 0Z"/></clipPath><radialGradient id="gemred__U__" gradientUnits="userSpaceOnUse" cx="12" cy="2" r="11"><stop offset="0%" stop-color="#FF4641"/><stop offset="100%" stop-color="#FF4641" stop-opacity="0"/></radialGradient><radialGradient id="gemyellow__U__" gradientUnits="userSpaceOnUse" cx="2" cy="12" r="11"><stop offset="0%" stop-color="#FFC400"/><stop offset="100%" stop-color="#FFC400" stop-opacity="0"/></radialGradient><radialGradient id="gemgreen__U__" gradientUnits="userSpaceOnUse" cx="12" cy="22" r="11"><stop offset="0%" stop-color="#00A661"/><stop offset="100%" stop-color="#00A661" stop-opacity="0"/></radialGradient></defs><g clip-path="url(#gemclip__U__)"><rect width="24" height="24" fill="#4285F4"/><rect width="24" height="24" fill="url(#gemred__U__)"/><rect width="24" height="24" fill="url(#gemyellow__U__)"/><rect width="24" height="24" fill="url(#gemgreen__U__)"/></g></svg>`,
  meta: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="metag__U__" gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="12" y2="24"><stop offset="0%" stop-color="#E04AFD"/><stop offset="50%" stop-color="#8B5CF6"/><stop offset="100%" stop-color="#4845F5"/></linearGradient></defs><g fill="url(#metag__U__)"><ellipse cx="12" cy="5" rx="2.8" ry="4.6"/><ellipse cx="17.47" cy="7.63" rx="2.8" ry="4.6" transform="rotate(51.43 17.47 7.63)"/><ellipse cx="18.83" cy="13.56" rx="2.8" ry="4.6" transform="rotate(102.86 18.83 13.56)"/><ellipse cx="15.04" cy="18.31" rx="2.8" ry="4.6" transform="rotate(154.29 15.04 18.31)"/><ellipse cx="8.96" cy="18.31" rx="2.8" ry="4.6" transform="rotate(205.71 8.96 18.31)"/><ellipse cx="5.17" cy="13.56" rx="2.8" ry="4.6" transform="rotate(257.14 5.17 13.56)"/><ellipse cx="6.53" cy="7.63" rx="2.8" ry="4.6" transform="rotate(308.57 6.53 7.63)"/></g></svg>`,
  xai: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><polygon points="18.6,2.6 21.4,2.6 12.4,21.5 9.6,21.5"/><polygon points="18.8,10.2 21.4,6.6 21.4,21.5 18.8,21.5"/><polygon points="2.6,4.4 5.8,4.4 13.6,15.4 10.4,15.4"/><polygon points="2.6,21.5 5.6,21.5 9.4,16.2 6.4,16.2"/></svg>`,
  perplexity: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 1.5v21"/><path d="M4.5 3l15 18"/><path d="M19.5 3l-15 18"/><rect x="3" y="8" width="18" height="8"/></svg>`,
  /* Exact grid layout of the supplied Mistral logo (6 columns x 5 rows). */
  mistral: `<svg viewBox="0 0 24 20" xmlns="http://www.w3.org/2000/svg"><g fill="#FFD800"><rect x="4" y="0" width="4" height="4"/><rect x="16" y="0" width="4" height="4"/></g><g fill="#FFAF00"><rect x="4" y="4" width="8" height="4"/><rect x="14" y="4" width="6" height="4"/></g><g fill="#FF8205"><rect x="4" y="8" width="16" height="4"/></g><g fill="#FA500F"><rect x="4" y="12" width="4" height="4"/><rect x="10" y="12" width="4" height="4"/><rect x="16" y="12" width="4" height="4"/></g><g fill="#E10500"><rect x="0" y="16" width="8" height="4"/><rect x="12" y="16" width="12" height="4"/></g></svg>`,
  /* Microsoft: the official four-square logo. */
  microsoft: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="9.4" height="9.4" fill="#F25022"/><rect x="12.6" y="2" width="9.4" height="9.4" fill="#7FBA00"/><rect x="2" y="12.6" width="9.4" height="9.4" fill="#00A4EF"/><rect x="12.6" y="12.6" width="9.4" height="9.4" fill="#FFB900"/></svg>`,
  /* Hugging Face: official brand glyph (the 🤗), in HF yellow. */
  huggingface: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#FFB000"><path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624"/></svg>`,
  /* NVIDIA: official eye logo, in NVIDIA green. */
  nvidia: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#76b900"><path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"/></svg>`,
  /* Cohere: official brand icon, inlined as a data: URI so it loads first-party
     (no request to cohere.com on render). */
  cohere: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,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" width="24" height="24"/></svg>`,
  /* DeepSeek: official whale glyph (Simple Icons), in DeepSeek blue. */
  deepseek: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#4d6bfe"><path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/></svg>`,
  /* Across AI: a globe for cross-industry, policy and emerging-lab news.
     Monochrome, follows the card accent via currentColor. */
  acrossai: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/><path d="M4.6 7h14.8"/><path d="M4.6 17h14.8"/></svg>`
};

/* ---------- Companies: the single source of truth ----------
   name = the exact data.json "company" string, display = the label on the page,
   hue = the oklch hue from the design (null = neutral grey via the co-neutral class).
   Hues 110/158/352 (xAI, Perplexity, Cohere) sit in the widest gaps left by the design's
   nine hues; with twelve companies the ~30° rule cannot hold everywhere. */
const SRC_LABELS = {
  official: ["Official feed", "Read from the company's own feed(s)."],
  community: ["Community feed", "No official RSS feed; updates come from a community-maintained feed and may lag behind."],
  industry: ["Industry news", "Stories from across the AI world, aggregated from general AI news feeds: industry-wide, policy, society and emerging labs."]
};
const COMPANIES = [
  { id: "openai", name: "OpenAI", display: "OpenAI", hue: 20, official: true, logo: LOGOS.openai },
  { id: "anthropic", name: "Anthropic", display: "Anthropic", hue: 55, official: false, logo: LOGOS.anthropic },
  { id: "mistral", name: "Mistral AI", display: "Mistral AI", hue: 85, official: true, logo: LOGOS.mistral },
  { id: "xai", name: "xAI (Grok)", display: "xAI", hue: 110, official: false, logo: LOGOS.xai },
  { id: "nvidia", name: "NVIDIA", display: "NVIDIA", hue: 135, official: true, logo: LOGOS.nvidia },
  { id: "perplexity", name: "Perplexity", display: "Perplexity", hue: 158, official: false, logo: LOGOS.perplexity },
  { id: "deepseek", name: "DeepSeek", display: "DeepSeek", hue: 180, official: false, logo: LOGOS.deepseek },
  { id: "microsoft", name: "Microsoft AI", display: "Microsoft", hue: 215, official: true, logo: LOGOS.microsoft },
  { id: "google", name: "Google (AI & DeepMind)", display: "Google", hue: 255, official: true, logo: LOGOS.google },
  { id: "meta", name: "Meta AI", display: "Meta", hue: 285, official: true, logo: LOGOS.meta },
  { id: "huggingface", name: "Hugging Face", display: "Hugging Face", hue: 325, official: true, logo: LOGOS.huggingface },
  { id: "cohere", name: "Cohere", display: "Cohere", hue: 352, official: false, logo: LOGOS.cohere },
  { id: "across", name: "Across AI", display: "Across AI", hue: null, official: false, aggregate: true, logo: LOGOS.acrossai }
].map((c, order) => {
  const [srcLabel, srcTitle] = SRC_LABELS[c.aggregate ? "industry" : c.official ? "official" : "community"];
  return Object.assign(c, { order, srcLabel, srcTitle, aggregate: !!c.aggregate });
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

/* Logos with internal ids (gradients, clip-paths) get unique ids per use;
   otherwise a logo references definitions in a hidden view and doesn't
   render (like Google and Meta in the timeline). */
let logoUid = 0;
function logoFor(logo) {
  if (!logo) return "";
  return logo.includes("__U__") ? logo.replaceAll("__U__", "u" + (logoUid++)) : logo;
}

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
