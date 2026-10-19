// Used only by tests/smoke: a stand-in for the parts of Obsidian's API the view
// touches, so the view can run in a plain browser page.
const P = HTMLElement.prototype, N = Node.prototype, E = Element.prototype;
// Class handling copies Obsidian's enhance.js (1.14): createEl sets className
// (spaces fine), createSvg uses classList.add, which throws on a space.
function make(tag, o = {}, ns) {
  if (typeof o === "string") o = { cls: o };
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  if (o.cls && ns) Array.isArray(o.cls) ? el.classList.add(...o.cls) : el.classList.add(o.cls);
  else if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text) el.textContent = o.text;
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  return el;
}
N.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
E.createDiv = function (o) { return this.appendChild(make("div", o)); };
E.createSpan = function (o) { return this.appendChild(make("span", o)); };
E.createEl = function (t, o) { return this.appendChild(make(t, o)); };
E.createSvg = function (t, o) { return this.appendChild(make(t, o, "http://www.w3.org/2000/svg")); };
E.addClass = function (c) { this.classList.add(c); };
E.removeClass = function (c) { this.classList.remove(c); };
E.toggleClass = function (c, v) { this.classList.toggle(c, v); };
E.getAttr = function (a) { return this.getAttribute(a); };
P.setText = function (t) { this.textContent = t; };
P.hide = function () { this.style.display = "none"; };
P.show = function () { this.style.display = ""; };
P.toggle = function (v) { v ? this.show() : this.hide(); };
class Component {
  constructor() { this._c = []; this._cleanup = []; }
  addChild(c) { this._c.push(c); return c; }
  removeChild(c) { this._c = this._c.filter((x) => x !== c); return c; }
  register(f) { this._cleanup.push(f); }
  registerEvent() {}
  registerDomEvent(el, ev, fn, o) { el.addEventListener(ev, fn, o); }
}
// Mirrors Obsidian's own TextFileView (read from app.js, 1.14): the same
// fields (data, dirty, lastSavedData, saving) and the same save() order, so a
// view that shadows one of them or depends on the wrong order fails here too.
// The one difference: saves run at once instead of after a 2 s debounce.
class TextFileView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf; this.app = window.app; this.contentEl = document.getElementById("content");
    this.lastSavedData = null; this.saving = false; this.saveAgain = false; this.isPlaintext = true;
    this.data = null; this.dirty = false;
    this.requestSave = () => { this.dirty = true; this.save(); };
  }
  addAction() {}
  save() {
    this.dirty = false;
    const o = this.getViewData();
    if (this.lastSavedData === o || this.lastSavedData === null) return;
    this.data = o; this.lastSavedData = o;
    window.saved = o;
  }
  // What Obsidian does when it loads the file or sees it change on disk.
  setData(e, t) {
    this.lastSavedData = e;
    if (this.data !== e || t) { this.data = e; this.setViewData(e, t); }
  }
}
// Mirrors Obsidian's View/ItemView constructors (app.js 1.14): the view's
// own div inside the leaf, then a header and the scrolling .view-content.
class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf; this.app = window.app; this.icon = "lucide-file"; this.navigation = false;
    this.containerEl = (leaf?.containerEl ?? document.body).createDiv({ cls: "workspace-leaf-content" });
    this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
  addAction() {}
}
class Menu {
  constructor() { this.items = []; window.lastMenu = this; }
  addItem(fn) {
    const item = { title: "", setTitle(t) { this.title = t; return this; }, setIcon() { return this; },
      setChecked(v) { this.checked = v; return this; }, onClick(f) { this.click = f; return this; } };
    fn(item); this.items.push(item); return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent() {}
  showAtPosition() {}
}
// Like Obsidian's: a .modal-container holding .modal, whose scope closes it
// on Escape while it's open.
class Modal {
  constructor(app) {
    this.app = app; this.containerEl = make("div", { cls: "modal-container" });
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" }); this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    this._esc = (e) => { if (e.key === "Escape") { e.preventDefault(); this.close(); } };
  }
  open() { document.body.appendChild(this.containerEl); window.lastModal = this; window.addEventListener("keydown", this._esc); this.onOpen?.(); }
  onOpen() {}
  onClose() {}
  close() { window.removeEventListener("keydown", this._esc); this.onClose?.(); this.containerEl.remove(); }
}
// Mirrors Obsidian's SuggestModal/FuzzySuggestModal (app.js 1.14): an input
// (.prompt-input) and results (.suggestion-item) filtered as you type; a
// click or Enter chooses, closing the modal first as Obsidian does.
class FuzzySuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.limit = 50; this.emptyStateText = "No results found.";
    this.modalEl.addClass("prompt");
    this.inputEl = this.modalEl.createEl("input", { cls: "prompt-input", attr: { type: "text" } });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    this.inputEl.addEventListener("input", () => this._draw());
    this.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && this._shown[0]) { e.preventDefault(); this._choose(this._shown[0], e); } });
  }
  setPlaceholder(p) { this.inputEl.placeholder = p; }
  setInstructions() {}
  open() { super.open(); this._draw(); this.inputEl.focus(); }
  _draw() {
    const q = this.inputEl.value.trim().toLowerCase();
    this._shown = this.getItems().filter((i) => this.getItemText(i).toLowerCase().includes(q)).slice(0, this.limit);
    this.resultContainerEl.empty();
    if (this._shown.length === 0) this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
    for (const item of this._shown) {
      const el = this.resultContainerEl.createDiv({ cls: "suggestion-item", text: this.getItemText(item) });
      el.addEventListener("click", (e) => this._choose(item, e));
    }
  }
  _choose(item, e) { this.close(); this.onChooseItem(item, e); }
}
class TFile {
  constructor(path) {
    this.path = path; this.name = path.split("/").pop();
    const dot = this.name.lastIndexOf(".");
    this.extension = dot > 0 ? this.name.slice(dot + 1) : ""; this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" };
    this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  }
}
// Markdown for the stand-in: paragraphs, [[links]], **bold**, and ![[image]]
// embeds that, like Obsidian's, are filled in after render() has resolved;
// the image comes from window.imageUrls (a data URL per vault path).
function renderInline(text) {
  return text
    .replace(/!\[\[([^\]]+)\]\]/g, '<span class="internal-embed image-embed" src="$1"></span>')
    .replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
async function renderMarkdown(app, text, el) {
  for (const para of text.split(/\n\s*\n/)) {
    const p = el.createEl("p");
    p.innerHTML = renderInline(para).replace(/\n/g, "<br>");
  }
  setTimeout(() => {
    for (const span of el.querySelectorAll(".internal-embed.image-embed:not(.is-loaded)")) {
      // Resolve the link text like Obsidian: a full path, else a file by name.
      const src = span.getAttribute("src");
      const urls = window.imageUrls ?? {};
      const path = src in urls ? src : Object.keys(urls).find((p) => p.split("/").pop() === src);
      const url = path && urls[path];
      span.classList.add("is-loaded");
      if (url) span.createEl("img", { attr: { src: url } });
    }
  }, 30);
}
const normalizePath = (p) => p.replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, "");
module.exports = {
  TFile,
  normalizePath,
  Modal,
  FuzzySuggestModal,
  Menu,
  Component, ItemView, TextFileView, WorkspaceLeaf: class {}, Notice: class { constructor(m) { console.log("NOTICE", m); } },
  HoverPopover: class {}, Keymap: { isModEvent: (e) => e.ctrlKey || e.metaKey },
  MarkdownRenderer: { render: renderMarkdown },
  setIcon: (el, name) => {
    if (name === "right-triangle") {
      el.innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8L12 17L21 8"/></svg>';
      return;
    }
    if (name === "sticky-note") {
      el.innerHTML = '<svg class="svg-icon lucide-sticky-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/></svg>';
      return;
    }
    el.textContent = { "zoom-in": "+", "zoom-out": "−", maximize: "⤢", "columns-2": "⇆", crosshair: "⌖" }[name] ?? "?"; },
};
