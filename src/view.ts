import {
	Component,
	HoverPopover,
	Keymap,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	TFile,
	TextFileView,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import { Box, Direction, Size, bounds, decorationExtents, decorations, edgePath, layoutTree, linkPath, nearestInDirection } from "./layout";
import { THEMES, settingsOf, spacingValue, themeClass, topicWidthPx } from "./settings";
import {
	BranchColor,
	COLORS,
	LAYOUTS,
	Link,
	LinkRecord,
	MapDoc,
	Summary,
	SummaryRecord,
	isCentral,
	MindNode,
	TreeSnapshot,
	countDescendants,
	linksToRecords,
	newNode,
	recordsToSummaries,
	summariesToRecords,
	nodeAtPath,
	parentOf,
	parse,
	pathOf,
	recordsToLinks,
	restore,
	serialize,
	snapshot,
} from "./model";
import {
	Drop,
	Frame,
	Rect,
	Selection,
	collapseSelection,
	easeOut,
	edgePan,
	extendSelection,
	interpolateLayout,
	meetsRect,
	onScreenTopics,
	pruneSelection,
	resolveDrop,
	singleSelection,
	toggleSelection,
	visibleMapRect,
} from "./interaction";
import {
	addLink,
	addSummary,
	detachAsCentral,
	inDocumentOrder,
	insertChild,
	insertSibling,
	isAncestor,
	moveAll,
	removeAll,
	removeLink,
	removeSummary,
	reorder,
	topmost,
} from "./ops";
import { linkedNote, noteNameFor } from "./notes";
import { ImageSuggestModal, NoteModal } from "./note-ui";
import { appendToTopic, imageEmbed, isImageFile, normaliseNote, placePopover } from "./note-helpers";
import type { ExportImage } from "./export";
import type MindMapPlugin from "./main";

export const VIEW_TYPE_MINDMAP = "mindmap-markdown";

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
const BRANCH_COLORS = 8;
const UNDO_LIMIT = 200;
// Text with any of these needs the Markdown renderer; plain text skips it.
const MARKDOWN_HINT = /[[\]*_`=~$<]|https?:/;
const ANIM_MS = 180;
// Topics within this many screen pixels of the viewport still glide.
const ANIM_MARGIN = 100;
// More topics than this on screen and a relayout jumps instead of gliding.
const ANIM_MAX_TOPICS = 250;
// Screen pixels round the view where topics and lines are kept up to date;
// beyond it they're moved later (see flushOffscreen).
const PAINT_MARGIN = 300;
// How many put-off topics or lines to move per idle slice.
const OFFSCREEN_CHUNK = 40;
// A mouse press becomes a drag only after this much travel, so clicks select.
const DRAG_THRESHOLD = 4;
// On touch a drag needs a long press, so a one-finger swipe still pans.
const LONG_PRESS_MS = 350;
const TOUCH_SLOP = 8;
// The drag ghost trails the pointer by this many screen pixels so it never
// covers the drop target or insertion line under the pointer.
const GHOST_OFFSET = 14;

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

interface NodeEl {
	el: HTMLElement;
	label: HTMLElement;
	badge: HTMLElement;
	renderedText: string | null;
	component: Component | null;
	colourClass: string;
	// What paint() last wrote, so an unmoved topic costs no style write.
	transform: string;
	opacity: string;
	// The box it was last put at; null until first placed (hidden till then).
	at: Rect | null;
	// Its measured size, kept until something that can change it does (its
	// text, depth, note marker, editing, an image or the theme); null to
	// measure again. Reading every topic's size each relayout was the largest
	// single cost of an edit on a big map.
	size: Size | null;
	side: string; // data-side as last written
	state: string; // what syncNode last drew besides the label (see there)
}

interface EdgeDrawn {
	cls: string;
	d: string;
	depth: string;
	// The boxes and depth d was worked out from, to skip unchanged lines.
	from: Box | null;
	to: Box | null;
	at: Rect | null; // the area the line was drawn over; null until drawn
}

// meetsRect(edgeRect(p, b), r) without making the rect.
const edgeMeets = (p: Box, b: Box, r: Rect) =>
	Math.min(p.x, b.x) < r.x + r.w &&
	Math.max(p.x + p.w, b.x + b.w) > r.x &&
	Math.min(p.y, b.y) < r.y + r.h &&
	Math.max(p.y + p.h, b.y + b.h) > r.y;

// Same place, size and side: a line between such boxes needs no new path.
const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.side === b.side;

// The area a parent-to-child line can cover: both boxes and what's between.
function edgeRect(p: Box, b: Box): Rect {
	const x = Math.min(p.x, b.x);
	const y = Math.min(p.y, b.y);
	return { x, y, w: Math.max(p.x + p.w, b.x + b.w) - x, h: Math.max(p.y + p.h, b.y + b.h) - y };
}

interface Snapshot {
	tree: TreeSnapshot;
	links: LinkRecord[];
	summaries: SummaryRecord[];
	layout: MapDoc["settings"]["layout"];
	selected: number[] | null;
}

interface DragState {
	pointerId: number;
	nodes: MindNode[]; // the topmost dragged topics, in outline order
	client: { x: number; y: number };
	ghost: HTMLElement;
	line: HTMLElement;
	drop: Drop | null;
	raf: number;
	cleanup: () => void;
}

// Obsidian's toggleClass and removeClass go through classList.remove, which
// re-sets the class attribute even when the class isn't there, and that makes
// the browser restyle the element. Done for every topic on every refresh or
// selection change, it restyled the whole map, so classes change only here.
// Returns whether it changed anything.
function setClass(el: Element, cls: string, on: boolean): boolean {
	if (el.classList.contains(cls) === on) return false;
	el.classList.toggle(cls, on);
	return true;
}

// Attribute and text writes that skip unchanged values: links, boundaries and
// summaries are redrawn every animation frame, and each write restyles.
function setAttr(el: Element, name: string, value: string) {
	if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setTextIfChanged(el: Element, text: string) {
	if (el.textContent !== text) el.textContent = text;
}

// isAncestor(top, n) by climbing a parent index rather than searching top's
// whole branch: drawLinks asks it for every link end on every frame.
function within(top: MindNode, n: MindNode, parents: Map<MindNode, MindNode>): boolean {
	for (let c: MindNode | undefined = n; c; c = parents.get(c)) if (c === top) return true;
	return false;
}

// True when any topic would be drawn somewhere else, so an unchanged relayout
// (a keystroke that doesn't wrap, a re-render) costs no animation.
function moved(from: Map<MindNode, Box>, to: Map<MindNode, Box>): boolean {
	for (const [n, b] of to) {
		const a = from.get(n);
		if (!a) return true;
		if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h) > 0.5) return true;
	}
	return false;
}

export class MindMapView extends TextFileView {
	plugin: MindMapPlugin;
	hoverPopover: HoverPopover | null = null;
	doc: MapDoc | null = null;
	readOnly = false;

	private viewport!: HTMLElement;
	private canvas!: HTMLElement;
	private edges!: SVGSVGElement;
	private banner!: HTMLElement;
	private focusBar!: HTMLElement;
	private hint!: HTMLElement;
	private linksSvg!: SVGSVGElement;
	private linkEls = new Map<Link, { hit: SVGPathElement; path: SVGPathElement; text: SVGTextElement }>();
	// The relationship line that's selected, if any; Delete removes it.
	private selectedLink: Link | null = null;
	// Set while choosing the other end of a new relationship line.
	private linking: { from: MindNode } | null = null;
	private markerId = `mm-arrow-${Math.random().toString(36).slice(2, 8)}`;
	private nodeEls = new Map<MindNode, NodeEl>();
	private edgeEls = new Map<MindNode, SVGPathElement>();
	// What drawEdges last wrote to each line.
	private edgeDrawn = new Map<MindNode, EdgeDrawn>();
	// Final layout positions. What's on screen mid-animation is in shown.
	private boxes = new Map<MindNode, Box>();
	private shown = new Map<MindNode, Box>();
	private anim: number | null = null;
	// On-screen boxes by outline path, for when undo or a reload rebuilds the
	// tree with new node objects but the topics should still glide.
	private pendingFrom: Map<string, Box> | null = null;

	// selected is the primary (focused) topic; selection holds every selected
	// topic and always includes it.
	private selected: MindNode | null = null;
	private selection = new Set<MindNode>();
	// View state only: the topic shown as the temporary centre. Never saved.
	private focusRoot: MindNode | null = null;
	private editing: { node: MindNode; isNew: boolean; original: string } | null = null;
	private drag: DragState | null = null;
	private suppressClick = false;

	private tx = 0;
	private ty = 0;
	private scale = 1;
	private needsFit = true;

	private undoStack: Snapshot[] = [];
	private redoStack: Snapshot[] = [];
	private renderSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MindMapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_MINDMAP;
	}

	getDisplayText() {
		return this.file?.basename ?? "Mind map";
	}

	getIcon() {
		return "git-fork";
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("mm-view");
		this.applyMapSettings(); // Settings hook: theme and topic width

		this.banner = this.contentEl.createDiv({ cls: "mm-banner" });
		this.banner.hide();
		this.focusBar = this.contentEl.createDiv({ cls: "mm-focusbar" });
		this.focusBar.hide();
		this.hint = this.contentEl.createDiv({ cls: "mm-hint" });
		this.hint.hide();

		this.viewport = this.contentEl.createDiv({ cls: "mm-viewport", attr: { tabindex: "0" } });
		this.canvas = this.viewport.createDiv({ cls: "mm-canvas" });
		this.edges = this.canvas.createSvg("svg", { cls: "mm-edges" });
		// Relationship lines sit above topics so they stay visible and clickable.
		this.linksSvg = this.canvas.createSvg("svg", { cls: "mm-links" });
		const defs = this.linksSvg.createSvg("defs");
		// Classes as arrays: Obsidian's createSvg adds them with classList.add,
		// which throws on a string containing a space and would abort onOpen.
		const arrows: [string, string[]][] = [
			["", ["mm-arrow"]],
			["-sel", ["mm-arrow", "is-selected"]],
		];
		for (const [suffix, cls] of arrows) {
			const marker = defs.createSvg("marker", {
				attr: {
					id: this.markerId + suffix,
					viewBox: "0 0 10 10",
					refX: "9",
					refY: "5",
					markerWidth: "7",
					markerHeight: "7",
					orient: "auto-start-reverse",
				},
			});
			marker.createSvg("path", { cls, attr: { d: "M 0 0 L 10 5 L 0 10 z" } });
		}

		this.buildToolbar();
		this.addAction("file-text", "Open as Markdown", () => this.plugin.openAsMarkdown(this.leaf));

		this.registerDomEvent(this.viewport, "keydown", (e) => this.onKeyDown(e));
		this.registerDomEvent(this.viewport, "wheel", (e) => this.onWheel(e), { passive: false });
		this.registerDomEvent(this.viewport, "pointerdown", (e) => this.onPointerDown(e));
		this.registerDomEvent(this.canvas, "click", (e) => this.onCanvasClick(e));
		this.registerDomEvent(this.canvas, "dblclick", (e) => this.onCanvasDblClick(e));
		this.registerDomEvent(this.canvas, "mouseover", (e) => this.onHover(e));
		// On the viewport, not the canvas: the canvas is only as big as its
		// topics, so a right-click on empty background never reaches it.
		this.registerDomEvent(this.viewport, "contextmenu", (e) => this.onContextMenu(e));
		this.setupNotesAndImages();

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf && !this.editing) this.viewport.focus();
			}),
		);

		// Relayout when the pane is resized so "fit" stays honest on first load.
		// It also keeps the viewport's size, read here where layout is already
		// done: reading clientWidth after the map changed forced the browser to
		// restyle and lay out the whole map there and then.
		this.mmViewSize = null;
		const ro = new ResizeObserver(() => {
			this.mmViewSize = { w: this.viewport.clientWidth, h: this.viewport.clientHeight };
			if (this.needsFit && this.boxes.size > 0) this.fit();
			if (this.offscreenNodes.size + this.offscreenEdges.size > 0) this.scheduleOffscreen();
		});
		ro.observe(this.viewport);
		this.register(() => ro.disconnect());
		this.register(() => this.cancelOffscreen());
		// A theme or font change resizes topics; measure them all again and lay
		// the map out to match (a font size change fires no resize).
		this.registerEvent(this.app.workspace.on("css-change", () => this.scheduleImageRelayout()));
	}

	// ---- Settings hook (src/settings.ts) ----
	// Puts the colour theme class and the topic width on the view, then lays
	// the map out again, since spacing or width may have changed. The plugin
	// calls it on every open map when a setting changes. Name checked against
	// Obsidian's View/TextFileView.
	applyMapSettings() {
		const s = settingsOf(this.plugin);
		for (const t of THEMES) {
			const cls = themeClass(t.id);
			if (cls) this.contentEl.toggleClass(cls, t.id === s.theme);
		}
		this.contentEl.style.setProperty("--mm-topic-width", `${topicWidthPx(s.topicWidth)}px`);
		// Width and theme change topic sizes, so measured sizes can't be reused.
		if (this.nodeEls) this.invalidateTopicSizes();
		if (this.doc) this.relayout();
	}

	async onClose() {
		this.endDrag(false);
		this.commitEdit();
		this.clearNodes();
	}

	// ---- TextFileView contract -------------------------------------------

	// Until the map is actually changed, saves hand back the note exactly as
	// read, so opening a map never rewrites it into the canonical layout.
	// Not called `dirty`: TextFileView already has a field by that name, and
	// its save() clears it before calling getViewData(), so sharing it meant
	// no edit was ever written.
	private mapEdited = false;

	private markDirty() {
		this.mapEdited = true;
		this.requestSave();
	}

	getViewData(): string {
		if (!this.doc || this.readOnly || !this.mapEdited) return this.data;
		this.knownText = serialize(this.doc);
		return this.knownText;
	}

	// The note's text as this view last loaded or saved it. Obsidian sets
	// this.data to the new text before calling setViewData, so this.data can't
	// tell whether the file changed underneath the map.
	private knownText: string | null = null;

	setViewData(data: string, clear: boolean): void {
		const old = clear ? null : this.doc;
		const keepPath = old && this.selected ? pathOf(old.root, this.selected) : null;
		const focusPath = old && this.focusRoot ? pathOf(old.root, this.focusRoot) : null;
		const prevShown = old ? this.shownByPath() : null;
		this.endDrag(false);
		// A reload (say, obsidian-git pulling the phone's edits) mustn't throw
		// away a topic being typed: carry the text over to the same position.
		const typing =
			old && this.editing ? { path: pathOf(old.root, this.editing.node), edit: this.finishEdit() } : null;
		this.editing = null;
		const changed = data !== this.knownText;
		this.knownText = data;
		this.data = data;
		this.mapEdited = false;
		this.doc = parse(data, this.file?.basename);
		this.readOnly = this.doc.unsupported.length > 0;
		// Undo snapshots describe the old file. Restoring one after someone else's
		// changes arrived would silently delete those changes.
		if (clear || changed) {
			this.undoStack = [];
			this.redoStack = [];
		}
		if (clear) this.needsFit = true;
		if (typing?.path && typing.edit && !this.readOnly) {
			const target = nodeAtPath(this.doc.root, typing.path);
			if (target && typing.edit.text !== "" && typing.edit.text !== typing.edit.original) {
				target.text = typing.edit.text;
				this.markDirty();
			}
		}
		this.clearNodes();
		this.pendingFrom = prevShown;
		this.focusRoot = (focusPath && nodeAtPath(this.doc.root, focusPath)) || null;
		const keep = (keepPath && nodeAtPath(this.doc.root, keepPath)) || this.centre()!;
		this.setSelection(singleSelection(keep), false);
		this.showBanner();
		this.showFocusBar();
		void this.refresh();
	}

	clear(): void {
		this.endDrag(false);
		this.doc = null;
		this.focusRoot = null;
		this.clearNodes();
		this.notifyMapChange(); // outline pane hook
	}

	// ---- Rendering --------------------------------------------------------

	private clearNodes() {
		for (const ne of this.nodeEls.values()) {
			if (ne.component) this.removeChild(ne.component);
			ne.el.remove();
		}
		this.nodeEls.clear();
		for (const ne of this.parkedEls.values()) this.dropNodeEl(ne);
		this.parkedEls.clear();
		this.boxes.clear();
		this.stopAnim();
		this.cancelOffscreen();
		this.shown.clear();
		for (const el of this.edgeEls.values()) el.remove();
		this.edgeEls.clear();
		this.edgeDrawn.clear();
		for (const els of this.linkEls.values()) {
			els.hit.remove();
			els.path.remove();
			els.text.remove();
		}
		this.linkEls.clear();
		this.clearBrackets(); // boundaries and summaries
	}

	// Elements of topics that are in the map but not shown (see refresh).
	private parkedEls = new Map<MindNode, NodeEl>();

	private dropNodeEl(ne: NodeEl) {
		if (ne.component) this.removeChild(ne.component);
		ne.el.remove();
	}

	private topicsInMap(root: MindNode): Set<MindNode> {
		const out = new Set<MindNode>();
		const walk = (n: MindNode): void => {
			out.add(n);
			n.children.forEach(walk);
		};
		walk(root);
		return out;
	}

	// The topic in the middle of the map: the focused branch, else the root.
	private centre(): MindNode | null {
		return this.focusRoot ?? this.doc?.root ?? null;
	}

	private walkPaths(fn: (n: MindNode, path: string) => void) {
		const walk = (n: MindNode, path: string) => {
			fn(n, path);
			n.children.forEach((c, i) => walk(c, path ? `${path}.${i}` : String(i)));
		};
		if (this.doc) walk(this.doc.root, "");
	}

	private shownByPath(): Map<string, Box> {
		const out = new Map<string, Box>();
		this.walkPaths((n, path) => {
			const b = this.shown.get(n);
			if (b) out.set(path, b);
		});
		return out;
	}

	private showBanner() {
		if (!this.doc || !this.readOnly) {
			this.banner.hide();
			return;
		}
		const first = this.doc.unsupported[0];
		this.banner.empty();
		this.banner.createSpan({
			text:
				`Editing is off to protect this note. Line ${first.line} ("${first.text.trim().slice(0, 40)}") ` +
				`isn't a heading or bullet, and saving from the map would drop it.`,
		});
		const btn = this.banner.createEl("button", { text: "Open as Markdown" });
		btn.onclick = () => this.plugin.openAsMarkdown(this.leaf);
		this.banner.show();
	}

	// The breadcrumb shown while focused on a branch: a way back, and the path
	// from the whole map's centre down to the focused topic.
	private showFocusBar() {
		const doc = this.doc;
		const focus = this.focusRoot;
		this.focusBar.empty();
		if (!doc || !focus) {
			this.focusBar.hide();
			return;
		}
		const back = this.focusBar.createEl("button", { cls: "mm-focus-back", text: "Back to whole map" });
		back.onclick = () => {
			this.exitFocus();
			this.viewport.focus();
		};
		const trail = this.focusBar.createDiv({ cls: "mm-focus-trail", attr: { "aria-label": "Focused branch" } });
		let n = doc.root;
		const chain = [n];
		for (const i of pathOf(doc.root, focus) ?? []) chain.push((n = n.children[i]));
		chain.forEach((c, i) => {
			if (i > 0) trail.createSpan({ cls: "mm-focus-sep", text: "›" });
			const label = c.text.trim() || "Topic";
			if (c === focus) {
				trail.createSpan({ cls: "mm-focus-current", text: label });
				return;
			}
			const b = trail.createEl("button", { cls: "mm-focus-crumb", text: label });
			b.onclick = () => {
				if (c === doc.root) this.exitFocus();
				else this.focusBranch(c);
				this.viewport.focus();
			};
		});
		this.focusBar.show();
	}

	// Sync DOM nodes with the tree, wait for Markdown to render, then lay out.
	async refresh() {
		const seq = ++this.renderSeq;
		const doc = this.doc;
		if (!doc) return;
		this.notifyMapChange(); // outline pane hook

		if (this.focusRoot && !isAncestor(doc.root, this.focusRoot)) {
			this.focusRoot = null;
			this.showFocusBar();
		}
		const centre = this.centre()!;
		const live = new Set<MindNode>();
		const renders: Promise<void>[] = [];
		const visit = (n: MindNode, depth: number) => {
			live.add(n);
			const render = this.syncNode(n, depth);
			if (render) renders.push(render);
			// A folded topic in focus still shows its children; focusing doesn't unfold it in the file.
			// Further central topics are drawn as centres, so their depth restarts.
			if (!n.collapsed || n === centre)
				for (const c of n.children) visit(c, n === this.doc?.root && c.central ? 0 : depth + 1);
		};
		visit(centre, 0);

		// Topics no longer shown. Those still in the map (folded away, or
		// outside a focused branch) keep their element, detached, for when they
		// come back: unfolding a big branch then doesn't build, render and
		// measure every topic in it again. Deleted ones are let go.
		let inMap: Set<MindNode> | null = null;
		for (const [n, ne] of this.nodeEls) {
			if (live.has(n)) continue;
			ne.el.remove();
			this.nodeEls.delete(n);
			inMap ??= this.topicsInMap(doc.root);
			if (inMap.has(n)) this.parkedEls.set(n, ne);
			else this.dropNodeEl(ne);
		}
		if (inMap) {
			for (const [n, ne] of this.parkedEls) {
				if (inMap.has(n)) continue;
				this.parkedEls.delete(n);
				this.dropNodeEl(ne);
			}
		}

		// Topics folded away, deleted or outside the focus drop out of the selection.
		const sel = pruneSelection(this.currentSelection(), (n) => live.has(n), centre);
		if (sel.primary !== this.selected || sel.set.size !== this.selection.size) this.setSelection(sel, false);

		await Promise.all(renders);
		if (seq !== this.renderSeq) return;
		this.relayout();
	}

	// Returns the Markdown render to wait for, if the label needs one.
	private syncNode(n: MindNode, depth: number): Promise<void> | null {
		let ne = this.nodeEls.get(n);
		if (!ne && (ne = this.parkedEls.get(n))) {
			this.parkedEls.delete(n);
			this.canvas.appendChild(ne.el);
			this.nodeEls.set(n, ne);
		}
		if (!ne) {
			// Plain DOM calls: Obsidian's createDiv parses its options each time,
			// which added up to a large share of opening a big map.
			const el = document.createElement("div");
			el.className = "mm-node";
			el.dataset.nodeId = String(n.id);
			// Hidden until the first layout places it, so it never flashes at the
			// origin. Hidden rather than only transparent too, as it may wait off
			// screen to be placed (see flushOffscreen) and mustn't catch clicks.
			el.addClass("mm-unplaced");
			const label = el.appendChild(document.createElement("div"));
			label.className = "mm-label";
			const badge = el.appendChild(document.createElement("div"));
			badge.className = "mm-badge";
			this.canvas.appendChild(el);
			ne = { el, label, badge, renderedText: null, component: null, colourClass: "", transform: "", opacity: "", at: null, size: null, side: "", state: "" };
			this.nodeEls.set(n, ne);
		}
		setClass(ne.el, "is-selected", n === this.selected);
		setClass(ne.el, "is-multi", this.selection.size > 1 && this.selection.has(n));
		// Every folded topic shows its count except the one in the middle of the
		// view (a focused branch shows its children whatever the fold).
		const folded = n.collapsed && n.children.length > 0 && n !== this.centre();
		const count = folded ? String(countDescendants(n)) : "";
		const empty = n.text.trim() === "";
		// The rest only when something it shows has changed: refresh visits
		// every topic, often twice per edit.
		const state = `${Math.min(depth, 2)}|${count}|${empty}|${!!n.note}`;
		if (ne.state !== state) {
			ne.state = state;
			let resized = setClass(ne.el, "is-root", depth === 0);
			resized = setClass(ne.el, "is-branch", depth === 1) || resized;
			resized = setClass(ne.el, "is-leaf", depth > 1) || resized;
			setClass(ne.el, "is-collapsed", folded);
			resized = setClass(ne.el, "is-empty", empty) || resized;
			if (ne.badge.textContent !== count) ne.badge.setText(count);
			ne.badge.toggle(folded);
			resized = this.syncNoteMarker(n, ne.el) || resized; // Notes and images
			if (resized) ne.size = null;
		}

		if (this.editing?.node === n) return null;
		if (ne.renderedText === n.text) return null;
		ne.renderedText = n.text;
		ne.size = null;
		if (ne.component) {
			this.removeChild(ne.component);
			ne.component = null;
		}
		ne.label.empty();
		if (!MARKDOWN_HINT.test(n.text)) {
			ne.label.setText(n.text);
			return null;
		}
		const component = new Component();
		this.addChild(component);
		ne.component = component;
		const rendered = ne;
		// A relayout while it renders may measure it half done, so measure again after.
		return MarkdownRenderer.render(this.app, n.text, ne.label, this.file?.path ?? "", component).then(() => {
			rendered.size = null;
		});
	}

	// Lays the map out and moves topics to their new places. It glides unless
	// the user prefers reduced motion or is typing (each keystroke would restart
	// it), though a glide already under way carries on to the new target.
	private relayout(animate = !this.editing) {
		const doc = this.doc;
		const centre = this.centre();
		if (!doc || !centre) return;
		// Settings change topic sizes through the view's own style and classes
		// (say --mm-topic-width); measure everything again when they change.
		const look = `${this.contentEl.className}|${this.contentEl.getAttribute("style") ?? ""}`;
		if (look !== this.sizedLook) {
			this.sizedLook = look;
			this.forgetSizes();
		}
		const editing = this.editing?.node;
		const sizeOf = (n: MindNode): Size => {
			const ne = this.nodeEls.get(n);
			if (!ne) return { w: 80, h: 28 };
			// The topic being typed in changes size with every key.
			if (!ne.size || n === editing) ne.size = { w: ne.el.offsetWidth, h: ne.el.offsetHeight };
			return ne.size;
		};
		// Lay out an unfolded stand-in for a folded centre rather than unfold it.
		const stand: MindNode = centre.collapsed ? { ...centre, collapsed: false } : centre;
		const real = (n: MindNode) => (n === stand ? centre : n);
		const laid = layoutTree(stand, (n) => sizeOf(real(n)), doc.settings.layout, {
			spacing: spacingValue(settingsOf(this.plugin).spacing), // Settings hook: spacing
		});
		// Copied only when a stand-in took the centre's place.
		this.boxes = stand === centre ? laid : new Map([...laid].map(([n, b]) => [real(n), b]));

		this.focusColour =
			this.focusRoot && this.focusRoot !== doc.root
				? (pathOf(doc.root, this.focusRoot)?.[0] ?? 0) % BRANCH_COLORS
				: -1;
		this.inheritedColors.clear();
		const inherit = (n: MindNode, color: BranchColor | undefined) => {
			const own = n === doc.root ? undefined : (n.color ?? color);
			if (own) this.inheritedColors.set(n, own);
			for (const c of n.children) inherit(c, own);
		};
		inherit(doc.root, undefined);

		for (const [n, box] of this.boxes) {
			const ne = this.nodeEls.get(n);
			if (!ne) continue;
			if (ne.side !== box.side) ne.el.dataset.side = ne.side = box.side;
			const cls = this.colourClass(n, box);
			if (ne.colourClass !== cls) {
				if (ne.colourClass) ne.el.removeClass(ne.colourClass);
				if (cls) ne.el.addClass(cls);
				ne.colourClass = cls;
			}
		}

		let from = this.shown;
		const byPath = this.pendingFrom;
		if (byPath) {
			from = new Map();
			this.walkPaths((n, path) => {
				const b = byPath.get(path);
				if (b) from.set(n, b);
			});
			this.pendingFrom = null;
		}
		const glide =
			(animate || this.anim !== null) &&
			from.size > 0 &&
			!prefersReducedMotion() &&
			settingsOf(this.plugin).animation && // Settings hook: animation
			moved(from, this.boxes);
		// The view is settled first, so painting knows what's on screen.
		if (this.needsFit && this.viewSize().w > 0) this.fit();
		else this.applyTransform();
		if (glide) this.animateFrom(from);
		else {
			this.stopAnim();
			this.paintFinal();
		}
	}

	// Branch colour index for a box. In focus every topic keeps the colour of
	// the top-level branch it belongs to in the whole map.
	private colourOf(box: Box): number {
		if (this.focusColour >= 0) return this.focusColour;
		return box.branch >= 0 ? box.branch % BRANCH_COLORS : -1;
	}

	// The focused branch's colour index, worked out once per layout rather than
	// once per line per frame.
	private focusColour = -1;

	// The colour class for a topic: a colour set on it or its nearest coloured
	// ancestor wins; otherwise the automatic colour of its top-level branch.
	private colourClass(n: MindNode, box: Box): string {
		const color = this.inheritedColors.get(n);
		if (color) return `mm-color-${color}`;
		const c = this.colourOf(box);
		return c >= 0 ? `mm-c${c}` : "";
	}

	// Colours the selected branches; null goes back to the automatic colour.
	private inheritedColors = new Map<MindNode, BranchColor>();

	setBranchColor(color: BranchColor | null) {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		const targets = topmost(this.currentSelection().set).filter((n) => n !== doc.root);
		if (targets.length === 0) return;
		this.mutate(() => {
			for (const n of targets) {
				if (color) n.color = color;
				else delete n.color;
			}
		});
	}

	private onContextMenu(e: MouseEvent) {
		if (!this.doc) return;
		// Boundaries and summaries: a right-click on a brace or its text.
		const sm = this.summaryFromEvent(e);
		if (sm) this.selectSummary(sm);
		else if (this.selectedSummary) this.selectSummary(null);
		const link = sm ? null : this.linkFromEvent(e);
		const n = link || sm ? null : this.nodeFromEvent(e);
		if (link) this.selectLink(link);
		else if (n && !this.selection.has(n)) this.select(n);
		const menu = sm ? this.bracketMenu(sm) : link ? this.linkMenu(link) : n ? this.topicMenu(n) : this.backgroundMenu();
		if (!menu) return;
		e.preventDefault();
		menu.showAtMouseEvent(e);
	}

	// The same menus from a toolbar button, for phones and tablets, where
	// there's no right-click and a long press starts a drag.
	private showActionsMenu(anchor: HTMLElement) {
		if (!this.doc) return;
		const menu = this.selectedSummary
			? this.bracketMenu(this.selectedSummary)
			: this.selectedLink
			? this.linkMenu(this.selectedLink)
			: this.selected
				? this.topicMenu(this.selected)
				: this.backgroundMenu();
		if (!menu) return;
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.top });
	}

	private backgroundMenu(): Menu | null {
		if (this.readOnly) return null;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("New central topic").setIcon("plus-circle").onClick(() => this.addCentralTopic()));
		return menu;
	}

	private topicMenu(n: MindNode): Menu {
		const doc = this.doc!;
		const menu = new Menu();
		if (!this.readOnly) {
			menu.addItem((i) => i.setTitle("Edit topic").setIcon("pencil").onClick(() => this.startEdit(n)));
			menu.addItem((i) => i.setTitle("Add child topic").setIcon("plus").onClick(() => this.addChildTopic()));
			if (n !== this.centre()) {
				menu.addItem((i) => i.setTitle("Add topic after").setIcon("list-plus").onClick(() => this.addSibling()));
			}
			if (n.children.length > 0 && n !== this.centre()) {
				menu.addItem((i) =>
					i
						.setTitle(n.collapsed ? "Unfold branch" : "Fold branch")
						.setIcon(n.collapsed ? "chevrons-up-down" : "chevrons-down-up")
						.onClick(() => this.toggleCollapse(n)),
				);
			}
		}
		menu.addItem((i) => i.setTitle("Focus on this branch").setIcon("crosshair").onClick(() => this.focusBranch()));
		const target = linkedNote(n.text);
		if (target) {
			menu.addItem((i) =>
				i
					.setTitle("Open linked note")
					.setIcon("file-text")
					.onClick(() => this.app.workspace.openLinkText(target, this.file?.path ?? "", "tab")),
			);
		} else if (!this.readOnly) {
			menu.addItem((i) => i.setTitle("Turn into a note").setIcon("file-plus").onClick(() => this.topicToNote(n)));
		}
		if (!this.readOnly) {
			menu.addItem((i) =>
				i.setTitle("Link to another topic…").setIcon("spline").onClick(() => this.startLinking(n)),
			);
			if (n !== doc.root && !isCentral(doc.root, n)) {
				menu.addItem((i) =>
					i.setTitle("Make it a separate central topic").setIcon("git-fork").onClick(() => this.detachCentral(n)),
				);
			}
			menu.addItem((i) => i.setTitle("New central topic").setIcon("plus-circle").onClick(() => this.addCentralTopic()));
		}
		// Boundaries and summaries
		if (!this.readOnly && n !== doc.root) {
			if (n.boundary === undefined) {
				menu.addItem((i) => i.setTitle("Add boundary").setIcon("square-dashed").onClick(() => this.addBoundary(n)));
			} else {
				menu.addItem((i) => i.setTitle("Edit boundary label").setIcon("tag").onClick(() => this.editBoundaryLabel(n)));
				menu.addItem((i) => i.setTitle("Remove boundary").setIcon("square-x").onClick(() => this.removeBoundary(n)));
			}
			const run = this.summarySiblings();
			if (run) {
				menu.addItem((i) =>
					i.setTitle("Add summary…").setIcon("braces").onClick(() => this.addSummaryFromSelection(run)),
				);
			}
		}
		// Notes and images
		if (!this.readOnly) {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle(n.note ? "Edit note…" : "Add note…")
					.setIcon("sticky-note")
					.onClick(() => this.editNote(n)),
			);
			if (n.note) menu.addItem((i) => i.setTitle("Remove note").setIcon("eraser").onClick(() => this.setTopicNote(n, "")));
			menu.addItem((i) => i.setTitle("Add image…").setIcon("image").onClick(() => this.addTopicImage(n)));
		}
		if (!this.readOnly && n !== doc.root) {
			menu.addSeparator();
			for (const color of COLORS) {
				menu.addItem((i) =>
					i
						.setTitle(`${color[0].toUpperCase()}${color.slice(1)} branch`)
						.setIcon("circle")
						.setChecked(n.color === color)
						.onClick(() => this.setBranchColor(color)),
				);
			}
			menu.addItem((i) =>
				i.setTitle("Automatic colour").setIcon("rotate-ccw").onClick(() => this.setBranchColor(null)),
			);
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Delete topic").setIcon("trash").onClick(() => this.deleteSelected()));
		}
		return menu;
	}

	private stopAnim() {
		if (this.anim !== null) cancelAnimationFrame(this.anim);
		this.anim = null;
	}

	private animateFrom(from: Map<MindNode, Box>) {
		this.stopAnim();
		const doc = this.doc!;
		const centre = this.centre()!;
		const to = this.boxes;
		// One walk up front: looking parents up per topic per frame is O(n²).
		const parents = new Map<MindNode, MindNode>();
		const index = (n: MindNode): void => n.children.forEach((c) => (parents.set(c, n), index(c)));
		index(doc.root);
		const parent = (n: MindNode) => (n === centre ? null : (parents.get(n) ?? null));
		// Only what's on screen glides; the rest goes straight to its place, as
		// restyling every moving topic each frame is what made big maps stutter.
		// Too many on screen at once (a whole large map zoomed out) and nothing
		// glides: frames that slow look worse than no animation.
		const view = visibleMapRect(this.viewSize(), this.tx, this.ty, this.scale, ANIM_MARGIN);
		const only = onScreenTopics(from, to, view);
		if (only.size > ANIM_MAX_TOPICS) return this.paintFinal();
		const t0 = performance.now();
		const step = (now: number) => {
			const k = Math.min(1, (now - t0) / ANIM_MS);
			if (k >= 1) {
				this.anim = null;
				this.paintFinal();
				return;
			}
			this.paint(interpolateLayout(from, to, easeOut(k), parent, only));
			this.anim = requestAnimationFrame(step);
		};
		this.paint(interpolateLayout(from, to, 0, parent, only));
		this.anim = requestAnimationFrame(step);
	}

	private paintFinal() {
		const frames = new Map<MindNode, Frame>();
		for (const [n, box] of this.boxes) frames.set(n, { box, opacity: 1 });
		this.paint(frames);
	}

	// Puts every topic and every line at one frame's boxes in a single pass, so
	// lines and topics never disagree mid-animation.
	// Topics off screen both where they were drawn and where they go are only
	// noted in offscreenNodes and moved later (see flushOffscreen): restyling
	// every moved topic made each edit on a large map cost hundreds of ms.
	private paint(frames: Map<MindNode, Frame>) {
		const shown = new Map<MindNode, Box>();
		const view = this.paintRect();
		for (const [n, f] of frames) {
			shown.set(n, f.box);
			const ne = this.nodeEls.get(n);
			if (!ne || !this.boxes.has(n)) continue;
			if ((!ne.at || !meetsRect(ne.at, view)) && !meetsRect(f.box, view)) this.offscreenNodes.set(n, f);
			else this.placeNode(n, ne, f);
		}
		this.shown = shown;
		this.drawEdges(shown, view);
		this.drawBrackets(shown); // boundaries and summaries
		this.drawLinks(shown);
		if (this.offscreenNodes.size + this.offscreenEdges.size > 0) this.scheduleOffscreen();
	}

	private placeNode(n: MindNode, ne: NodeEl, f: Frame) {
		this.offscreenNodes.delete(n);
		const fin = this.boxes.get(n);
		if (!fin) return;
		const sx = fin.w > 0 ? f.box.w / fin.w : 1;
		const sy = fin.h > 0 ? f.box.h / fin.h : 1;
		const scale = Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3 ? ` scale(${sx}, ${sy})` : "";
		const transform = `translate(${f.box.x}px, ${f.box.y}px)${scale}`;
		const opacity = f.opacity < 1 ? String(f.opacity) : "";
		if (ne.transform !== transform) ne.el.style.transform = ne.transform = transform;
		if (ne.opacity !== opacity) ne.el.style.opacity = ne.opacity = opacity;
		if (!ne.at) ne.el.removeClass("mm-unplaced");
		ne.at = f.box;
	}

	// ---- Off-screen topics and lines ----------------------------------------
	// What paint() and drawEdges() put off: off screen where they are and where
	// they go. They're moved as soon as panning or zooming brings them near the
	// view, and the rest a chunk at a time when the browser is idle, so the
	// DOM soon matches the layout again. Everything else (arrow keys, drops,
	// export, selection) works from this.boxes, never the DOM.
	private offscreenNodes = new Map<MindNode, Frame>();
	private offscreenEdges = new Map<MindNode, { p: Box; b: Box; depth: number }>();
	private offscreenFrame: number | null = null;
	private offscreenIdle: (() => void) | null = null;

	// The map area worth keeping up to date: the view and a margin round it.
	private paintRect(): Rect {
		return visibleMapRect(this.viewSize(), this.tx, this.ty, this.scale, PAINT_MARGIN);
	}

	private scheduleOffscreen() {
		if (this.offscreenFrame !== null) return;
		this.offscreenFrame = requestAnimationFrame(() => {
			this.offscreenFrame = null;
			this.flushOffscreen(true);
		});
	}

	// Moves the put-off topics and lines now in view (inView), or the next
	// chunk of the rest, then books the next idle chunk if any are left.
	private flushOffscreen(inView: boolean) {
		const view = this.paintRect();
		let budget = inView ? Infinity : OFFSCREEN_CHUNK;
		for (const [n, f] of this.offscreenNodes) {
			if (budget <= 0) break;
			const ne = this.nodeEls.get(n);
			if (!ne || !this.boxes.has(n)) this.offscreenNodes.delete(n);
			else if (!inView || meetsRect(f.box, view)) {
				this.placeNode(n, ne, f);
				budget--;
			}
		}
		for (const [c, e] of this.offscreenEdges) {
			if (budget <= 0) break;
			const path = this.edgeEls.get(c);
			const drawn = this.edgeDrawn.get(c);
			if (!path || !drawn) this.offscreenEdges.delete(c);
			else if (!inView || edgeMeets(e.p, e.b, view)) {
				this.writeEdge(c, path, drawn, e.p, e.b, e.depth);
				budget--;
			}
		}
		if (this.offscreenNodes.size + this.offscreenEdges.size > 0 && !this.offscreenIdle) {
			const run = () => {
				this.offscreenIdle = null;
				this.flushOffscreen(false);
			};
			// requestIdleCallback is missing on iOS, so a timer stands in there.
			if (typeof window.requestIdleCallback === "function") {
				const id = window.requestIdleCallback(run, { timeout: 1000 });
				this.offscreenIdle = () => window.cancelIdleCallback(id);
			} else {
				const id = window.setTimeout(run, 50);
				this.offscreenIdle = () => window.clearTimeout(id);
			}
		}
	}

	private cancelOffscreen() {
		this.offscreenNodes.clear();
		this.offscreenEdges.clear();
		if (this.offscreenFrame !== null) cancelAnimationFrame(this.offscreenFrame);
		this.offscreenFrame = null;
		this.offscreenIdle?.();
		this.offscreenIdle = null;
	}

	// Where a link end shows: the topic itself, or the nearest visible topic
	// above it when its branch is folded. Ends outside a focused branch hide
	// the line.
	private visibleEnd(n: MindNode, boxes: Map<MindNode, Box>, parents: Map<MindNode, MindNode>): MindNode | null {
		const centre = this.centre();
		if (!centre || !within(centre, n, parents)) return null;
		let cur: MindNode | undefined = n;
		while (cur && !boxes.has(cur)) cur = parents.get(cur);
		return cur ?? null;
	}

	private drawLinks(boxes: Map<MindNode, Box>) {
		const doc = this.doc;
		if (!doc) return;
		const parents = new Map<MindNode, MindNode>();
		const index = (n: MindNode): void => n.children.forEach((c) => (parents.set(c, n), index(c)));
		index(doc.root);
		const used = new Set<Link>();
		for (const link of doc.links) {
			if (!within(doc.root, link.from, parents) || !within(doc.root, link.to, parents)) continue;
			const a = this.visibleEnd(link.from, boxes, parents);
			const b = this.visibleEnd(link.to, boxes, parents);
			if (!a || !b || a === b) continue;
			let els = this.linkEls.get(link);
			if (!els) {
				// A wide invisible stroke under the visible one makes the line easy to hit.
				const hit = this.linksSvg.createSvg("path", { cls: "mm-link-hit" });
				const path = this.linksSvg.createSvg("path", { cls: "mm-link" });
				const text = this.linksSvg.createSvg("text", { cls: "mm-link-label" });
				els = { hit, path, text };
				this.linkEls.set(link, els);
			}
			const geo = linkPath(boxes.get(a)!, boxes.get(b)!);
			const selected = link === this.selectedLink;
			setAttr(els.hit, "d", geo.d);
			setAttr(els.path, "d", geo.d);
			setAttr(els.path, "marker-end", `url(#${this.markerId}${selected ? "-sel" : ""})`);
			setClass(els.path, "is-selected", selected);
			setClass(els.path, "is-folded", a !== link.from || b !== link.to);
			setTextIfChanged(els.text, link.label ?? "");
			setAttr(els.text, "x", String(geo.labelX));
			setAttr(els.text, "y", String(geo.labelY));
			setClass(els.text, "is-selected", selected);
			used.add(link);
		}
		for (const [link, els] of this.linkEls) {
			if (used.has(link)) continue;
			els.hit.remove();
			els.path.remove();
			els.text.remove();
			this.linkEls.delete(link);
		}
	}

	private linkFromEvent(e: Event): Link | null {
		const target = e.target as Element;
		if (!target.closest?.(".mm-link-hit, .mm-link, .mm-link-label")) return null;
		for (const [link, els] of this.linkEls) {
			if (els.hit === target || els.path === target || els.text === target) return link;
		}
		return null;
	}

	private selectLink(link: Link | null) {
		this.selectedLink = link;
		if (link) this.setSelection(singleSelection(this.selected ?? this.centre()!), false);
		this.drawLinks(this.shown);
	}

	// ---- Relationship lines -------------------------------------------------

	// Starts a new relationship line from a topic; the next topic clicked (or
	// chosen with the arrows and Enter) is the other end.
	startLinking(from: MindNode | null = this.selected) {
		if (!from || this.readOnly || !this.doc) return;
		this.linking = { from };
		this.viewport.addClass("is-linking");
		this.hint.setText("Click the topic to link to, or use the arrow keys and Enter. Escape cancels.");
		this.hint.show();
	}

	private stopLinking() {
		this.linking = null;
		this.viewport.removeClass("is-linking");
		this.hint.hide();
	}

	private finishLinking(to: MindNode) {
		const from = this.linking?.from;
		this.stopLinking();
		const doc = this.doc;
		if (!from || !doc) return;
		if (from === to) return;
		if (doc.links.some((l) => l.from === from && l.to === to)) {
			new Notice("Those topics are already linked.");
			return;
		}
		let made: Link | null = null;
		this.tryMutate(() => {
			if (!addLink(doc, from, to)) return false;
			made = doc.links[doc.links.length - 1];
			return true;
		});
		if (made) this.selectLink(made);
	}

	setLinkLabel(link: Link, label: string) {
		const doc = this.doc;
		if (!doc || this.readOnly || !doc.links.includes(link)) return;
		const next = label.trim();
		if ((link.label ?? "") === next) return;
		this.mutate(() => {
			if (next) link.label = next;
			else delete link.label;
		});
	}

	editLinkLabel(link: Link) {
		if (this.readOnly) return;
		new LinkLabelModal(this.app, link.label ?? "", (label) => this.setLinkLabel(link, label)).open();
	}

	reverseLink(link: Link) {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		if (doc.links.some((l) => l.from === link.to && l.to === link.from)) {
			new Notice("A link already runs the other way.");
			return;
		}
		this.mutate(() => {
			[link.from, link.to] = [link.to, link.from];
		});
	}

	deleteLink(link: Link) {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		if (this.selectedLink === link) this.selectedLink = null;
		this.mutate(() => removeLink(doc, link));
	}

	private linkMenu(link: Link): Menu | null {
		if (this.readOnly) return null;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Edit label").setIcon("pencil").onClick(() => this.editLinkLabel(link)));
		menu.addItem((i) => i.setTitle("Reverse direction").setIcon("arrow-left-right").onClick(() => this.reverseLink(link)));
		menu.addItem((i) => i.setTitle("Delete link").setIcon("trash").onClick(() => this.deleteLink(link)));
		return menu;
	}

	// Paths are kept per child and updated in place, since this runs every
	// animation frame.
	private drawEdges(boxes: Map<MindNode, Box>, view: Rect = this.paintRect()) {
		const centre = this.centre();
		if (!centre) return;
		const used = new Set<MindNode>();
		const walk = (n: MindNode, depth: number) => {
			if (n.collapsed && n !== centre) return;
			const p = boxes.get(n);
			if (!p) return;
			for (const c of n.children) {
				const b = boxes.get(c);
				if (!b) continue;
				// A further central topic stands on its own: no line to the first one.
				if (n === this.doc?.root && c.central) {
					walk(c, 0);
					continue;
				}
				let path = this.edgeEls.get(c);
				let drawn = this.edgeDrawn.get(c);
				if (!path || !drawn) {
					path = this.edges.createSvg("path");
					this.edgeEls.set(c, path);
					this.edgeDrawn.set(c, (drawn = { cls: "", d: "", depth: "", from: null, to: null, at: null }));
				}
				// Off screen where it is and where it goes: put off, like topics.
				if ((!drawn.at || !meetsRect(drawn.at, view)) && !edgeMeets(p, b, view)) {
					this.offscreenEdges.set(c, { p, b, depth });
				} else this.writeEdge(c, path, drawn, p, b, depth);
				used.add(c);
				walk(c, depth + 1);
			}
		};
		walk(centre, 0);
		for (const [c, el] of this.edgeEls) {
			if (used.has(c)) continue;
			el.remove();
			this.edgeEls.delete(c);
			this.edgeDrawn.delete(c);
			this.offscreenEdges.delete(c);
		}
	}

	// Written only when changed: this runs every frame for every line.
	private writeEdge(c: MindNode, path: SVGPathElement, drawn: EdgeDrawn, p: Box, b: Box, depth: number) {
		this.offscreenEdges.delete(c);
		const cls = `mm-edge ${this.colourClass(c, b) || "mm-c0"}`;
		const dep = String(depth + 1);
		if (drawn.cls !== cls) path.setAttribute("class", (drawn.cls = cls));
		const sameDepth = drawn.depth === dep;
		if (!sameDepth) path.dataset.depth = drawn.depth = dep;
		if (sameDepth && drawn.from && drawn.to && sameBox(drawn.from, p) && sameBox(drawn.to, b)) return;
		const d = edgePath(p, b, depth);
		if (drawn.d !== d) path.setAttribute("d", (drawn.d = d));
		drawn.from = p;
		drawn.to = b;
		drawn.at = edgeRect(p, b);
	}

	// ---- Pan and zoom -----------------------------------------------------

	// The viewport's size as the ResizeObserver last saw it (measured directly
	// until it first reports).
	private mmViewSize: { w: number; h: number } | null = null;

	private viewSize(): { w: number; h: number } {
		return this.mmViewSize ?? { w: this.viewport.clientWidth, h: this.viewport.clientHeight };
	}

	private applyTransform() {
		this.canvas.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
		// Panning or zooming can bring put-off topics into view.
		if (this.offscreenNodes.size + this.offscreenEdges.size > 0) this.scheduleOffscreen();
	}

	fit() {
		if (this.boxes.size === 0) return;
		// Boundaries and summary labels reach past the topics, so they count too.
		const doc = this.doc;
		const centre = this.centre();
		const extra = doc && centre ? decorationExtents(decorations(doc.root, centre, this.boxes, doc.summaries)) : [];
		const { minX, minY, maxX, maxY } = bounds([...this.boxes.values(), ...extra]);
		const { w: vw, h: vh } = this.viewSize();
		if (vw === 0 || vh === 0) return;
		const pad = 48;
		const s = Math.min(1, (vw - pad * 2) / (maxX - minX), (vh - pad * 2) / (maxY - minY));
		this.scale = Math.max(MIN_SCALE, s);
		this.tx = vw / 2 - ((minX + maxX) / 2) * this.scale;
		this.ty = vh / 2 - ((minY + maxY) / 2) * this.scale;
		this.needsFit = false;
		this.applyTransform();
	}

	zoomBy(factor: number, cx = this.viewSize().w / 2, cy = this.viewSize().h / 2) {
		const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		const k = next / this.scale;
		this.tx = cx - (cx - this.tx) * k;
		this.ty = cy - (cy - this.ty) * k;
		this.scale = next;
		this.needsFit = false;
		this.applyTransform();
	}

	private ensureVisible(n: MindNode) {
		const b = this.boxes.get(n);
		if (!b) return;
		const margin = 40;
		const { w: vw, h: vh } = this.viewSize();
		const left = b.x * this.scale + this.tx;
		const top = b.y * this.scale + this.ty;
		const right = left + b.w * this.scale;
		const bottom = top + b.h * this.scale;
		if (left < margin) this.tx += margin - left;
		else if (right > vw - margin) this.tx -= right - (vw - margin);
		if (top < margin) this.ty += margin - top;
		else if (bottom > vh - margin) this.ty -= bottom - (vh - margin);
		this.applyTransform();
	}

	private onWheel(e: WheelEvent) {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			// Trackpad pinch arrives as ctrl+wheel.
			const rect = this.viewport.getBoundingClientRect();
			this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
		} else {
			this.tx -= e.deltaX;
			this.ty -= e.deltaY;
			this.needsFit = false;
			this.applyTransform();
		}
	}

	private pointers = new Map<number, { x: number; y: number }>();

	private onPointerDown(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		if (this.drag) return;
		const onNode = (e.target as HTMLElement).closest(
			".mm-node, .mm-toolbar, .mm-banner, .mm-link-hit, .mm-link-label, .mm-summary-hit, .mm-summary-label",
		);
		const draggable = this.pointers.size === 0 ? this.draggableFromEvent(e) : null;
		if (onNode && this.pointers.size === 0 && e.pointerType !== "touch") {
			if (draggable) this.pressToDrag(e, draggable);
			return;
		}
		// A touch on a topic pans like the background does, so one finger can
		// always move the map; holding still for LONG_PRESS_MS drags the topic.
		// No pointer capture yet: capturing would retarget the tap's click.
		const touchOnNode = !!onNode && this.pointers.size === 0;
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (!touchOnNode) this.viewport.setPointerCapture(e.pointerId);
		this.viewport.addClass("is-panning");
		const rect = this.viewport.getBoundingClientRect();

		const startX = e.clientX;
		const startY = e.clientY;
		let longPress = 0;
		if (draggable && e.pointerType === "touch") {
			longPress = window.setTimeout(() => {
				longPress = 0;
				const at = this.pointers.get(e.pointerId);
				if (this.pointers.size !== 1 || !at) return;
				end();
				this.beginDrag(draggable, e.pointerId, at.x, at.y);
			}, LONG_PRESS_MS);
		}
		const cancelLongPress = () => {
			if (longPress) window.clearTimeout(longPress);
			longPress = 0;
		};

		const move = (ev: PointerEvent) => {
			const prev = this.pointers.get(ev.pointerId);
			if (!prev) return;
			if (longPress) {
				const far = Math.hypot(ev.clientX - startX, ev.clientY - startY) > TOUCH_SLOP;
				if (!far && this.pointers.size === 1) return; // hold still while a long press may become a drag
				cancelLongPress();
			}
			if (this.pointers.size === 1) {
				this.tx += ev.clientX - prev.x;
				this.ty += ev.clientY - prev.y;
				this.applyTransform();
			} else if (this.pointers.size === 2) {
				const [a, b] = [...this.pointers.entries()];
				const other = a[0] === ev.pointerId ? b[1] : a[1];
				const before = Math.hypot(prev.x - other.x, prev.y - other.y);
				const after = Math.hypot(ev.clientX - other.x, ev.clientY - other.y);
				if (before > 0) {
					this.zoomBy(
						after / before,
						(ev.clientX + other.x) / 2 - rect.left,
						(ev.clientY + other.y) / 2 - rect.top,
					);
				}
			}
			this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
			this.needsFit = false;
		};
		const end = () => {
			cancelLongPress();
			this.pointers.clear();
			this.viewport.removeClass("is-panning");
			this.viewport.removeEventListener("pointermove", move);
			this.viewport.removeEventListener("pointerup", up);
			this.viewport.removeEventListener("pointercancel", up);
		};
		const up = (ev: PointerEvent) => {
			this.pointers.delete(ev.pointerId);
			if (this.pointers.size > 0) return;
			end();
		};
		this.viewport.addEventListener("pointermove", move);
		this.viewport.addEventListener("pointerup", up);
		this.viewport.addEventListener("pointercancel", up);
	}

	// ---- Drag to restructure ----------------------------------------------

	// The topic a press on this event could drag, if any. The centre, a topic
	// being edited, links and fold badges are never drag handles.
	private draggableFromEvent(e: Event): MindNode | null {
		if (this.readOnly || !this.doc) return null;
		const target = e.target as HTMLElement;
		if (target.closest(".mm-badge, a, .is-editing")) return null;
		const n = this.nodeFromEvent(e);
		if (!n || n === this.centre() || this.editing?.node === n) return null;
		return n;
	}

	// A mouse or pen press becomes a drag once it travels DRAG_THRESHOLD;
	// otherwise it's left alone to end as a click.
	private pressToDrag(e: PointerEvent, n: MindNode) {
		// The map's own window, so dragging works in a popped-out window too.
		const win = this.viewport.ownerDocument.defaultView ?? window;
		const id = e.pointerId;
		const x0 = e.clientX;
		const y0 = e.clientY;
		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== id || Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
			stop();
			this.beginDrag(n, id, x0, y0);
			if (this.drag) this.updateDrag(ev.clientX, ev.clientY);
		};
		const stop = () => {
			win.removeEventListener("pointermove", move);
			win.removeEventListener("pointerup", stop);
			win.removeEventListener("pointercancel", stop);
		};
		win.addEventListener("pointermove", move);
		win.addEventListener("pointerup", stop);
		win.addEventListener("pointercancel", stop);
	}

	private beginDrag(n: MindNode, pointerId: number, clientX: number, clientY: number) {
		// The map's own window, so dragging works in a popped-out window too.
		const win = this.viewport.ownerDocument.defaultView ?? window;
		const doc = this.doc;
		const centre = this.centre();
		const box = this.boxes.get(n);
		const ne = this.nodeEls.get(n);
		if (!doc || !centre || !box || !ne || this.readOnly) return;
		this.commitEdit();

		// Dragging part of a multi-selection moves all of it; dragging anything
		// else drags just that topic and selects it.
		let nodes: MindNode[];
		if (this.selection.has(n) && this.selection.size > 1) {
			nodes = inDocumentOrder(doc.root, topmost([...this.selection].filter((m) => m !== centre)));
			this.setSelection({ primary: n, set: this.selection }, false);
		} else {
			nodes = [n];
			this.setSelection(singleSelection(n), false);
		}

		const ghost = ne.el.cloneNode(true) as HTMLElement;
		ghost.removeClass("is-selected");
		ghost.removeClass("is-multi");
		ghost.addClass("mm-ghost");
		ghost.style.removeProperty("opacity");
		ghost.removeAttribute("data-node-id");
		if (nodes.length > 1) ghost.createDiv({ cls: "mm-ghost-count", text: String(nodes.length) });
		this.canvas.appendChild(ghost);
		const line = this.canvas.createDiv({ cls: "mm-drop-line" });
		line.hide();

		// One walk over the dragged branches, not one per topic on screen.
		const dragged = new Set<MindNode>();
		const gather = (m: MindNode): void => (dragged.add(m), m.children.forEach(gather));
		nodes.forEach(gather);
		const inDragged = (m: MindNode) => dragged.has(m);
		for (const [m, me] of this.nodeEls) setClass(me.el, "is-dragging", inDragged(m));
		for (const [m, path] of this.edgeEls) setClass(path, "is-dragging", inDragged(m));
		this.viewport.addClass("is-dragging");
		this.viewport.focus();
		try {
			this.viewport.setPointerCapture(pointerId);
		} catch {
			// The pointer may already be gone; the window listeners still end the drag.
		}

		const onMove = (ev: PointerEvent) => ev.pointerId === pointerId && this.updateDrag(ev.clientX, ev.clientY);
		const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && this.endDrag(true);
		const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && this.endDrag(false);
		win.addEventListener("pointermove", onMove);
		win.addEventListener("pointerup", onUp);
		win.addEventListener("pointercancel", onCancel);

		// Auto-pan near the viewport edge. Runs every frame, since the pointer
		// can sit still at the edge while the map scrolls under it.
		const tick = () => {
			const d = this.drag;
			if (!d) return;
			const rect = this.viewport.getBoundingClientRect();
			const v = edgePan({ x: d.client.x - rect.left, y: d.client.y - rect.top }, { w: rect.width, h: rect.height });
			if (v.dx || v.dy) {
				this.tx += v.dx;
				this.ty += v.dy;
				this.needsFit = false;
				this.applyTransform();
				this.updateDrag(d.client.x, d.client.y);
			}
			d.raf = requestAnimationFrame(tick);
		};

		this.drag = {
			pointerId,
			nodes,
			client: { x: clientX, y: clientY },
			ghost,
			line,
			drop: null,
			raf: requestAnimationFrame(tick),
			cleanup: () => {
				win.removeEventListener("pointermove", onMove);
				win.removeEventListener("pointerup", onUp);
				win.removeEventListener("pointercancel", onCancel);
			},
		};
		this.updateDrag(clientX, clientY);
	}

	private toMap(clientX: number, clientY: number) {
		const rect = this.viewport.getBoundingClientRect();
		return { x: (clientX - rect.left - this.tx) / this.scale, y: (clientY - rect.top - this.ty) / this.scale };
	}

	private updateDrag(clientX: number, clientY: number) {
		const d = this.drag;
		const centre = this.centre();
		if (!d || !centre) return;
		d.client = { x: clientX, y: clientY };
		const p = this.toMap(clientX, clientY);
		const off = GHOST_OFFSET / this.scale;
		d.ghost.style.transform = `translate(${p.x + off}px, ${p.y + off}px)`;

		const prev = d.drop;
		d.drop = resolveDrop(centre, this.boxes, p, d.nodes);
		if (prev?.target !== d.drop?.target || prev?.kind !== d.drop?.kind) {
			if (prev) this.nodeEls.get(prev.target)?.el.removeClass("is-drop-target");
			if (d.drop?.kind === "child") this.nodeEls.get(d.drop.target)?.el.addClass("is-drop-target");
		}
		const l = d.drop?.line;
		if (!l) {
			d.line.hide();
			return;
		}
		const across = l.y1 === l.y2;
		d.line.toggleClass("is-vertical", !across);
		d.line.style.transform = `translate(${Math.min(l.x1, l.x2)}px, ${Math.min(l.y1, l.y2)}px)`;
		d.line.style.width = across ? `${Math.abs(l.x2 - l.x1)}px` : "";
		d.line.style.height = across ? "" : `${Math.abs(l.y2 - l.y1)}px`;
		d.line.show();
	}

	// Ends a drag. A commit drops the topics at the current target as one undo
	// step; otherwise (Escape, a cancelled pointer) nothing changes.
	private endDrag(commit: boolean) {
		const d = this.drag;
		if (!d) return;
		this.drag = null;
		d.cleanup();
		cancelAnimationFrame(d.raf);
		d.ghost.remove();
		d.line.remove();
		if (d.drop) this.nodeEls.get(d.drop.target)?.el.removeClass("is-drop-target");
		for (const ne of this.nodeEls.values()) setClass(ne.el, "is-dragging", false);
		for (const path of this.edgeEls.values()) setClass(path, "is-dragging", false);
		this.viewport.removeClass("is-dragging");
		// The pointerup that ends a drag is followed by a click; it isn't one.
		this.suppressClick = true;
		window.setTimeout(() => (this.suppressClick = false), 0);

		const drop = d.drop;
		const doc = this.doc;
		if (!commit || !drop || !doc) return;
		const primary = this.selected && d.nodes.includes(this.selected) ? this.selected : d.nodes[0];
		this.tryMutate(() => moveAll(doc.root, d.nodes, drop.parent, drop.index));
		this.setSelection({ primary, set: new Set(d.nodes) }, false);
	}

	// ---- Mouse ------------------------------------------------------------

	private nodeFromEvent(e: Event): MindNode | null {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".mm-node");
		if (!el) return null;
		for (const [n, ne] of this.nodeEls) if (ne.el === el) return n;
		return null;
	}

	private onCanvasClick(e: MouseEvent) {
		if (this.suppressClick) {
			this.suppressClick = false;
			return;
		}
		const target = e.target as HTMLElement;
		const link = target.closest<HTMLAnchorElement>("a.internal-link");
		if (link) {
			e.preventDefault();
			const href = link.dataset.href ?? link.getAttr("href") ?? "";
			void this.app.workspace.openLinkText(href, this.file?.path ?? "", Keymap.isModEvent(e));
			return;
		}
		// Boundaries and summaries: a click on a brace or its text selects it.
		const sm = this.summaryFromEvent(e);
		if (sm) {
			if (this.linking) this.stopLinking();
			this.selectSummary(sm);
			this.viewport.focus();
			return;
		}
		if (this.selectedSummary) this.selectSummary(null);
		const rel = this.linkFromEvent(e);
		if (rel) {
			if (this.linking) this.stopLinking();
			this.selectLink(rel);
			this.viewport.focus();
			return;
		}
		const n = this.nodeFromEvent(e);
		if (this.linking) {
			if (n) this.finishLinking(n);
			else this.stopLinking();
			this.viewport.focus();
			return;
		}
		if (this.selectedLink) this.selectLink(null);
		if (!n || this.editing?.node === n) return;
		if (target.closest(".mm-badge")) {
			this.toggleCollapse(n);
			return;
		}
		if (this.editing && this.editing.node !== n) this.commitEdit();
		if (e.shiftKey || e.metaKey || e.ctrlKey) this.setSelection(toggleSelection(this.currentSelection(), n));
		else this.select(n);
		this.viewport.focus();
	}

	private onCanvasDblClick(e: MouseEvent) {
		const sm = this.summaryFromEvent(e); // boundaries and summaries
		if (sm) return this.editSummaryText(sm);
		const link = this.linkFromEvent(e);
		if (link) return this.editLinkLabel(link);
		const n = this.nodeFromEvent(e);
		if (n && this.editing?.node !== n) this.startEdit(n);
	}

	private onHover(e: MouseEvent) {
		const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
		if (!link) return;
		this.app.workspace.trigger("hover-link", {
			event: e,
			source: VIEW_TYPE_MINDMAP,
			hoverParent: this,
			targetEl: link,
			linktext: link.dataset.href ?? link.getAttr("href") ?? "",
			sourcePath: this.file?.path ?? "",
		});
	}

	// ---- Toolbar ----------------------------------------------------------

	private buildToolbar() {
		const bar = this.contentEl.createDiv({ cls: "mm-toolbar" });
		const button = (icon: string, label: string, run: (b: HTMLElement) => void) => {
			const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = () => {
				run(b);
				this.viewport.focus();
			};
		};
		button("more-horizontal", "Actions for the selected topic or line", (b) => this.showActionsMenu(b));
		button("crosshair", "Focus on this branch (Alt+F)", () => this.focusBranch());
		button("zoom-out", "Zoom out", () => this.zoomBy(1 / 1.2));
		button("zoom-in", "Zoom in", () => this.zoomBy(1.2));
		button("maximize", "Fit map to window", () => this.fit());
		button("layout-dashboard", "Change layout", () => this.toggleLayout());
	}

	toggleLayout() {
		if (!this.doc || this.readOnly) return;
		this.mutate(() => {
			this.doc!.settings.layout = LAYOUTS[(LAYOUTS.indexOf(this.doc!.settings.layout) + 1) % LAYOUTS.length];
		});
		this.needsFit = true;
	}

	// ---- Focus on a branch ----------------------------------------------------

	// Shows only one topic's branch, with that topic as the centre. Asking again
	// for the topic already in focus goes back to the whole map.
	focusBranch(n = this.selected) {
		const doc = this.doc;
		if (!doc || !n) return;
		if (n === doc.root || n === this.focusRoot) return this.exitFocus();
		this.commitEdit();
		this.focusRoot = n;
		this.setSelection(singleSelection(n), false);
		this.needsFit = true;
		this.showFocusBar();
		void this.refresh();
	}

	exitFocus() {
		if (!this.focusRoot) return;
		const was = this.focusRoot;
		this.commitEdit();
		this.focusRoot = null;
		this.setSelection(singleSelection(this.selected ?? was), false);
		this.needsFit = true;
		this.showFocusBar();
		void this.refresh();
	}

	// ---- Selection and editing ---------------------------------------------

	private currentSelection(): Selection<MindNode> {
		const primary = this.selected ?? this.centre()!;
		return { primary, set: this.selection.size > 0 ? this.selection : new Set([primary]) };
	}

	private setSelection(s: Selection<MindNode>, reveal = true) {
		this.selected = s.primary;
		this.selection = new Set(s.set);
		this.selection.add(s.primary);
		const multi = this.selection.size > 1;
		for (const [n, ne] of this.nodeEls) {
			setClass(ne.el, "is-selected", n === this.selected);
			setClass(ne.el, "is-multi", multi && this.selection.has(n));
		}
		if (reveal) this.ensureVisible(s.primary);
		this.notifyMapChange(); // outline pane hook
	}

	private select(n: MindNode) {
		this.setSelection(singleSelection(n));
	}

	private startEdit(n: MindNode, seed?: string, isNew = false) {
		if (this.readOnly) return;
		const ne = this.nodeEls.get(n);
		if (!ne) return;
		this.commitEdit();
		this.select(n);
		this.editing = { node: n, isNew, original: n.text };
		if (ne.component) {
			this.removeChild(ne.component);
			ne.component = null;
		}
		ne.renderedText = null;
		const label = ne.label;
		label.empty();
		label.setText(seed ?? n.text);
		label.contentEditable = "plaintext-only";
		label.addClass("is-editing");
		// No scrolling: the topic was just revealed, and the viewport never scrolls.
		// A topic waiting off screen is still hidden, and a hidden element can't
		// take focus: place it now so the typing lands in it.
		const pending = this.offscreenNodes.get(n);
		if (pending) this.placeNode(n, ne, pending);
		label.focus({ preventScroll: true });
		const range = document.createRange();
		range.selectNodeContents(label);
		if (seed !== undefined) range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		const onKey = (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.isComposing) return;
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.commitEdit();
				this.viewport.focus();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.cancelEdit();
				this.viewport.focus();
			} else if (e.key === "Tab") {
				e.preventDefault();
				this.commitEdit();
				this.addChildTopic();
			}
		};
		const onInput = () => this.relayout();
		const onBlur = () => this.commitEdit();
		label.addEventListener("keydown", onKey);
		label.addEventListener("input", onInput);
		label.addEventListener("blur", onBlur);
		this.editCleanup = () => {
			label.removeEventListener("keydown", onKey);
			label.removeEventListener("input", onInput);
			label.removeEventListener("blur", onBlur);
			label.contentEditable = "false";
			label.removeClass("is-editing");
		};
		// Starting to edit often leaves the topic's size as it was (a new empty
		// topic always does); then the layout stands, and laying out the whole
		// map again would only cost time.
		const was = this.boxes.get(n);
		const size = (ne.size = { w: ne.el.offsetWidth, h: ne.el.offsetHeight });
		if (!was || was.w !== size.w || was.h !== size.h) this.relayout();
	}

	private editCleanup: (() => void) | null = null;

	private finishEdit(): { node: MindNode; text: string; isNew: boolean; original: string } | null {
		const ed = this.editing;
		if (!ed) return null;
		const ne = this.nodeEls.get(ed.node);
		const text = (ne?.label.textContent ?? ed.node.text).replace(/\s*\n\s*/g, " ").trim();
		this.editing = null;
		if (ne) ne.size = null;
		this.editCleanup?.();
		this.editCleanup = null;
		return { node: ed.node, text, isNew: ed.isNew, original: ed.original };
	}

	commitEdit() {
		const r = this.finishEdit();
		if (!r) return;
		if (r.text === "" && r.isNew) {
			// An abandoned new topic disappears and takes no undo step with it.
			this.undoStack.pop();
			this.removeNode(r.node);
			this.markDirty();
			void this.refresh();
			return;
		}
		if (r.text === "" || r.text === r.original) {
			void this.refresh();
			return;
		}
		if (!r.isNew) this.pushUndo();
		r.node.text = r.text;
		this.markDirty();
		void this.refresh();
		if (this.focusRoot === r.node) this.showFocusBar();
	}

	private cancelEdit() {
		const r = this.finishEdit();
		if (!r) return;
		if (r.isNew) {
			this.undoStack.pop();
			this.removeNode(r.node);
			this.markDirty();
		}
		void this.refresh();
	}

	// ---- Structure changes ------------------------------------------------

	private snapshotNow(): Snapshot {
		const doc = this.doc!;
		return {
			tree: snapshot(doc.root),
			links: linksToRecords(doc.root, doc.links),
			summaries: summariesToRecords(doc.root, doc.summaries),
			layout: doc.settings.layout,
			selected: this.selected ? pathOf(doc.root, this.selected) : null,
		};
	}

	private pushUndo() {
		this.undoStack.push(this.snapshotNow());
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = [];
	}

	private mutate(change: () => void) {
		this.tryMutate(() => {
			change();
			return true;
		});
	}

	// Like mutate, for edits that may turn out to change nothing (a drop back
	// where the topic already was): those take no undo step and keep redo.
	private tryMutate(change: () => boolean): boolean {
		if (!this.doc || this.readOnly) return false;
		const before = this.snapshotNow();
		if (!change()) return false;
		this.undoStack.push(before);
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = [];
		this.markDirty();
		void this.refresh().then(() => this.selected && this.ensureVisible(this.selected));
		return true;
	}

	private restoreSnapshot(s: Snapshot) {
		const doc = this.doc!;
		const prevShown = this.shownByPath();
		const focusPath = this.focusRoot ? pathOf(doc.root, this.focusRoot) : null;
		doc.root = restore(s.tree);
		doc.links = recordsToLinks(doc.root, s.links);
		doc.summaries = recordsToSummaries(doc.root, s.summaries);
		this.selectedLink = null;
		doc.settings.layout = s.layout;
		this.clearNodes();
		this.pendingFrom = prevShown;
		// Focus follows its outline position; if that's gone, show the whole map.
		this.focusRoot = (focusPath && nodeAtPath(doc.root, focusPath)) || null;
		const centre = this.centre()!;
		const sel = (s.selected && nodeAtPath(doc.root, s.selected)) || centre;
		this.setSelection(singleSelection(isAncestor(centre, sel) ? sel : centre), false);
		this.showFocusBar();
		this.markDirty();
		void this.refresh();
	}

	undo() {
		if (this.readOnly || this.undoStack.length === 0) return;
		this.commitEdit();
		this.redoStack.push(this.snapshotNow());
		this.restoreSnapshot(this.undoStack.pop()!);
	}

	redo() {
		if (this.readOnly || this.redoStack.length === 0) return;
		this.undoStack.push(this.snapshotNow());
		this.restoreSnapshot(this.redoStack.pop()!);
	}

	private removeNode(n: MindNode) {
		if (!this.doc) return;
		const next = removeAll(this.doc.root, [n]);
		if (next && this.selected === n) this.setSelection(singleSelection(next), false);
	}

	addChildTopic() {
		const target = this.selected;
		if (!target || this.readOnly) return;
		const node = newNode("");
		this.mutate(() => {
			insertChild(target, node);
			this.setSelection(singleSelection(node), false);
		});
		void this.refresh().then(() => this.startEdit(node, "", true));
	}

	addSibling(before = false) {
		const target = this.selected;
		const doc = this.doc;
		if (!target || !doc || this.readOnly) return;
		if (target === this.centre()) return this.addChildTopic();
		const node = newNode("");
		// Beside a central topic, Enter makes another central topic.
		if (isCentral(doc.root, target)) node.central = true;
		this.mutate(() => {
			insertSibling(doc.root, target, node, before);
			this.setSelection(singleSelection(node), false);
		});
		void this.refresh().then(() => this.startEdit(node, "", true));
	}

	// Makes a note for a topic, beside the map, and turns the topic into a link
	// to it. If a note by that name already exists, the topic links to it
	// instead. The topic's branch stays in the map.
	async topicToNote(n: MindNode) {
		const file = this.file;
		if (!this.doc || !file || this.readOnly) return;
		const name = noteNameFor(n.text);
		const folder = file.parent?.path ?? "";
		const path = normalizePath(`${folder}/${name}.md`);
		// Reuse a note only when it is this exact file beside the map; a
		// same-named note elsewhere in the vault is probably something else.
		const found = this.app.vault.getAbstractFileByPath(path);
		let note: TFile | null = found instanceof TFile ? found : null;
		const existed = note !== null;
		if (!note) {
			try {
				const back = this.app.metadataCache.fileToLinktext(file, path);
				const made = await this.app.vault.create(path, `# ${name}\n\nFrom [[${back}]]\n`);
				note = made instanceof TFile ? made : null;
			} catch (err) {
				new Notice(`Couldn't create the note: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!note) {
				new Notice(`The note "${name}" was written but Obsidian can't see it, so the topic wasn't linked.`);
				return;
			}
		}
		// The map may have changed while the note was being written.
		const doc = this.doc;
		if (!doc || this.readOnly || !isAncestor(doc.root, n)) {
			new Notice(`Created "${note.basename}", but the map changed meanwhile, so link the topic by hand.`);
			return;
		}
		const link = this.app.metadataCache.fileToLinktext(note, file.path);
		const shown = n.text.trim();
		// Keep the topic's own wording as the link text when it's safe inside a link.
		const text = shown === link || /[[\]|]/.test(shown) ? `[[${link}]]` : `[[${link}|${shown}]]`;
		this.mutate(() => {
			n.text = text;
		});
		new Notice(existed ? `Linked to the existing note "${note.basename}".` : `Created the note "${note.basename}".`);
	}

	// Starts another central topic (another level-1 heading in the note) and
	// puts it in edit mode. Leaving it empty discards it, like any new topic.
	addCentralTopic() {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		if (this.focusRoot) this.exitFocus();
		const node = newNode("");
		node.central = true;
		// The map grows sideways, so show all of it again.
		this.needsFit = true;
		this.mutate(() => {
			doc.root.children.push(node);
			this.setSelection(singleSelection(node), false);
		});
		void this.refresh().then(() => this.startEdit(node, "", true));
	}

	detachCentral(n: MindNode) {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		this.needsFit = true;
		if (!this.tryMutate(() => detachAsCentral(doc.root, n))) this.needsFit = false;
	}

	// Deletes every selected topic, with its branch, as one undo step. The
	// centre is never deleted.
	deleteSelected() {
		const doc = this.doc;
		const centre = this.centre();
		if (!doc || !centre) return;
		const doomed = [...this.selection].filter((n) => n !== centre);
		if (doomed.length === 0) return;
		this.mutate(() => {
			const next = removeAll(doc.root, doomed) ?? centre;
			this.setSelection(singleSelection(isAncestor(centre, next) ? next : centre), false);
		});
	}

	// Space on a multi-selection folds them all, or unfolds them all if every
	// one is already folded.
	toggleCollapse(n?: MindNode) {
		const doc = this.doc;
		const centre = this.centre();
		if (!doc || !centre) return;
		const targets = (n ? [n] : [...this.selection]).filter((m) => m.children.length > 0 && m !== centre);
		if (targets.length === 0) return;
		const fold = targets.some((m) => !m.collapsed);
		this.mutate(() => {
			for (const m of targets) m.collapsed = fold;
		});
	}

	moveSelected(delta: -1 | 1) {
		const n = this.selected;
		const doc = this.doc;
		if (!n || !doc || n === this.centre() || this.readOnly) return;
		const parent = parentOf(doc.root, n)!;
		const j = parent.children.indexOf(n) + delta;
		if (j < 0 || j >= parent.children.length) return;
		// The first centre's own topics and the other central topics are written
		// in separate places, so a swap across that line wouldn't stick.
		if (!!parent.children[j].central !== !!n.central) return;
		this.mutate(() => reorder(doc.root, n, delta));
	}

	// ---- Keyboard -----------------------------------------------------------

	private onKeyDown(e: KeyboardEvent) {
		if (this.drag) {
			if (e.key === "Escape") this.endDrag(false);
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (this.editing || e.isComposing || !this.doc) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key;
		let handled = true;

		// While picking a link's other end, arrows move and Enter confirms.
		if (this.linking && !mod) {
			if (key === "Escape") this.stopLinking();
			else if (key === "Enter" && this.selected) this.finishLinking(this.selected);
			else if (key.startsWith("Arrow")) this.navigate(key);
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		// Boundaries and summaries: keys for a selected summary.
		if (this.selectedSummary && !mod && this.onBracketKey(e)) return;
		if (this.selectedLink && !mod) {
			const link = this.selectedLink;
			if (key === "Delete" || key === "Backspace") this.deleteLink(link);
			else if (key === "Enter" || key === "F2") this.editLinkLabel(link);
			else if (key === "Escape") this.selectLink(null);
			else handled = false;
			if (handled) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			this.selectLink(null);
			handled = true;
		}

		if (mod && key.toLowerCase() === "z") e.shiftKey ? this.redo() : this.undo();
		else if (mod && key.toLowerCase() === "y") this.redo();
		else if (mod) handled = false;
		// e.code, because Alt+F types "ƒ" on a Mac keyboard.
		else if (e.altKey && e.code === "KeyF") this.focusBranch();
		else if (e.altKey && e.code === "KeyL") this.startLinking();
		else if (e.altKey && e.code === "KeyN") this.editNote(); // Notes and images
		else if (e.altKey && key === "ArrowUp") this.moveSelected(-1);
		else if (e.altKey && key === "ArrowDown") this.moveSelected(1);
		else if (key.startsWith("Arrow")) this.navigate(key, e.shiftKey);
		else if (key === "Escape") {
			if (this.selection.size > 1) this.setSelection(collapseSelection(this.currentSelection()));
			else if (this.focusRoot) this.exitFocus();
			else handled = false;
		} else if (this.readOnly) handled = false;
		else if (key === "Tab" && !e.shiftKey) this.addChildTopic();
		else if (key === "Enter") this.addSibling(e.shiftKey);
		else if (key === "Delete" || key === "Backspace") this.deleteSelected();
		else if (key === " ") this.toggleCollapse();
		else if (key === "F2" && this.selected) this.startEdit(this.selected);
		else if (key.length === 1 && !e.altKey && this.selected) this.startEdit(this.selected, key);
		else handled = false;

		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	// Shift+arrow extends the selection; a plain arrow moves it.
	private navigate(key: string, extend = false) {
		const from = this.selected ?? this.doc?.root;
		if (!from) return;
		const dir = key.slice(5).toLowerCase() as Direction;
		const parent = this.doc ? parentOf(this.doc.root, from) : null;
		const related = [...(parent ? [parent, ...parent.children] : []), ...(from.collapsed ? [] : from.children)];
		const next = nearestInDirection(this.boxes, from, dir, related);
		if (!next) return;
		if (extend) this.setSelection(extendSelection(this.currentSelection(), next));
		else this.select(next);
	}

	// ---- Outline pane hook (src/outline.ts) ---------------------------------
	// A side pane mirrors the map through these. Names checked against
	// Obsidian's View/ItemView/FileView/TextFileView members (see `dirty`).

	private mapChangeListeners = new Set<() => void>();

	// Calls fn after the tree, folds, selection or loaded file change. Returns
	// a function that stops the calls.
	onMapChange(fn: () => void): () => void {
		this.mapChangeListeners.add(fn);
		return () => this.mapChangeListeners.delete(fn);
	}

	private notifyMapChange() {
		for (const fn of this.mapChangeListeners) fn();
	}

	selectedTopic(): MindNode | null {
		return this.selected;
	}

	// Selects a topic and pans it into view, leaving a focused branch first if
	// the topic is outside it.
	revealNode(n: MindNode) {
		const doc = this.doc;
		if (!doc || !isAncestor(doc.root, n)) return;
		this.commitEdit();
		if (this.selectedLink) this.selectLink(null);
		const leave = !!this.focusRoot && !isAncestor(this.focusRoot, n);
		if (leave) this.exitFocus();
		this.setSelection(singleSelection(n), !leave);
		if (leave) void this.refresh().then(() => this.ensureVisible(n));
	}

	// Renames a topic as one undo step, the same as finishing an edit on it.
	renameTopic(n: MindNode, text: string) {
		const doc = this.doc;
		const next = text.replace(/\s*\n\s*/g, " ").trim();
		if (!doc || next === "" || next === n.text) return;
		if (this.readOnly || !isAncestor(doc.root, n)) {
			// Say so rather than drop the typing: the map reloaded or went read-only.
			new Notice("The map changed while you were renaming, so the new name wasn't applied.");
			return;
		}
		this.commitEdit();
		this.mutate(() => {
			n.text = next;
		});
		if (this.focusRoot === n) this.showFocusBar();
	}

	// What export needs to redraw the map as it looks now: the laid-out boxes
	// and the theme's colours and font, read off the rendered nodes so the
	// active theme and any snippets come out in the file.
	exportSnapshot() {
		if (!this.doc || this.boxes.size === 0) return null;
		const doc = this.doc;
		const nodeColors = new Map<MindNode, string>();
		const badgeWidths = new Map<MindNode, number>();
		let accent: string | undefined, textOnAccent: string | undefined;
		let text: string | undefined, fontFamily: string | undefined, fontSize: number | undefined;
		for (const n of this.boxes.keys()) {
			const ne = this.nodeEls.get(n);
			if (!ne) continue;
			const el = ne.el;
			if (n.collapsed) badgeWidths.set(n, ne.badge.offsetWidth);
			const cs = getComputedStyle(el);
			if (n === doc.root) {
				accent = cs.backgroundColor;
				textOnAccent = cs.color;
				continue;
			}
			// Branch and leaf borders are drawn in --mm-color, already resolved.
			nodeColors.set(n, cs.borderBottomColor);
			text ??= cs.color;
			fontFamily ??= cs.fontFamily;
			fontSize ??= parseFloat(cs.fontSize) || undefined;
		}
		const vs = getComputedStyle(this.viewport);
		return {
			doc,
			boxes: new Map(this.boxes),
			style: {
				nodeColors,
				badgeWidths,
				background: vs.backgroundColor,
				accent,
				textOnAccent,
				text,
				fontFamily: fontFamily ?? vs.fontFamily,
				fontSize,
			},
		};
	}

	// The pictures shown in topics, for SVG and PNG export: each read from the
	// vault as a data URI (so the file stands alone and a PNG canvas isn't
	// tainted), placed where it sits inside its topic on screen. Images that
	// aren't vault files (web URLs) are left out.
	async exportImages(): Promise<Map<MindNode, ExportImage[]>> {
		const out = new Map<MindNode, ExportImage[]>();
		const file = this.file;
		if (!file) return out;
		// Each file is read once however many topics show it. Anything that isn't
		// an image, or is too big to embed, keeps its label text instead.
		const read = new Map<string, string | null>();
		let total = 0;
		for (const n of this.boxes.keys()) {
			const ne = this.nodeEls.get(n);
			if (!ne) continue;
			const imgs = [...ne.label.querySelectorAll("img")];
			if (imgs.length === 0) continue;
			const box = ne.el.getBoundingClientRect();
			const list: ExportImage[] = [];
			for (const img of imgs) {
				const embed = img.closest(".internal-embed");
				const target = (embed?.getAttribute("src") ?? "").split(/[#|]/)[0];
				const found = target ? this.app.metadataCache.getFirstLinkpathDest(target, file.path) : null;
				if (!(found instanceof TFile) || !isImageFile(found.extension)) continue;
				if (!read.has(found.path)) {
					const fits = found.stat.size <= EXPORT_IMAGE_MAX && total + found.stat.size <= EXPORT_IMAGES_TOTAL;
					if (fits) total += found.stat.size;
					read.set(
						found.path,
						fits ? `data:${imageMime(found.extension)};base64,${toBase64(await this.app.vault.readBinary(found))}` : null,
					);
				}
				const href = read.get(found.path);
				if (!href) continue;
				const r = img.getBoundingClientRect();
				list.push({
					href,
					x: (r.left - box.left) / this.scale,
					y: (r.top - box.top) / this.scale,
					w: r.width / this.scale,
					h: r.height / this.scale,
				});
			}
			if (list.length > 0) out.set(n, list);
		}
		return out;
	}

	// ---- Boundaries and summaries ----
	// A boundary is a rounded box around a topic's branch; a summary is a brace
	// beside a run of sibling topics with a short text. Both are worked out by
	// decorations() in layout.ts from the frame being painted, so they glide
	// with the topics. Names checked against Obsidian's View/TextFileView.

	// Boundaries sit under the tree's lines; braces sit above topics, like
	// relationship lines, so they stay clickable. Made on first use.
	private boundaryLayer: SVGSVGElement | null = null;
	private summaryLayer: SVGSVGElement | null = null;
	private boundaryEls = new Map<MindNode, { rect: SVGRectElement; text: SVGTextElement }>();
	private summaryEls = new Map<Summary, { hit: SVGPathElement; path: SVGPathElement; text: SVGTextElement }>();
	// The summary that's selected, if any; Delete removes it.
	private selectedSummary: Summary | null = null;

	private bracketLayers(): { under: SVGSVGElement; over: SVGSVGElement } {
		// onOpen empties the view and builds a new canvas, so check the layers are still in it.
		if (this.boundaryLayer?.parentElement !== this.canvas) {
			this.boundaryLayer = this.canvas.createSvg("svg", { cls: "mm-boundaries" });
			this.canvas.insertBefore(this.boundaryLayer, this.edges);
		}
		if (this.summaryLayer?.parentElement !== this.canvas) {
			this.summaryLayer = this.canvas.createSvg("svg", { cls: "mm-summaries" });
			this.linksSvg.after(this.summaryLayer);
		}
		return { under: this.boundaryLayer, over: this.summaryLayer };
	}

	private clearBrackets() {
		for (const els of this.boundaryEls.values()) {
			els.rect.remove();
			els.text.remove();
		}
		this.boundaryEls.clear();
		for (const els of this.summaryEls.values()) {
			els.hit.remove();
			els.path.remove();
			els.text.remove();
		}
		this.summaryEls.clear();
		this.selectedSummary = null;
	}

	// Runs every animation frame, so elements are kept and updated in place.
	private drawBrackets(boxes: Map<MindNode, Box>) {
		const doc = this.doc;
		const centre = this.centre();
		if (!doc || !centre) return;
		// Undo and reloads rebuild the summaries, which drops the selection.
		if (this.selectedSummary && !doc.summaries.includes(this.selectedSummary)) this.selectedSummary = null;
		const { boundaries, braces } = decorations(doc.root, centre, boxes, doc.summaries);
		if (boundaries.length + braces.length + this.boundaryEls.size + this.summaryEls.size === 0) return;
		const { under, over } = this.bracketLayers();
		const colour = (n: MindNode) => {
			const b = this.boxes.get(n) ?? boxes.get(n);
			return b ? this.colourClass(n, b) : "";
		};

		const usedB = new Set<MindNode>();
		for (const r of boundaries) {
			let els = this.boundaryEls.get(r.node);
			if (!els) {
				els = { rect: under.createSvg("rect"), text: under.createSvg("text") };
				this.boundaryEls.set(r.node, els);
			}
			const cls = colour(r.node);
			setAttr(els.rect, "class", cls ? `mm-boundary ${cls}` : "mm-boundary");
			setAttr(els.rect, "x", String(r.x));
			setAttr(els.rect, "y", String(r.y));
			setAttr(els.rect, "width", String(r.w));
			setAttr(els.rect, "height", String(r.h));
			setAttr(els.text, "class", cls ? `mm-boundary-label ${cls}` : "mm-boundary-label");
			setTextIfChanged(els.text, (r.node.boundary ?? "").trim());
			setAttr(els.text, "x", String(r.labelX));
			setAttr(els.text, "y", String(r.labelY));
			usedB.add(r.node);
		}
		for (const [n, els] of this.boundaryEls) {
			if (usedB.has(n)) continue;
			els.rect.remove();
			els.text.remove();
			this.boundaryEls.delete(n);
		}

		const usedS = new Set<Summary>();
		for (const br of braces) {
			let els = this.summaryEls.get(br.summary);
			if (!els) {
				// A wide invisible stroke under the brace makes it easy to hit.
				els = { hit: over.createSvg("path"), path: over.createSvg("path"), text: over.createSvg("text") };
				els.hit.setAttribute("class", "mm-summary-hit");
				this.summaryEls.set(br.summary, els);
			}
			const cls = colour(br.color) || "mm-c0";
			const sel = br.summary === this.selectedSummary ? " is-selected" : "";
			setAttr(els.hit, "d", br.d);
			setAttr(els.path, "d", br.d);
			setAttr(els.path, "class", `mm-summary ${cls}${sel}`);
			setAttr(els.text, "class", `mm-summary-label ${cls}${sel}`);
			setTextIfChanged(els.text, br.summary.text.trim());
			setAttr(els.text, "x", String(br.labelX));
			setAttr(els.text, "y", String(br.labelY));
			setAttr(els.text, "text-anchor", br.anchor);
			usedS.add(br.summary);
		}
		for (const [sm, els] of this.summaryEls) {
			if (usedS.has(sm)) continue;
			els.hit.remove();
			els.path.remove();
			els.text.remove();
			this.summaryEls.delete(sm);
		}
	}

	private summaryFromEvent(e: Event): Summary | null {
		const target = e.target as Element;
		if (!target.closest?.(".mm-summary-hit, .mm-summary, .mm-summary-label")) return null;
		for (const [sm, els] of this.summaryEls) {
			if (els.hit === target || els.path === target || els.text === target) return sm;
		}
		return null;
	}

	private selectSummary(sm: Summary | null) {
		this.selectedSummary = sm;
		if (sm) {
			if (this.selectedLink) this.selectLink(null);
			this.setSelection(singleSelection(this.selected ?? this.centre()!), false);
		}
		this.drawBrackets(this.shown);
	}

	// Delete, Enter/F2 and Escape act on a selected summary. Any other key
	// lets go of it and goes on to the topics; returns whether it was used.
	private onBracketKey(e: KeyboardEvent): boolean {
		const sm = this.selectedSummary;
		if (!sm) return false;
		const key = e.key;
		if (key === "Delete" || key === "Backspace") this.deleteSummary(sm);
		else if (key === "Enter" || key === "F2") this.editSummaryText(sm);
		else if (key === "Escape") this.selectSummary(null);
		else {
			this.selectSummary(null);
			return false;
		}
		e.preventDefault();
		e.stopPropagation();
		return true;
	}

	private bracketMenu(sm: Summary): Menu | null {
		if (this.readOnly) return null;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Edit summary").setIcon("pencil").onClick(() => this.editSummaryText(sm)));
		menu.addItem((i) => i.setTitle("Remove summary").setIcon("trash").onClick(() => this.deleteSummary(sm)));
		return menu;
	}

	// The selected topics, if they're all siblings a summary can span: the
	// topmost of the selection, sharing one parent, none of them a centre.
	private summarySiblings(): MindNode[] | null {
		const doc = this.doc;
		const centre = this.centre();
		if (!doc || !centre) return null;
		const nodes = topmost(this.currentSelection().set);
		if (nodes.some((n) => n === centre || n === doc.root || isCentral(doc.root, n))) return null;
		const parent = parentOf(doc.root, nodes[0]);
		if (!parent || nodes.some((n) => parentOf(doc.root, n) !== parent)) return null;
		return inDocumentOrder(doc.root, nodes);
	}

	addSummaryFromSelection(nodes: MindNode[] | null = this.summarySiblings()) {
		const doc = this.doc;
		if (!doc || !nodes || this.readOnly) return;
		new TextPromptModal(this.app, "Summary", "For example: phase one", "", (text) => {
			let made: Summary | null = null;
			this.tryMutate(() => {
				if (!addSummary(doc, nodes, text.trim())) return false;
				made = doc.summaries[doc.summaries.length - 1];
				return true;
			});
			if (made) this.selectSummary(made);
		}).open();
	}

	editSummaryText(sm: Summary) {
		if (this.readOnly) return;
		new TextPromptModal(this.app, "Summary", "For example: phase one", sm.text, (text) => {
			const doc = this.doc;
			const next = text.trim();
			if (!doc || !doc.summaries.includes(sm) || next === sm.text) return;
			this.mutate(() => {
				sm.text = next;
			});
		}).open();
	}

	deleteSummary(sm: Summary) {
		const doc = this.doc;
		if (!doc || this.readOnly) return;
		if (this.selectedSummary === sm) this.selectedSummary = null;
		this.tryMutate(() => removeSummary(doc, sm));
	}

	addBoundary(n: MindNode) {
		if (n.boundary !== undefined) return;
		this.mutate(() => {
			n.boundary = "";
		});
	}

	editBoundaryLabel(n: MindNode) {
		if (this.readOnly || n.boundary === undefined) return;
		new TextPromptModal(this.app, "Boundary label", "For example: phase one", n.boundary, (text) => {
			const next = text.trim();
			if (n.boundary === undefined || n.boundary === next || !this.doc || !isAncestor(this.doc.root, n)) return;
			this.mutate(() => {
				n.boundary = next;
			});
		}).open();
	}

	removeBoundary(n: MindNode) {
		if (n.boundary === undefined) return;
		this.mutate(() => {
			delete n.boundary;
		});
	}

	// ---- Notes and images ----
	// A topic's note shows as a marker at its edge; hovering the marker, or
	// clicking or tapping it, opens the note in a popover. Notes are written in
	// NoteModal and images picked with ImageSuggestModal (src/note-ui.ts). Names
	// here were checked against Obsidian's View/ItemView/TextFileView/Component
	// members (app.js 1.14.4) so none shadows one of Obsidian's own.

	private notePopover: { node: MindNode; el: HTMLElement; component: Component; pinned: boolean } | null = null;
	private notePopoverHideTimer = 0;
	private imageRelayoutFrame: number | null = null;

	private setupNotesAndImages() {
		// Images in topics load after MarkdownRenderer finishes, which changes the
		// topic's size. load doesn't bubble, so listen while capturing, and lay out
		// once per frame however many images arrive together.
		this.registerDomEvent(
			this.canvas,
			"load",
			(e) => {
				if ((e.target as Element).tagName === "IMG") this.scheduleImageRelayout();
			},
			{ capture: true },
		);
		// The marker is handled before the map's own listeners, so a click on it
		// neither selects the topic nor starts a drag or an edit.
		const onMarker = (e: Event) => (e.target as Element).closest?.(".mm-note-marker") ?? null;
		this.registerDomEvent(this.canvas, "pointerdown", (e) => onMarker(e) && e.stopPropagation(), { capture: true });
		this.registerDomEvent(this.canvas, "dblclick", (e) => onMarker(e) && e.stopPropagation(), { capture: true });
		this.registerDomEvent(
			this.canvas,
			"click",
			(e) => {
				if (!onMarker(e)) return;
				e.stopPropagation();
				e.preventDefault();
				const n = this.nodeFromEvent(e);
				if (!n) return;
				const p = this.notePopover;
				if (p && p.node === n && p.pinned) this.closeNotePopover();
				else if (p && p.node === n) p.pinned = true;
				else void this.showNotePopover(n, true);
			},
			{ capture: true },
		);
		this.registerDomEvent(this.canvas, "mouseover", (e) => {
			if (!onMarker(e)) return;
			const n = this.nodeFromEvent(e);
			window.clearTimeout(this.notePopoverHideTimer);
			if (n && this.notePopover?.node !== n) void this.showNotePopover(n, false);
		});
		this.registerDomEvent(this.canvas, "mouseout", (e) => {
			if (onMarker(e)) this.scheduleNotePopoverHide();
		});
		// Escape or a press anywhere else closes the note; so does any change to
		// the map, since the topic may have moved or gone.
		this.registerDomEvent(
			document,
			"keydown",
			(e) => {
				if (!this.notePopover || e.key !== "Escape") return;
				if ((e.target as Element).closest?.(".modal-container")) return;
				this.closeNotePopover();
				// Only claim the key when it was meant for this map; Escape pressed
				// in another pane still does its usual job there.
				if (this.contentEl.contains(e.target as Node)) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			{ capture: true },
		);
		this.registerDomEvent(
			document,
			"pointerdown",
			(e) => {
				const p = this.notePopover;
				if (!p) return;
				const t = e.target as Node;
				if (p.el.contains(t) || (t instanceof Element && t.closest(".mm-note-marker"))) return;
				this.closeNotePopover();
			},
			{ capture: true },
		);
		this.registerDomEvent(this.viewport, "wheel", () => this.placeNotePopover());
		this.register(this.onMapChange(() => this.closeNotePopover()));
		this.register(() => {
			this.closeNotePopover();
			if (this.imageRelayoutFrame !== null) cancelAnimationFrame(this.imageRelayoutFrame);
			this.imageRelayoutFrame = null;
		});
	}

	// The view's classes and inline style when topics were last measured.
	private sizedLook = "";

	// Forgets every measured topic size, so the next relayout measures them
	// all again. For anything that changes how big topics are drawn without
	// changing their text, depth or note (a setting, a class, a font).
	invalidateTopicSizes() {
		this.forgetSizes();
	}

	// Drops every cached topic size, so the next relayout measures them all.
	private forgetSizes() {
		for (const ne of this.nodeEls.values()) ne.size = null;
		for (const ne of this.parkedEls.values()) ne.size = null;
	}

	private scheduleImageRelayout() {
		if (this.imageRelayoutFrame !== null) return;
		this.imageRelayoutFrame = requestAnimationFrame(() => {
			this.imageRelayoutFrame = null;
			this.forgetSizes();
			this.relayout();
		});
	}

	// Adds, keeps or removes the note marker on a topic's element.
	// Returns whether the marker came or went (which changes the topic's size).
	private syncNoteMarker(n: MindNode, el: HTMLElement): boolean {
		const has = !!n.note;
		const changed = setClass(el, "has-note", has);
		let mark = el.querySelector<HTMLElement>(":scope > .mm-note-marker");
		if (!has) {
			mark?.remove();
			return changed;
		}
		if (!mark) {
			mark = el.createDiv({ cls: "mm-note-marker", attr: { "aria-label": "Show note", role: "button" } });
			setIcon(mark, "sticky-note");
		}
		return changed;
	}

	// Opens the note editor for a topic. Saving goes through setTopicNote.
	editNote(n: MindNode | null = this.selected) {
		const doc = this.doc;
		if (!doc || !n || this.readOnly || !isAncestor(doc.root, n)) return;
		this.commitEdit();
		this.closeNotePopover();
		const title = n.text.trim().length > 60 ? `${n.text.trim().slice(0, 60)}…` : n.text.trim();
		new NoteModal(this.app, title, n.note ?? "", (text) => this.setTopicNote(n, text)).open();
	}

	// Sets a topic's note as one undo step; blank text removes it.
	setTopicNote(n: MindNode, text: string) {
		const doc = this.doc;
		if (!doc) return;
		if (this.readOnly || !isAncestor(doc.root, n)) {
			new Notice("The map changed while you were writing, so the note wasn't saved.");
			return;
		}
		const next = normaliseNote(text);
		if ((n.note ?? null) === next) return;
		this.mutate(() => {
			if (next === null) delete n.note;
			else n.note = next;
		});
	}

	// Picks an image from the vault and adds it to the end of the topic's text.
	addTopicImage(n: MindNode | null = this.selected) {
		const doc = this.doc;
		if (!doc || !n || this.readOnly) return;
		this.commitEdit();
		new ImageSuggestModal(this.app, (file) => {
			if (!this.doc || this.readOnly || !isAncestor(this.doc.root, n)) {
				new Notice("The map changed meanwhile, so the image wasn't added.");
				return;
			}
			const link = this.app.metadataCache.fileToLinktext(file, this.file?.path ?? "");
			this.mutate(() => {
				n.text = appendToTopic(n.text, imageEmbed(link));
			});
		}).open();
	}

	private async showNotePopover(n: MindNode, pinned: boolean) {
		this.closeNotePopover();
		const ne = this.nodeEls.get(n);
		if (!n.note || !ne) return;
		const el = this.contentEl.createDiv({ cls: ["mm-note-popover", "markdown-rendered"] });
		el.setAttribute("role", "dialog");
		el.setAttribute("aria-label", "Topic note");
		const component = new Component();
		this.addChild(component);
		const popover = { node: n, el, component, pinned };
		this.notePopover = popover;
		if (!this.readOnly) {
			const edit = el.createEl("button", { cls: ["mm-note-edit", "clickable-icon"], attr: { "aria-label": "Edit note" } });
			setIcon(edit, "pencil");
			edit.onclick = () => this.editNote(n);
		}
		const body = el.createDiv({ cls: "mm-note-body" });
		el.addEventListener("mouseenter", () => window.clearTimeout(this.notePopoverHideTimer));
		el.addEventListener("mouseleave", () => this.scheduleNotePopoverHide());
		el.addEventListener("click", (e) => {
			const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
			if (!link) return;
			e.preventDefault();
			const href = link.dataset.href ?? link.getAttr("href") ?? "";
			void this.app.workspace.openLinkText(href, this.file?.path ?? "", Keymap.isModEvent(e));
		});
		el.addEventListener("mouseover", (e) => this.onHover(e));
		// Images in the note change its size as they load.
		el.addEventListener("load", () => this.placeNotePopover(), true);
		this.placeNotePopover();
		await MarkdownRenderer.render(this.app, n.note, body, this.file?.path ?? "", component);
		if (this.notePopover === popover) this.placeNotePopover();
	}

	// Puts the popover beside its topic, inside the view.
	private placeNotePopover() {
		const p = this.notePopover;
		if (!p) return;
		const ne = this.nodeEls.get(p.node);
		if (!ne) return this.closeNotePopover();
		const area = this.contentEl.getBoundingClientRect();
		const r = ne.el.getBoundingClientRect();
		const at = placePopover(
			{ left: r.left - area.left, top: r.top - area.top, width: r.width, height: r.height },
			{ width: p.el.offsetWidth, height: p.el.offsetHeight },
			{ left: 0, top: 0, width: area.width, height: area.height },
		);
		p.el.style.left = `${at.left}px`;
		p.el.style.top = `${at.top}px`;
	}

	private scheduleNotePopoverHide() {
		window.clearTimeout(this.notePopoverHideTimer);
		this.notePopoverHideTimer = window.setTimeout(() => {
			if (this.notePopover && !this.notePopover.pinned) this.closeNotePopover();
		}, 300);
	}

	private closeNotePopover() {
		window.clearTimeout(this.notePopoverHideTimer);
		const p = this.notePopover;
		if (!p) return;
		this.notePopover = null;
		this.removeChild(p.component);
		p.el.remove();
	}
}

// Asks for a relationship line's label. Obsidian has no prompt(), so it's a
// small modal: Enter saves, Escape cancels, an empty label removes it.
class LinkLabelModal extends Modal {
	// Focus goes back where it was (the map) when the dialog closes, so keys
	// like Escape and Delete keep working without another click.
	private mmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	constructor(
		app: MindMapView["app"],
		private initial: string,
		private onSubmit: (label: string) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Link label");
		const input = this.contentEl.createEl("input", {
			cls: "mm-link-input",
			attr: { type: "text", placeholder: "For example: depends on", value: this.initial },
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.onSubmit(input.value);
				this.close();
			}
		});
		// A Save button too: phone keyboards don't always offer Enter.
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
		save.onclick = () => {
			this.onSubmit(input.value);
			this.close();
		};
		window.setTimeout(() => input.select(), 0);
	}

	onClose() {
		this.contentEl.empty();
		const back = this.mmReturnFocus;
		window.setTimeout(() => back?.isConnected && back.focus(), 0);
	}
}

// Asks for a boundary's label or a summary's text, like LinkLabelModal: Enter
// or Save keeps it, Escape cancels, and an empty text means none.
class TextPromptModal extends Modal {
	// Focus goes back where it was (the map) when the dialog closes, so keys
	// like Escape and Delete keep working without another click.
	private mmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	constructor(
		app: MindMapView["app"],
		private promptTitle: string,
		private promptHint: string,
		private initial: string,
		private onSubmit: (text: string) => void,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.promptTitle);
		const input = this.contentEl.createEl("input", {
			cls: "mm-text-input",
			attr: { type: "text", placeholder: this.promptHint, value: this.initial },
		});
		const submit = () => {
			this.onSubmit(input.value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
		save.onclick = submit;
		window.setTimeout(() => input.select(), 0);
	}

	onClose() {
		this.contentEl.empty();
		const back = this.mmReturnFocus;
		window.setTimeout(() => back?.isConnected && back.focus(), 0);
	}
}

// Export limits for embedded pictures, kept low enough for a phone's memory.
const EXPORT_IMAGE_MAX = 8 * 1024 * 1024;
const EXPORT_IMAGES_TOTAL = 32 * 1024 * 1024;

function imageMime(ext: string): string {
	const e = ext.toLowerCase();
	if (e === "jpg" || e === "jpeg") return "image/jpeg";
	if (e === "svg") return "image/svg+xml";
	return `image/${e}`;
}

// Base64 in chunks: String.fromCharCode over a whole large image overflows the
// call stack.
function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}
