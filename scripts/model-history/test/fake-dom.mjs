/* A small fake DOM for the browser scripts' tests (assets/models.js, assets/model-pages.js):
   elements, attributes, text, events that bubble, focus, inline style properties, and a
   minimal parser for the generator's own well-formed HTML. Not a browser: layout values
   (offsetLeft, scrollWidth) are whatever a test sets. */
export function fakeDom() {
  let active = null;
  const touched = [];
  class N {
    constructor(tag, nodeType = 1) {
      this.nodeType = nodeType; this.tagName = tag ? tag.toUpperCase() : null; this.attrs = new Map();
      this.childNodes = []; this.parentNode = null; this.listeners = {}; this._text = ""; this.value = ""; this.checked = false;
      const props = new Map();
      this.style = { setProperty: (k, v) => props.set(k, String(v)), getPropertyValue: k => props.get(k) || "" };
    }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    get hidden() { return this.attrs.has("hidden"); }
    set hidden(v) { if (v) this.attrs.set("hidden", ""); else this.attrs.delete("hidden"); }
    get className() { return this.getAttribute("class") || ""; }
    set className(v) { this.setAttribute("class", v); }
    get type() { return this.getAttribute("type") || ""; }
    set type(v) { this.setAttribute("type", v); }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    insertBefore(n, ref) {
      if (!ref) return this.appendChild(n);
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
      return n;
    }
    appendChild(n) {
      if (n.nodeType === 11) { n.childNodes.slice().forEach(c => this.appendChild(c)); return n; }
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
      return n;
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) this.childNodes.splice(i, 1);
      if (active && n.contains(active)) active = null;   // like a browser: removing the focused node blurs it
      n.parentNode = null;
      return n;
    }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map(c => c.textContent).join(""); }
    set textContent(v) {
      if (this.nodeType === 3) { this._text = String(v); return; }
      this.childNodes.forEach(c => { c.parentNode = null; });
      this.childNodes = [];
      if (String(v) !== "") this.appendChild(text(v));
    }
    getElementsByTagName(t) {
      const out = [], T = t.toUpperCase();
      const walk = n => n.children.forEach(c => { if (c.tagName === T) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    dispatch(type) { const ev = { type, target: this }; for (let n = this; n; n = n.parentNode) (n.listeners[type] || []).forEach(fn => fn(ev)); }
    focus() { active = this; }
  }
  const text = v => { const t = new N(null, 3); t._text = String(v); return t; };
  const h = (tag, attrs = {}, ...kids) => {
    const n = new N(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "value") n.value = v; else n.setAttribute(k, v);
    kids.forEach(k => n.appendChild(typeof k === "string" ? text(k) : k));
    return n;
  };
  /* Minimal HTML parser for the generator's own, well-formed markup: elements, attributes,
     text and comments. Enough to rebuild the /models/ <main> as fake DOM nodes. */
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\xa0", middot: "\xb7" };
  const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#"
    ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));
  const parse = html => {
    const top = new N("template");
    let cur = top;
    for (const m of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
      if (m[4] !== undefined) { cur.appendChild(text(decode(m[4]))); continue; }
      if (!m[2]) continue;
      const tag = m[2].toUpperCase();
      if (m[1]) { for (let x = cur; x && x !== top; x = x.parentNode) if (x.tagName === tag) { cur = x.parentNode; break; } continue; }
      const n = new N(tag);
      for (const a of m[3].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const v = decode(a[2] ?? a[3] ?? a[4] ?? "");
        n.setAttribute(a[1].toLowerCase(), v);
        if (a[1].toLowerCase() === "value") n.value = v;
      }
      cur.appendChild(n);
      if (!VOID.has(tag.toLowerCase()) && !/\/\s*$/.test(m[3])) cur = n;
    }
    return top.children[0];
  };
  const root = h("html");
  const document = {
    readyState: "complete",
    createElement: t => new N(t), createTextNode: text, createDocumentFragment: () => new N(null, 11),
    getElementById: id => { let hit = null; const walk = n => n.children.forEach(c => { if (!hit && c.getAttribute("id") === id) hit = c; if (!hit) walk(c); }); walk(root); return hit; },
    getElementsByTagName: t => root.getElementsByTagName(t),
    get activeElement() { return active; },
    get cookie() { touched.push("cookie"); return ""; }, set cookie(v) { touched.push("cookie"); }
  };
  return { h, root, document, touched, parse };
}
