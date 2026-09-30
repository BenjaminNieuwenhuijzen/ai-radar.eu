/* Writes the FICTIONAL test dataset used by the Model History tests and by the design
   previews. "Example Lab", "Other Lab", "Orbit" and "Nova" do not exist; every URL points
   to reserved example domains. Run: node scripts/model-history/test/make-fixtures.mjs
   The output (test/fixtures/basic/) is committed so tests do not depend on this script. */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "basic");
rmSync(root, { recursive: true, force: true });
const put = (p, j) => { const f = join(root, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); };
const S = (...ids) => ids.map(id => (typeof id === "string" ? { id } : id));
const CHECK = "2026-10-01";

put("organizations.json", { schemaVersion: 1, organizations: [
  { id: "example-lab", name: "Example Lab", type: "company", parentId: null, radarCompanyId: null, coverage: "external",
    aliases: ["ExampleLab"], website: "https://example.org/", hue: 40,
    formerNames: [ { name: "Example Research", until: { value: "2021-09", sources: S("src.example-lab.rename") }, sources: S("src.example-lab.rename") } ],
    description: { text: "Fictional AI lab used as test data for AI Radar Model History.", sources: S("src.example-lab.history") },
    narrative: { chapters: [
      { id: "research-era", title: "Research models", period: { from: "2019", to: "2021" }, text: "Early research models that were never offered as a product.", modelIds: ["example-lab-research.orbit-0", "example-lab.orbit-1"], sources: S("src.example-lab.history") },
      { id: "orbit-2-generation", title: "The Orbit 2 generation", period: { from: "2024", to: "2025" }, text: "Orbit 2 added image input and was followed by several branches.", modelIds: ["example-lab.orbit-2", "example-lab.orbit-2-5", "example-lab.orbit-lite-1", "example-lab.orbit-3"], sources: S("src.example-lab.history") }
    ] } },
  { id: "example-lab-research", name: "Example Lab Research", type: "unit", parentId: "example-lab", radarCompanyId: null, coverage: "external", hue: 40 },
  { id: "other-lab", name: "Other Lab", type: "research-lab", parentId: null, radarCompanyId: null, coverage: "external", website: "https://other.example/", hue: 200,
    description: { text: "Second fictional lab, used for relations across organisations.", sources: S("src.other-lab.site") } }
] });

put("families.json", { schemaVersion: 1, families: [
  { id: "example-lab.orbit", organizationId: "example-lab", name: "Orbit", parentId: null },
  { id: "example-lab.orbit-lite", organizationId: "example-lab", name: "Orbit Lite", parentId: "example-lab.orbit" },
  { id: "other-lab.nova", organizationId: "other-lab", name: "Nova", parentId: null }
] });

const base = (id, extra) => ({ schemaVersion: 1, id, coverage: "full", lastReviewedAt: CHECK, ...extra });
const dev = (id, extra = []) => [{ id, role: "developer", primary: true }, ...extra];

put("records/example-lab/orbit-0.json", base("example-lab-research.orbit-0", {
  slug: "orbit-0", name: "Orbit 0", aliases: [ { text: "Orbit 0", match: "auto" } ],
  organizations: dev("example-lab-research"), familyId: "example-lab.orbit", generation: "0",
  categories: ["language"], prominence: "minor",
  lifecycle: { value: "research-only", sources: S("src.example-lab.orbit-0-card") },
  dates: { announced: null, released: { value: "2019", sources: S("src.example-lab.orbit-0-card") }, deprecated: null, retired: null },
  summary: { text: "Research-only precursor of the Orbit family.", sources: S("src.example-lab.orbit-0-card") } }));

put("records/example-lab/orbit-1.json", base("example-lab.orbit-1", {
  slug: "orbit-1", name: "Orbit 1", aliases: [ { text: "Orbit 1", match: "auto" }, { text: "Orbit", match: "never" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "1",
  categories: ["language"], prominence: "milestone",
  lifecycle: { value: "retired", sources: S("src.example-lab.deprecations") },
  dates: { announced: null, released: { value: "2021-03", sources: S("src.example-lab.orbit-1-docs") }, deprecated: null, retired: { value: "2024", qualifier: "approximate", sources: S("src.example-lab.deprecations") } },
  relations: [ { type: "successor-of", target: "example-lab-research.orbit-0", basis: "editorial", note: "Presented as the first product after the research model.", sources: S("src.example-lab.history") } ],
  summary: { text: "First Orbit model offered through an API.", sources: S("src.example-lab.orbit-1-docs") } }));

put("records/example-lab/orbit-2.json", base("example-lab.orbit-2", {
  slug: "orbit-2", name: "Orbit 2",
  aliases: [ { text: "Orbit 2", match: "auto" }, { text: "Orbit-2", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "2",
  categories: ["language", "multimodal"], prominence: "milestone",
  lifecycle: { value: "retired", sources: S("src.example-lab.deprecations") },
  dates: {
    announced: { value: "2024-05", sources: S("src.example-lab.orbit-2-preview-post") },
    released: { value: "2024-06-11", sources: S("src.example-lab.orbit-2-launch", "src.shared.news-report-1") },
    deprecated: null,
    retired: { value: "2025", qualifier: "approximate", sources: S("src.example-lab.deprecations") } },
  milestones: [ { id: "open-weights", label: "Open weights published", date: { value: "2024-07", sources: S("src.example-lab.orbit-2-repo") } } ],
  replacedBy: { modelId: "example-lab.orbit-3", sources: S("src.example-lab.deprecations") },
  relations: [ { type: "successor-of", target: "example-lab.orbit-1", basis: "sourced", sources: S({ id: "src.example-lab.orbit-2-launch", locator: "first paragraph" }) } ],
  variants: [ { id: "mini", name: "Orbit 2 Mini", aliases: [ { text: "Orbit 2 Mini", match: "auto" } ],
    dates: { released: { value: "2024-06-11", sources: S("src.example-lab.orbit-2-launch") } }, sources: S("src.example-lab.orbit-2-launch"), note: "Smaller variant released on the same day." } ],
  summary: { text: "Second-generation Orbit model that added image input.", sources: S("src.example-lab.orbit-2-launch") },
  changes: [ { id: "image-input", aspect: "modality", direction: "added", text: "Accepts image input in addition to text.", sources: S({ id: "src.example-lab.orbit-2-model-card", locator: "section 2" }) },
             { id: "context", aspect: "context-length", direction: "increased", text: "Longer context window than Orbit 1.", sources: S("src.example-lab.orbit-2-docs") } ],
  capabilities: {
    inputModalities: { value: ["text", "image"], sources: S("src.example-lab.orbit-2-model-card") },
    outputModalities: { value: ["text"], sources: S("src.example-lab.orbit-2-model-card") },
    features: [ { key: "tool-use", sources: S("src.example-lab.orbit-2-docs") } ],
    openWeights: { value: true, sources: S("src.example-lab.orbit-2-repo") },
    contextWindowTokens: { value: 128000, asStated: "128K", qualifier: null, disclosure: "official", sources: S("src.example-lab.orbit-2-docs") },
    parameters: { value: null, disclosure: "not-disclosed", sources: [], note: "Not disclosed by Example Lab." },
    access: { value: ["api", "open-weights-download"], sources: S("src.example-lab.orbit-2-launch") } },
  news: { include: [], exclude: [] } }));

put("records/example-lab/orbit-2-vision.json", base("example-lab.orbit-2-vision", {
  slug: "orbit-2-vision", name: "Orbit 2 Vision", aliases: [ { text: "Orbit 2 Vision", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "2",
  categories: ["multimodal"], prominence: "standard",
  lifecycle: { value: "available", sources: S("src.shared.news-report-1", "src.shared.news-report-2") },
  dates: { announced: null, released: { value: "2024-08", sources: S("src.shared.news-report-1", "src.shared.news-report-2") }, deprecated: null, retired: null },
  relations: [ { type: "variant-of", target: "example-lab.orbit-2", basis: "sourced", sources: S("src.shared.news-report-1") } ],
  summary: { text: "Image-focused variant of Orbit 2, known from press coverage.", sources: S("src.shared.news-report-1", "src.shared.news-report-2") } }));

put("records/example-lab/orbit-2-2024-09.json", base("example-lab.orbit-2-2024-09", {
  slug: "orbit-2-2024-09", name: "Orbit 2 (September 2024 revision)", aliases: [ { text: "orbit-2-2024-09", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "2",
  categories: ["language", "multimodal"], prominence: "minor",
  lifecycle: { value: "retired", sources: S("src.example-lab.deprecations") },
  dates: { announced: null, released: { value: "2024-09-30", sources: S("src.example-lab.orbit-2-sept-notes") }, deprecated: null, retired: null },
  relations: [ { type: "revision-of", target: "example-lab.orbit-2", basis: "sourced", sources: S("src.example-lab.orbit-2-sept-notes") } ],
  summary: { text: "Dated revision of Orbit 2 listed in the release notes.", sources: S("src.example-lab.orbit-2-sept-notes") } }));

put("records/example-lab/orbit-2-5.json", base("example-lab.orbit-2-5", {
  slug: "orbit-2-5", name: "Orbit 2.5", aliases: [ { text: "Orbit 2.5", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "2.5",
  categories: ["language", "multimodal"], prominence: "standard",
  lifecycle: { value: "available", sources: S("src.example-lab.orbit-2-5-launch") },
  dates: { announced: null, released: { value: "2024-12-02", sources: S("src.example-lab.orbit-2-5-launch") }, deprecated: null, retired: null },
  relations: [ { type: "successor-of", target: "example-lab.orbit-2", basis: "sourced", sources: S("src.example-lab.orbit-2-5-launch") } ],
  summary: { text: "Intermediate release between Orbit 2 and Orbit 3.", sources: S("src.example-lab.orbit-2-5-launch") } }));

put("records/example-lab/orbit-lite-1.json", base("example-lab.orbit-lite-1", {
  slug: "orbit-lite-1", name: "Orbit Lite 1", aliases: [ { text: "Orbit Lite 1", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit-lite", generation: "1",
  categories: ["language"], prominence: "minor",
  lifecycle: { value: "unknown", sources: [], note: "No source states whether it is still offered." },
  dates: { announced: null, released: { value: "2025", qualifier: "uncertain", sources: S("src.shared.blog-mention") }, deprecated: null, retired: null },
  relations: [ { type: "successor-of", target: "example-lab.orbit-2", basis: "editorial", note: "Grouped here because it is based on the Orbit 2 line.", sources: S("src.shared.blog-mention") } ],
  summary: { text: "Lightweight model mentioned in a single independent post.", sources: S("src.shared.blog-mention") } }));

put("records/example-lab/orbit-3.json", base("example-lab.orbit-3", {
  slug: "orbit-3", name: "Orbit 3", aliases: [ { text: "Orbit 3", match: "auto" } ],
  organizations: dev("example-lab"), familyId: "example-lab.orbit", generation: "3",
  categories: ["language", "multimodal", "reasoning"], prominence: "milestone",
  lifecycle: { value: "available", sources: S("src.example-lab.orbit-3-launch") },
  dates: { announced: { value: "2025-05", sources: S("src.example-lab.orbit-3-launch") }, released: { value: "2025-06-10", sources: S("src.example-lab.orbit-3-launch") }, deprecated: null, retired: null },
  relations: [ { type: "successor-of", target: "example-lab.orbit-2", basis: "sourced", sources: S("src.example-lab.orbit-3-launch") } ],
  summary: { text: "Third-generation Orbit model with a reasoning mode.", sources: S("src.example-lab.orbit-3-launch") },
  changes: [ { id: "reasoning-mode", aspect: "reasoning", direction: "added", text: "Adds an optional reasoning mode.", sources: S("src.example-lab.orbit-3-launch") } ],
  capabilities: {
    features: [ { key: "reasoning-mode", sources: S("src.example-lab.orbit-3-launch") }, { key: "computer-use", sources: S("src.shared.blog-mention") } ],
    contextWindowTokens: { value: 1000000, asStated: "1M", qualifier: null, disclosure: "official", sources: S("src.example-lab.orbit-3-launch") } } }));

put("records/example-lab/orbit-3-merge.json", base("example-lab.orbit-3-merge", {
  slug: "orbit-3-merge", name: "Orbit 3 Merge", aliases: [ { text: "Orbit 3 Merge", match: "auto" } ],
  organizations: dev("example-lab", [ { id: "other-lab", role: "co-developer" } ]), familyId: "example-lab.orbit", generation: "3",
  categories: ["language"], prominence: "standard",
  lifecycle: { value: "preview", sources: S("src.example-lab.orbit-3-merge-report") },
  dates: { announced: null, released: { value: "2025-11", sources: S("src.example-lab.orbit-3-merge-report") }, deprecated: null, retired: null },
  relations: [ { type: "derived-from", method: "merge", target: "example-lab.orbit-3", basis: "sourced", sources: S({ id: "src.example-lab.orbit-3-merge-report", locator: "section 3" }) },
               { type: "derived-from", method: "merge", target: "other-lab.nova-7", basis: "sourced", sources: S({ id: "src.example-lab.orbit-3-merge-report", locator: "section 3" }) } ],
  summary: { text: "Joint model made by merging Orbit 3 with Nova 7.", sources: S("src.example-lab.orbit-3-merge-report") },
  changes: [ { id: "merge", aspect: "architecture", direction: "changed", relativeTo: "example-lab.orbit-3", text: "Combines weights of two parent models.", sources: S("src.example-lab.orbit-3-merge-report") } ] }));

put("records/other-lab/nova-6.json", { schemaVersion: 1, id: "other-lab.nova-6", coverage: "stub", lastReviewedAt: CHECK,
  slug: "nova-6", name: "Nova 6", aliases: [ { text: "Nova 6", match: "candidate" } ],
  organizations: dev("other-lab"), familyId: "other-lab.nova", generation: "6",
  categories: ["language"], prominence: "standard",
  lifecycle: { value: "unknown", sources: [], note: "Not yet researched." },
  dates: { announced: null, released: null, deprecated: null, retired: null, note: "Release date not yet sourced." } });

put("records/other-lab/nova-7.json", base("other-lab.nova-7", {
  slug: "nova-7", name: "Nova 7", aliases: [ { text: "Nova 7", match: "auto" } ],
  organizations: dev("other-lab"), familyId: "other-lab.nova", generation: "7",
  categories: ["language", "code"], prominence: "milestone",
  lifecycle: { value: "available", sources: S("src.other-lab.nova-7-launch") },
  dates: { announced: null, released: { value: "2025-02-14", sources: S("src.other-lab.nova-7-launch") }, deprecated: null, retired: null },
  relations: [ { type: "successor-of", target: "other-lab.nova-6", basis: "sourced", sources: S("src.other-lab.nova-7-launch") } ],
  summary: { text: "Code-capable language model from Other Lab.", sources: S("src.other-lab.nova-7-launch") } }));

const src = (id, type, title, url, publisher, extra = {}) => ({ id, type, title, url, publisher, provenance: "primary", availability: "active", lastCheckedAt: CHECK, ...extra });
put("sources/example-lab.json", { schemaVersion: 1, sources: [
  src("src.example-lab.rename", "press-release", "Example Research becomes Example Lab", "https://example.org/news/new-name", "Example Lab", { publisherOrgId: "example-lab", publishedAt: { value: "2021-09-01" } }),
  src("src.example-lab.history", "blog-post", "A short history of Orbit", "https://example.org/blog/history", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-0-card", "model-card", "Orbit 0 model card", "https://example.org/orbit-0/card", "Example Lab", { publisherOrgId: "example-lab", availability: "unavailable", notes: "Original removed; no legitimate archive capture found." }),
  src("src.example-lab.orbit-1-docs", "documentation", "Orbit 1 API reference", "https://docs.example.org/orbit-1", "Example Lab", { publisherOrgId: "example-lab", availability: "archived",
    archiveUrl: "https://web.archive.org/web/20210401000000/https://docs.example.org/orbit-1", archiveProvider: "internet-archive", archivedAt: "2021-04-01T00:00:00Z", notes: "Original page removed; archived capture checked against the original title." }),
  src("src.example-lab.orbit-2-preview-post", "blog-post", "A first look at Orbit 2", "https://example.org/blog/orbit-2-preview", "Example Lab", { publisherOrgId: "example-lab", publishedAt: { value: "2024-05-20" } }),
  src("src.example-lab.orbit-2-launch", "announcement", "Introducing Orbit 2", "https://example.org/blog/orbit-2", "Example Lab", { publisherOrgId: "example-lab", publishedAt: { value: "2024-06-11" } }),
  src("src.example-lab.orbit-2-model-card", "model-card", "Orbit 2 model card", "https://example.org/orbit-2/card", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-2-docs", "documentation", "Orbit 2 documentation", "https://docs.example.org/orbit-2", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-2-repo", "repository", "orbit-2 repository", "https://github.com/example-lab/orbit-2", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-2-sept-notes", "release-notes", "Release notes, September 2024", "https://docs.example.org/release-notes/2024-09", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-2-5-launch", "announcement", "Orbit 2.5", "https://example.org/blog/orbit-2-5", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-3-launch", "announcement", "Introducing Orbit 3", "https://example.org/blog/orbit-3", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.orbit-3-merge-report", "technical-report", "Orbit 3 Merge technical report", "https://example.org/research/orbit-3-merge", "Example Lab", { publisherOrgId: "example-lab" }),
  src("src.example-lab.deprecations", "deprecation-notice", "Model deprecations", "https://docs.example.org/deprecations", "Example Lab", { publisherOrgId: "example-lab" })
] });
put("sources/other-lab.json", { schemaVersion: 1, sources: [
  src("src.other-lab.site", "documentation", "About Other Lab", "https://other.example/about", "Other Lab", { publisherOrgId: "other-lab" }),
  src("src.other-lab.nova-7-launch", "announcement", "Nova 7", "https://other.example/blog/nova-7", "Other Lab", { publisherOrgId: "other-lab" })
] });
put("sources/shared.json", { schemaVersion: 1, sources: [
  src("src.shared.news-report-1", "news-article", "Example Lab ships Orbit 2", "https://news.example.com/orbit-2", "Example News", { provenance: "secondary" }),
  src("src.shared.news-report-2", "news-article", "Orbit 2 Vision spotted", "https://weekly.example.net/orbit-2-vision", "Sample Tech Weekly", { provenance: "secondary" }),
  src("src.shared.blog-mention", "blog-post", "Trying Orbit Lite", "https://blog.example.com/orbit-lite", "Independent Blog", { provenance: "secondary" })
] });

put("state/source-status.json", { schemaVersion: 1, generated: "2026-10-05T03:12:00Z", sources: {
  "src.example-lab.orbit-0-card": { state: "unavailable", stateSince: "2026-10-05T03:11:42Z", lastCheckedAt: "2026-10-05T03:11:42Z", lastResult: "gone", httpStatus: 404, finalUrl: null,
    lastDefinitiveAt: "2026-10-05T03:11:42Z", consecutiveFailures: 3, firstFailureAt: "2026-09-26T03:10:05Z", lastOkAt: null,
    firstFingerprint: null, lastFingerprint: { title: "Page not found", bytes: 3120, truncated: false }, archiveState: null, archiveSuggestion: null },
  "src.example-lab.orbit-2-docs": { state: "active", stateSince: "2026-07-01T03:09:00Z", lastCheckedAt: "2026-10-05T03:11:50Z", lastResult: "ok", httpStatus: 200, finalUrl: null,
    lastDefinitiveAt: "2026-10-05T03:11:50Z", consecutiveFailures: 0, firstFailureAt: null, lastOkAt: "2026-10-05T03:11:50Z",
    firstFingerprint: { title: "Orbit 2 documentation", bytes: 51234, truncated: false }, lastFingerprint: { title: "Orbit 2 documentation", bytes: 51190, truncated: false }, archiveState: null, archiveSuggestion: null }
} });
put("state/news-links.json", { schemaVersion: 1, links: [] });

// A small data.json lookalike for the news matcher: 6 meaningful items plus filler so the
// "fewer than 100 items" guard does not trigger. Ids follow the feed build (cyrb53 of the link),
// computed by the tests, so they are omitted here on purpose for half of the items.
const items = [
  { company: "Across AI", source: "Example News", title: "Introducing Orbit 2", link: "https://example.org/blog/orbit-2", date: "Tue, 11 Jun 2024 16:00:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "Orbit‑2 is now open weights", link: "https://news.example.com/orbit-2-open", date: "Mon, 15 Jul 2024 00:00:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "Hands-on with Orbit 2 Mini", link: "https://news.example.com/orbit-2-mini", date: "Wed, 12 Jun 2024 09:30:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "Orbit 2-Vision preview leaks", link: "https://news.example.com/orbit-2-vision-leak", date: "Thu, 01 Aug 2024 08:00:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "Orbit 3 and Nova 7 compared", link: "https://news.example.com/orbit-3-vs-nova-7", date: "Fri, 20 Jun 2025 10:00:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "The Orbit roadmap", link: "https://news.example.com/orbit-roadmap", date: "Sat, 01 Mar 2025 00:00:00 GMT", summary: "" },
  { company: "Across AI", source: "Example News", title: "Orbit 2.5 arrives", link: "https://example.org/blog/orbit-2-5", date: "Mon, 02 Dec 2024 12:00:00 GMT", summary: "" }
];
for (let i = 0; i < 110; i++) items.push({ company: "Across AI", source: "Filler", title: `Unrelated AI story ${i}`, link: `https://filler.example.com/story-${i}`, date: "Tue, 01 Sep 2026 00:00:00 GMT", summary: "" });
put("data.json", { generated: "2026-10-01T00:00:00Z", items });
console.log("fixtures written to", root);
