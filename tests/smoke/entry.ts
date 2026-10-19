import { TFile } from "obsidian";
import { MindMapView } from "../../src/view";
import { MindMapOutlineView } from "../../src/outline";

const w = window as unknown as Record<string, unknown>;
// A workspace with real events, so the outline pane can follow the active map.
const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
const ws = {
	activeView: null as unknown,
	on(name: string, fn: (...a: unknown[]) => void) {
		handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		return {};
	},
	trigger(name: string, ...a: unknown[]) {
		for (const fn of handlers.get(name) ?? []) fn(...a);
	},
	openLinkText(t: string) {
		w.openedLink = t;
	},
	getActiveViewOfType(cls: new (...a: never[]) => unknown) {
		return ws.activeView instanceof cls ? ws.activeView : null;
	},
	getLeavesOfType(type: string) {
		const v = ws.activeView as { getViewType?(): string; leaf?: unknown } | null;
		return v && v.getViewType?.() === type ? [{ view: v }] : [];
	},
	getMostRecentLeaf() {
		return ws.activeView ? { view: ws.activeView } : null;
	},
};
// A tiny in-memory vault: enough for "Turn into a note" to create and find notes.
const files = new Map<string, { file: TFile; content: string }>();
w.vaultFiles = files;
w.app = {
	workspace: ws,
	vault: {
		getFiles() {
			return [...files.values()].map((f) => f.file);
		},
		getAbstractFileByPath(path: string) {
			return files.get(path)?.file ?? null;
		},
		async create(path: string, content: string) {
			if (files.has(path)) throw new Error("File already exists.");
			const file = new (TFile as unknown as new (p: string) => TFile)(path);
			files.set(path, { file, content });
			return file;
		},
	},
	metadataCache: {
		getFirstLinkpathDest(name: string) {
			for (const { file } of files.values()) if (file.basename === name) return file;
			return null;
		},
		fileToLinktext(file: TFile) {
			return file.extension === "md" ? file.basename : file.name;
		},
	},
};
const view = new MindMapView({} as never, { openAsMarkdown() {} } as never);
(view as unknown as { file: unknown }).file = new (TFile as unknown as new (p: string) => TFile)("Kitchen remodel.md");
ws.activeView = view;
w.view = view;
void view.onOpen().then(() => (view as unknown as { setData(d: string, c: boolean): void }).setData(w.initial as string, true));

// Opens the outline pane beside the map, as the sidebar would.
w.openOutline = async () => {
	const leafEl = document.getElementById("outline-leaf")!;
	leafEl.style.display = "block";
	document.getElementById("content")!.style.right = "300px";
	const outline = new MindMapOutlineView({ containerEl: leafEl } as never);
	w.outline = outline;
	await outline.onOpen();
};
// Pretends the map was closed (null) or made active again.
w.setActiveMap = (on: boolean) => {
	ws.activeView = on ? view : null;
	ws.trigger(on ? "active-leaf-change" : "layout-change", null);
};
