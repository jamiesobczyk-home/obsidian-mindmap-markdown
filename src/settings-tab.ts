// The plugin's tab in Settings → Community plugins. Every change is saved to
// data.json at once and applied to every open map.

import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFolder, debounce } from "obsidian";
import type MindMapPlugin from "./main";
import { Layout } from "./model";
import { MindMapSettings, NewMapLocation, Spacing, THEMES, ThemeId, TopicWidth, themeClass } from "./settings";

const LAYOUT_NAMES: Record<Layout, string> = {
	balanced: "Balanced",
	right: "Right-facing",
	down: "Org chart (top-down)",
	outline: "Outline",
};

export class MindMapSettingTab extends PluginSettingTab {
	plugin: MindMapPlugin;
	// Saves a folder path still waiting on the typing pause. Name checked
	// against Obsidian's PluginSettingTab.
	private flushFolder: (() => void) | null = null;

	constructor(app: App, plugin: MindMapPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.flushFolder?.();
		this.flushFolder = null;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = (change: Partial<MindMapSettings>) => this.plugin.updateSettings(change);

		new Setting(containerEl)
			.setName("Default layout for new maps")
			.setDesc("Used by Create new mind map, Turn into a mind map and Make a mind map from headings. Existing maps keep theirs.")
			.addDropdown((d) =>
				d
					.addOptions(LAYOUT_NAMES)
					.setValue(s.defaultLayout)
					.onChange((v) => save({ defaultLayout: v as Layout })),
			)
			.settingEl.addClass("mm-setting-layout");

		new Setting(containerEl)
			.setName("Spacing")
			.setDesc("How much room there is between topics, in every map and in SVG and PNG exports.")
			.addDropdown((d) =>
				d
					.addOptions({ compact: "Compact", normal: "Normal", roomy: "Roomy" })
					.setValue(s.spacing)
					.onChange((v) => save({ spacing: v as Spacing })),
			)
			.settingEl.addClass("mm-setting-spacing");

		new Setting(containerEl)
			.setName("Topic width")
			.setDesc("How wide a topic grows before its text wraps onto another line.")
			.addDropdown((d) =>
				d
					.addOptions({ narrow: "Narrow (200 px)", normal: "Normal (320 px)", wide: "Wide (480 px)" })
					.setValue(s.topicWidth)
					.onChange((v) => save({ topicWidth: v as TopicWidth })),
			)
			.settingEl.addClass("mm-setting-width");

		new Setting(containerEl)
			.setName("Animation")
			.setDesc("Topics glide to their new places after a change. Always off when your system asks for reduced motion.")
			.addToggle((t) => t.setValue(s.animation).onChange((v) => save({ animation: v })))
			.settingEl.addClass("mm-setting-animation");

		// The colour theme, with a row of its eight branch colours.
		const theme = new Setting(containerEl)
			.setName("Colour theme")
			.setDesc("Colours for branches you haven't coloured yourself. Colours you pick for a branch always stay.");
		theme.settingEl.addClass("mm-setting-theme");
		const swatches = theme.descEl.createDiv({ cls: "mm-swatches" });
		for (let i = 0; i < 8; i++) swatches.createSpan({ cls: ["mm-swatch", `mm-c${i}`] });
		const showSwatches = (id: ThemeId) => {
			for (const t of THEMES) {
				const cls = themeClass(t.id);
				if (cls) swatches.toggleClass(cls, t.id === id);
			}
		};
		showSwatches(s.theme);
		theme.addDropdown((d) => {
			for (const t of THEMES) d.addOption(t.id, t.name);
			d.setValue(s.theme).onChange((v) => {
				showSwatches(v as ThemeId);
				void save({ theme: v as ThemeId });
			});
		});

		const folder = new Setting(containerEl)
			.setName("Folder for new maps")
			.setDesc("The vault folder new maps go in. It is made if it doesn't exist yet.");
		folder.settingEl.addClass("mm-setting-folder");
		folder.addText((t) => {
			// Typing a path saves once the typing stops, not on every key.
			const saveFolder = debounce((v: string) => void save({ newMapFolder: v }), 400, true);
			this.flushFolder = () => saveFolder.run();
			t.setPlaceholder("Example: Mind maps")
				.setValue(s.newMapFolder)
				.onChange((v) => saveFolder(v.trim()));
			new FolderSuggest(this.app, t.inputEl, (path) => {
				saveFolder.cancel();
				t.setValue(path);
				void save({ newMapFolder: path });
			});
		});
		folder.settingEl.toggle(s.newMapLocation === "folder");

		new Setting(containerEl)
			.setName("New maps go in")
			.setDesc("Where Create new mind map puts a map. A map made from headings always goes beside its note.")
			.addDropdown((d) =>
				d
					.addOptions({
						obsidian: "Obsidian's default location for new notes",
						current: "Same folder as the current note",
						folder: "A folder you choose",
					})
					.setValue(s.newMapLocation)
					.onChange((v) => {
						folder.settingEl.toggle(v === "folder");
						void save({ newMapLocation: v as NewMapLocation });
					}),
			)
			.settingEl.addClass("mm-setting-location");
		// The folder field belongs under the choice that shows it.
		containerEl.appendChild(folder.settingEl);
	}
}

// Suggests the vault's folders as the folder field is typed in.
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private onPickFolder: (path: string) => void,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.onPickFolder(folder.path);
		this.close();
	}
}
