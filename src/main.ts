import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";
import { ExportStyle, toMarkdownOutline, toOPML, toSVG } from "./export";
import { FRONTMATTER_KEY, newMapTemplate } from "./model";
import { headingsToMap } from "./notes";
import { DISPLAY_SETTINGS, MindMapSettings, loadSettings, newMapFolderPath, settingsData, withDefaultLayout } from "./settings";
import { MindMapSettingTab } from "./settings-tab";
import { MindMapOutlineView, VIEW_TYPE_OUTLINE, openOutline } from "./outline";
import { MindMapView, VIEW_TYPE_MINDMAP } from "./view";

type ViewState = Parameters<WorkspaceLeaf["setViewState"]>[0];

export default class MindMapPlugin extends Plugin {
	// Leaves where the user chose "Open as Markdown", with the file they chose
	// it for. Opening a different file in that leaf goes back to the map.
	private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
	// Saved in data.json (src/settings.ts). Loaded before any view is made.
	settings: MindMapSettings = loadSettings(null);
	// data.json as last read or written, so keys from a newer version survive.
	private settingsExtra: unknown = null;

	async onload() {
		this.settingsExtra = await this.loadData();
		this.settings = loadSettings(this.settingsExtra);
		this.addSettingTab(new MindMapSettingTab(this.app, this));

		this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new MindMapView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE_MINDMAP, { display: "Mind map", defaultMod: true });
		// Outline pane (src/outline.ts).
		this.registerView(VIEW_TYPE_OUTLINE, (leaf) => new MindMapOutlineView(leaf));
		this.addCommand({
			id: "show-outline",
			name: "Show mind map outline",
			callback: () => void openOutline(this.app),
		});
		this.patchSetViewState();

		this.addRibbonIcon("git-fork", "New mind map", () => this.createMap());

		this.addCommand({
			id: "create",
			name: "Create new mind map",
			callback: () => this.createMap(),
		});

		this.addCommand({
			id: "toggle-view",
			name: "Switch between mind map and Markdown",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				if (view instanceof MindMapView) {
					if (!checking) this.openAsMarkdown(leaf!);
					return true;
				}
				if (view instanceof MarkdownView && view.file && this.isMapFile(view.file)) {
					if (!checking) void this.openAsMap(leaf!, view.file);
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "convert",
			name: "Turn this note into a mind map",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || this.isMapFile(view.file)) return false;
				if (!checking) void this.convert(view.leaf, view.file);
				return true;
			},
		});

		this.addCommand({
			id: "from-headings",
			name: "Make a mind map from this note's headings",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || this.isMapFile(view.file)) return false;
				if (!checking) void this.mapFromHeadings(view.file);
				return true;
			},
		});

		this.addCommand({
			id: "fit",
			name: "Fit map to window",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (view && !checking) view.fit();
				return !!view;
			},
		});

		this.addCommand({
			id: "toggle-layout",
			name: "Switch between balanced and right-facing layout",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MindMapView);
				if (view && !checking) view.toggleLayout();
				return !!view;
			},
		});

		const exportCommand = (id: string, name: string, run: (view: MindMapView) => Promise<void>) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const view = this.app.workspace.getActiveViewOfType(MindMapView);
					if (!view?.doc) return false;
					if (!checking) {
						run(view).catch((err) =>
							new Notice(`Export failed: ${err instanceof Error ? err.message : String(err)}`),
						);
					}
					return true;
				},
			});
		exportCommand("export-svg", "Export map as SVG", async (view) => {
			const svg = await this.renderSVG(view);
			if (svg) await this.writeExport(view, "svg", svg);
		});
		exportCommand("export-png", "Export map as PNG", async (view) => {
			const svg = await this.renderSVG(view);
			if (svg) await this.writeExport(view, "png", await svgToPng(svg, 2));
		});
		exportCommand("export-opml", "Export map as OPML", (view) => this.writeExport(view, "opml", toOPML(view.doc!)));
		exportCommand("copy-outline", "Copy map as Markdown outline", async (view) => {
			await navigator.clipboard.writeText(toMarkdownOutline(view.doc!));
			new Notice("Copied outline");
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isMapFile(file)) {
					if (leaf?.view instanceof MarkdownView) {
						menu.addItem((i) =>
							i.setTitle("Open as mind map").setIcon("git-fork").onClick(() => this.openAsMap(leaf, file)),
						);
					}
				} else if (leaf?.view instanceof MarkdownView) {
					menu.addItem((i) =>
						i.setTitle("Turn into mind map").setIcon("git-fork").onClick(() => this.convert(leaf, file)),
					);
					menu.addItem((i) =>
						i
							.setTitle("Make a mind map from headings")
							.setIcon("list-tree")
							.onClick(() => this.mapFromHeadings(file)),
					);
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder)) return;
				menu.addItem((i) =>
					i.setTitle("New mind map").setIcon("git-fork").onClick(() => this.createMap(file)),
				);
			}),
		);

		// At startup the metadata cache may not be ready when leaves are
		// restored, so map files can come back as plain Markdown. Fix them once
		// the layout is ready.
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file && this.isMapFile(view.file)) {
					void this.openAsMap(leaf, view.file, false);
				}
			});
		});
	}

	// Saves a settings change and applies it to every open map at once.
	async updateSettings(change: Partial<MindMapSettings>) {
		this.settings = loadSettings({ ...this.settings, ...change });
		const data = settingsData(this.settings, this.settingsExtra);
		this.settingsExtra = data;
		// Only the settings that change how a map looks re-lay out open maps.
		if (DISPLAY_SETTINGS.some((k) => k in change)) this.applyToOpenMaps();
		await this.saveData(data);
	}

	// Obsidian calls this when data.json changes on disk, for instance when
	// obsidian-git pulls settings saved on another device. Without it the next
	// change here would write this device's older values back over them.
	async onExternalSettingsChange() {
		this.settingsExtra = await this.loadData();
		this.settings = loadSettings(this.settingsExtra);
		this.applyToOpenMaps();
	}

	private applyToOpenMaps() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP)) {
			if (leaf.view instanceof MindMapView) leaf.view.applyMapSettings();
		}
	}

	isMapFile(file: TFile): boolean {
		if (file.extension !== "md") return false;
		const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!fm && fm[FRONTMATTER_KEY] !== undefined && fm[FRONTMATTER_KEY] !== false;
	}

	// Route Markdown opens of map files to the map view, the pattern the Kanban
	// and Excalidraw plugins use. On unload the original goes back only if no
	// other plugin has wrapped it since; otherwise this wrapper stays in their
	// chain and just passes calls through, so their patch isn't dropped.
	private patchSetViewState() {
		const proto = WorkspaceLeaf.prototype as unknown as {
			setViewState: (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;
		};
		const original = proto.setViewState;
		const route = (leaf: WorkspaceLeaf, state: ViewState): ViewState => {
			try {
				const path = (state?.state as { file?: string } | undefined)?.file;
				if (state?.type === "markdown" && typeof path === "string") {
					if (this.markdownLeaves.get(leaf) !== path) {
						this.markdownLeaves.delete(leaf);
						const file = this.app.vault.getAbstractFileByPath(path);
						if (file instanceof TFile && this.isMapFile(file)) return { ...state, type: VIEW_TYPE_MINDMAP };
					}
				}
			} catch (err) {
				// Never let a bug here stop a note from opening.
				console.error("Keyboard Mind Map: falling back to Markdown", err);
			}
			return state;
		};
		let live = true;
		const patched = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
			return original.call(this, live ? route(this, state) : state, eState);
		};
		proto.setViewState = patched;
		this.register(() => {
			live = false;
			if (proto.setViewState === patched) proto.setViewState = original;
		});
	}

	openAsMarkdown(leaf: WorkspaceLeaf) {
		const view = leaf.view;
		if (!(view instanceof MindMapView) || !view.file) return;
		this.markdownLeaves.set(leaf, view.file.path);
		void leaf.setViewState({ type: "markdown", state: { file: view.file.path }, active: true });
	}

	async openAsMap(leaf: WorkspaceLeaf, file: TFile, active = true) {
		this.markdownLeaves.delete(leaf);
		await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, state: { file: file.path }, active });
	}

	private async convert(leaf: WorkspaceLeaf, file: TFile) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[FRONTMATTER_KEY] = "basic";
		});
		const layout = this.settings.defaultLayout;
		if (layout !== "balanced") await this.app.vault.process(file, (text) => withDefaultLayout(text, layout));
		await this.openAsMap(leaf, file);
	}

	// A new map beside the note, with a topic per heading linking back to it.
	// The note itself is left alone.
	private async mapFromHeadings(file: TFile) {
		const folder = file.parent?.path ?? "";
		let path = normalizePath(`${folder}/${file.basename} map.md`);
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
			path = normalizePath(`${folder}/${file.basename} map ${n}.md`);
		}
		const content = await this.app.vault.cachedRead(file);
		const made = headingsToMap(content, file.basename, this.app.metadataCache.fileToLinktext(file, path));
		const map = made && withDefaultLayout(made, this.settings.defaultLayout);
		if (!map) {
			new Notice("This note has no headings to make a map from.");
			return;
		}
		try {
			const created = await this.app.vault.create(path, map);
			await this.openAsMap(this.app.workspace.getLeaf("tab"), created);
		} catch (err) {
			new Notice(`Couldn't create the mind map: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async createMap(folder?: TFolder) {
		const active = this.app.workspace.getActiveFile();
		const dir = folder
			? folder.path
			: newMapFolderPath(this.settings, {
					current: active?.parent?.path ?? null,
					obsidianDefault: this.app.fileManager.getNewFileParent(active?.path ?? "").path,
				});
		let name = "Untitled mind map";
		let path = normalizePath(`${dir}/${name}.md`);
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) {
			name = `Untitled mind map ${n}`;
			path = normalizePath(`${dir}/${name}.md`);
		}
		try {
			const target = normalizePath(dir);
			if (target !== "/" && !this.app.vault.getAbstractFileByPath(target)) await this.app.vault.createFolder(target);
			const template = withDefaultLayout(newMapTemplate("Central topic"), this.settings.defaultLayout);
			const file = await this.app.vault.create(path, template);
			const leaf = this.app.workspace.getLeaf(false);
			// The metadata cache hasn't seen the new file yet, so open the map
			// view directly rather than relying on the frontmatter check.
			await this.openAsMap(leaf, file);
		} catch (err) {
			new Notice(`Couldn't create the mind map: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async renderSVG(view: MindMapView): Promise<string | null> {
		const snap = view.exportSnapshot();
		if (!snap) {
			new Notice("The map isn't drawn yet, so there's nothing to export.");
			return null;
		}
		const style: ExportStyle = { ...snap.style, measure: measureText, images: await view.exportImages() };
		return toSVG(snap.doc, snap.boxes, style);
	}

	// Writes next to the note, numbering the name rather than overwriting.
	private async writeExport(view: MindMapView, ext: string, data: string | ArrayBuffer) {
		const file = view.file;
		if (!file) throw new Error("the map has no file");
		const dir = file.parent?.path ?? "";
		const pathFor = (n: number) =>
			normalizePath(`${dir}/${file.basename}${n === 0 ? "" : ` ${n}`}.${ext}`);
		let n = 0;
		while (this.app.vault.getAbstractFileByPath(pathFor(n))) n++;
		const path = pathFor(n);
		if (typeof data === "string") await this.app.vault.create(path, data);
		else await this.app.vault.createBinary(path, data);
		new Notice(`Exported ${path}`);
	}
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, font: string): number {
	measureCtx ??= document.createElement("canvas").getContext("2d");
	if (!measureCtx) return text.length * 9;
	measureCtx.font = font;
	return measureCtx.measureText(text).width;
}

// Rasterise through the browser's own SVG renderer, at scale for sharp text.
async function svgToPng(svg: string, scale: number): Promise<ArrayBuffer> {
	const img = new Image();
	const loaded = new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("couldn't render the SVG"));
	});
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await loaded;
	const canvas = document.createElement("canvas");
	canvas.width = Math.ceil(img.naturalWidth * scale);
	canvas.height = Math.ceil(img.naturalHeight * scale);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no canvas available");
	ctx.scale(scale, scale);
	ctx.drawImage(img, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("couldn't encode the PNG");
	return blob.arrayBuffer();
}
