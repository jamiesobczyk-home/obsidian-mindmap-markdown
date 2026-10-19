// The outline pane: the active mind map as an indented list in the sidebar.
// It holds no tree of its own. Every click, fold and rename goes through the
// map view, so each one is a single undo step there and is saved like any
// other edit; the pane redraws when the map tells it something changed.
//
// Class members here were checked against Obsidian's View and ItemView
// (app.js 1.14.4) so none of them shadows one of Obsidian's own.

import { App, ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { MindNode } from "./model";
import { OutlineRow, outlineKey, outlineRows, plainTopicText, rowIndexFor, stepCursor } from "./outline-rows";
import { MindMapView, VIEW_TYPE_MINDMAP } from "./view";

export const VIEW_TYPE_OUTLINE = "mindmap-markdown-outline";

// Opens the outline in the right sidebar (the right drawer on phones), or
// shows it if it's already open. Leaves keyboard focus where it was.
export async function openOutline(app: App) {
	const ws = app.workspace;
	let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(VIEW_TYPE_OUTLINE)[0] ?? null;
	if (!leaf) {
		leaf = ws.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_OUTLINE, active: false });
	}
	await ws.revealLeaf(leaf);
}

interface Renaming {
	node: MindNode;
	input: HTMLInputElement;
	row: HTMLElement;
}

// Everything a row draws, so rows that would come out the same are kept.
const rowSig = (r: OutlineRow, readOnly: boolean) =>
	JSON.stringify([r.depth, r.central, r.hasChildren, r.path === "", r.folded, r.hidden, !!r.node.note, readOnly, r.node.text]);

// Writes that skip unchanged values: Obsidian's toggleClass rewrites the class
// attribute even when nothing changes, which restyles the row, and the
// selection is repainted over every row on each move.
function setClass(el: Element, cls: string, on: boolean) {
	if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

function setAttr(el: Element, name: string, value: string) {
	if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export class MindMapOutlineView extends ItemView {
	// The map this pane mirrors, and how to stop listening to it.
	private mirrored: MindMapView | null = null;
	private stopMirroring: (() => void) | null = null;

	private outlineCaptionEl!: HTMLElement;
	private outlineListEl!: HTMLElement;
	private outlineEmptyEl!: HTMLElement;

	private outlineRowsNow: OutlineRow[] = [];
	private outlineRowEls: HTMLElement[] = [];
	// What each row element draws (see rowSig), parallel to outlineRowEls.
	private outlineRowSigs: string[] = [];
	// The row the arrow keys are on. It follows the map's selection.
	private outlineCursor = -1;
	private outlineDrawnKey = "";
	// The map's selection as last drawn, so the list only scrolls when it moves.
	private outlineShownSel: MindNode | null = null;
	private outlineFrame: number | null = null;
	private outlineRenaming: Renaming | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_OUTLINE;
	}

	getDisplayText() {
		return "Mind map outline";
	}

	getIcon() {
		return "list-tree";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("mm-outline");
		this.outlineCaptionEl = root.createDiv({ cls: "mm-outline-caption" });
		this.outlineListEl = root.createDiv({
			cls: "mm-outline-list",
			attr: { tabindex: "0", role: "tree", "aria-label": "Mind map outline" },
		});
		this.outlineEmptyEl = root.createDiv({ cls: "mm-outline-empty", text: "Open a mind map to see its outline" });

		this.registerDomEvent(this.outlineListEl, "click", (e) => this.onOutlineClick(e));
		this.registerDomEvent(this.outlineListEl, "dblclick", (e) => this.onOutlineDblClick(e));
		this.registerDomEvent(this.outlineListEl, "keydown", (e) => this.onOutlineKey(e));

		const ws = this.app.workspace;
		this.registerEvent(ws.on("active-leaf-change", () => this.followActiveMap()));
		// Closing a map's tab or switching it to Markdown changes the layout.
		this.registerEvent(ws.on("layout-change", () => this.followActiveMap()));
		this.followActiveMap();
	}

	async onClose() {
		this.mirrorMap(null);
		if (this.outlineFrame !== null) cancelAnimationFrame(this.outlineFrame);
		this.outlineFrame = null;
	}

	// ---- Which map to mirror ------------------------------------------------

	// The active map if there is one; otherwise keep the one already shown while
	// it's still open (clicking the outline makes the outline active), else the
	// most recently used open map.
	private followActiveMap() {
		const ws = this.app.workspace;
		const active = ws.getActiveViewOfType(MindMapView);
		if (active) return this.mirrorMap(active);
		const open = ws.getLeavesOfType(VIEW_TYPE_MINDMAP).map((l) => l.view).filter((v) => v instanceof MindMapView);
		if (this.mirrored && open.includes(this.mirrored)) return;
		const recent = ws.getMostRecentLeaf()?.view;
		this.mirrorMap(recent instanceof MindMapView ? recent : ((open[0] as MindMapView | undefined) ?? null));
	}

	private mirrorMap(view: MindMapView | null) {
		if (view === this.mirrored) return;
		this.stopMirroring?.();
		this.stopMirroring = null;
		this.endOutlineRename(false);
		this.mirrored = view;
		this.outlineCursor = -1;
		this.outlineShownSel = null;
		this.outlineDrawnKey = "";
		if (view) this.stopMirroring = view.onMapChange(() => this.scheduleOutline());
		this.scheduleOutline();
	}

	// ---- Drawing ----------------------------------------------------------

	// Several changes in one frame (an undo is a refresh and a selection
	// change) draw once.
	private scheduleOutline() {
		if (this.outlineFrame !== null) return;
		this.outlineFrame = requestAnimationFrame(() => {
			this.outlineFrame = null;
			this.drawOutline();
		});
	}

	private drawOutline() {
		// Never pull the input out from under someone typing; draw when they finish.
		if (this.outlineRenaming) return;
		const view = this.mirrored;
		const doc = view?.doc ?? null;
		this.contentEl.toggleClass("is-empty", !doc);
		if (!view || !doc) {
			this.outlineRowsNow = [];
			this.outlineRowEls = [];
			this.outlineRowSigs = [];
			this.outlineDrawnKey = "";
			this.outlineListEl.empty();
			this.outlineCaptionEl.empty();
			this.outlineListEl.hide();
			this.outlineCaptionEl.hide();
			this.outlineEmptyEl.show();
			return;
		}
		this.outlineEmptyEl.hide();
		this.outlineListEl.show();
		this.outlineCaptionEl.show();
		this.contentEl.toggleClass("is-readonly", view.readOnly);

		const rows = outlineRows(doc.root);
		// Undo and reloads rebuild the tree with new topic objects, so the rows
		// are always replaced; the DOM only when what it shows is different.
		this.outlineRowsNow = rows;
		const name = view.file?.basename ?? "";
		const key = outlineKey(rows, `${name}\n${view.readOnly ? "ro" : "rw"}`);
		if (key !== this.outlineDrawnKey) {
			this.outlineDrawnKey = key;
			this.outlineCaptionEl.empty();
			this.outlineCaptionEl.createSpan({ cls: "mm-outline-name", text: name });
			if (view.readOnly) this.outlineCaptionEl.createSpan({ cls: "mm-outline-badge", text: "Read-only" });
			this.buildRows(rows, view.readOnly);
		}
		this.paintOutlineSelection();
	}

	// Redraws only the rows that changed: the run between the rows that still
	// match at the start and at the end. An edit to one topic used to rebuild
	// every row, which on a large map cost more than the edit itself.
	private buildRows(rows: OutlineRow[], readOnly: boolean) {
		// Emptying the list collapses its height for a moment, which would clamp
		// the pane's scroll; put it back once the rows are in.
		const scroller = this.contentEl;
		const top = scroller.scrollTop;
		const sigs = rows.map((r) => rowSig(r, readOnly));
		const old = this.outlineRowSigs;
		const oldEls = this.outlineRowEls;
		let pre = 0;
		while (pre < sigs.length && pre < old.length && sigs[pre] === old[pre]) pre++;
		let suf = 0;
		while (suf < sigs.length - pre && suf < old.length - pre && sigs[sigs.length - 1 - suf] === old[old.length - 1 - suf]) suf++;
		for (let i = pre; i < old.length - suf; i++) oldEls[i].remove();
		const anchor = suf > 0 ? oldEls[old.length - suf] : null;
		const fresh = rows.slice(pre, rows.length - suf).map((r, k) => {
			const el = this.makeRow(r, pre + k, readOnly);
			this.outlineListEl.insertBefore(el, anchor);
			return el;
		});
		this.outlineRowEls = [...oldEls.slice(0, pre), ...fresh, ...oldEls.slice(old.length - suf)];
		this.outlineRowSigs = sigs;
		// Rows after an insert or removal moved; keep their numbers right.
		for (let i = pre + fresh.length; i < this.outlineRowEls.length; i++) {
			setAttr(this.outlineRowEls[i], "data-row", String(i));
		}
		scroller.scrollTop = top;
	}

	private makeRow(r: OutlineRow, i: number, readOnly: boolean): HTMLElement {
		const el = document.createElement("div");
		el.className = "mm-outline-row";
		el.setAttribute("role", "treeitem");
		el.setAttribute("aria-level", String(r.depth + 1));
		el.setAttribute("data-row", String(i));
		el.style.setProperty("--mm-outline-depth", String(r.depth));
		el.toggleClass("is-central", r.central);
		if (r.hasChildren && r.path !== "") el.setAttribute("aria-expanded", String(!r.folded));
		const fold = el.createDiv({ cls: "mm-outline-fold" });
		// The first centre is never folded in the map, so it gets no triangle.
		if (r.hasChildren && r.path !== "") {
			fold.addClass("collapse-icon");
			fold.toggleClass("is-collapsed", r.folded);
			fold.toggleClass("is-disabled", readOnly);
			setIcon(fold, "right-triangle");
			fold.setAttribute("aria-label", r.folded ? "Unfold" : "Fold");
		}
		const text = plainTopicText(r.node.text);
		el.createDiv({ cls: "mm-outline-text", text: text || "Untitled topic" }).toggleClass("is-blank", !text);
		if (r.node.note) {
			const mark = el.createDiv({ cls: "mm-outline-note", attr: { "aria-label": "Has a note" } });
			setIcon(mark, "sticky-note");
		}
		if (r.folded) el.createDiv({ cls: "mm-outline-count", text: String(r.hidden) });
		return el;
	}

	// Highlights the map's selection and keeps it in view when it moves.
	private paintOutlineSelection() {
		const view = this.mirrored;
		const doc = view?.doc;
		if (!view || !doc) return;
		const sel = view.selectedTopic();
		const at = rowIndexFor(this.outlineRowsNow, doc.root, sel);
		const moved = sel !== this.outlineShownSel;
		this.outlineShownSel = sel;
		if (moved || this.outlineCursor >= this.outlineRowEls.length) this.outlineCursor = at;
		this.outlineRowEls.forEach((el, i) => {
			setClass(el, "is-selected", i === at);
			setClass(el, "is-cursor", i === this.outlineCursor && i !== at);
			setAttr(el, "aria-selected", String(i === at));
		});
		if (moved && at >= 0) this.scrollRowIntoView(at);
	}

	// Scrolls only the pane, by as little as needed. scrollIntoView could also
	// scroll the workspace around it.
	private scrollRowIntoView(i: number) {
		const el = this.outlineRowEls[i];
		if (!el) return;
		const scroller = this.contentEl;
		const box = scroller.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const pad = 8;
		if (r.top < box.top + pad) scroller.scrollTop -= box.top + pad - r.top;
		else if (r.bottom > box.bottom - pad) scroller.scrollTop += r.bottom - (box.bottom - pad);
	}

	// ---- Acting on the map ----------------------------------------------------

	private rowFromEvent(e: Event): number {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".mm-outline-row");
		const i = el ? this.outlineRowEls.indexOf(el) : -1;
		return i;
	}

	private onOutlineClick(e: MouseEvent) {
		const i = this.rowFromEvent(e);
		if (i < 0 || this.outlineRenaming) return;
		if ((e.target as HTMLElement).closest(".mm-outline-fold.collapse-icon")) {
			this.toggleRow(i);
			return;
		}
		this.revealRow(i);
	}

	private onOutlineDblClick(e: MouseEvent) {
		const i = this.rowFromEvent(e);
		if (i < 0 || (e.target as HTMLElement).closest(".mm-outline-fold")) return;
		e.preventDefault();
		this.startOutlineRename(i);
	}

	private onOutlineKey(e: KeyboardEvent) {
		if (this.outlineRenaming || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
		const n = this.outlineRowEls.length;
		let handled = true;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			this.outlineCursor = stepCursor(this.outlineCursor, e.key === "ArrowDown" ? 1 : -1, n);
			this.paintOutlineSelection();
			this.scrollRowIntoView(this.outlineCursor);
		} else if (e.key === "Enter" && this.outlineCursor >= 0) this.revealRow(this.outlineCursor);
		else if (e.key === "F2" && this.outlineCursor >= 0) this.startOutlineRename(this.outlineCursor);
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private revealRow(i: number) {
		const row = this.outlineRowsNow[i];
		if (!row || !this.mirrored) return;
		this.outlineCursor = i;
		this.mirrored.revealNode(row.node);
		// The map calls back with the new selection; this covers a reveal of the
		// topic that was already selected.
		this.paintOutlineSelection();
		this.outlineListEl.focus();
	}

	private toggleRow(i: number) {
		const row = this.outlineRowsNow[i];
		const view = this.mirrored;
		if (!row || !view || view.readOnly || !row.hasChildren || row.path === "") return;
		this.outlineCursor = i;
		view.toggleCollapse(row.node);
	}

	// ---- Renaming in place -------------------------------------------------------

	private startOutlineRename(i: number) {
		const row = this.outlineRowsNow[i];
		const el = this.outlineRowEls[i];
		const view = this.mirrored;
		if (!row || !el || !view || view.readOnly) return;
		this.endOutlineRename(false);
		this.outlineCursor = i;
		const textEl = el.querySelector<HTMLElement>(".mm-outline-text");
		if (!textEl) return;
		textEl.hide();
		const input = el.createEl("input", { cls: "mm-outline-input", attr: { type: "text", "aria-label": "Topic text" } });
		textEl.after(input);
		input.value = row.node.text;
		this.outlineRenaming = { node: row.node, input, row: el };
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.isComposing) return;
			if (e.key === "Enter") {
				e.preventDefault();
				this.endOutlineRename(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.endOutlineRename(false);
			}
		});
		input.addEventListener("blur", () => this.endOutlineRename(true));
		input.focus();
		input.select();
	}

	private endOutlineRename(commit: boolean) {
		const r = this.outlineRenaming;
		if (!r) return;
		this.outlineRenaming = null;
		const hadFocus = r.input.ownerDocument.activeElement === r.input;
		r.input.remove();
		// The map does the rename, so it's one undo step and saved; it then calls
		// back and the list redraws. Cancelling only puts the label back.
		if (commit && this.mirrored) this.mirrored.renameTopic(r.node, r.input.value);
		this.outlineDrawnKey = "";
		// The row's text was hidden for the input; draw that row afresh.
		const at = this.outlineRowEls.indexOf(r.row);
		if (at >= 0) this.outlineRowSigs[at] = "";
		this.drawOutline();
		if (hadFocus) this.outlineListEl.focus();
	}
}
