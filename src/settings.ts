// Plugin settings: what they are, their defaults, and how saved data is read
// back. Pure, so it is unit-tested under Node; the tab that edits them is in
// settings-tab.ts. The defaults reproduce the plugin's behaviour from before
// it had settings, so an empty data.json changes nothing.

import { LAYOUTS, Layout } from "./model";

export const SPACINGS = { compact: 0.7, normal: 1, roomy: 1.4 } as const;
export type Spacing = keyof typeof SPACINGS;

// Maximum width of a topic, in pixels, before its text wraps.
export const TOPIC_WIDTHS = { narrow: 200, normal: 320, wide: 480 } as const;
export type TopicWidth = keyof typeof TOPIC_WIDTHS;

// Where "Create new mind map" puts a map. "obsidian" follows Obsidian's own
// "Default location for new notes", which is what the command always did.
export const NEW_MAP_LOCATIONS = ["obsidian", "current", "folder"] as const;
export type NewMapLocation = (typeof NEW_MAP_LOCATIONS)[number];

// Colour themes for automatic branch colours. styles.css defines each one as
// the class themeClass(id) on the view, with light and dark values.
export const THEMES = [
	{ id: "obsidian", name: "Obsidian" },
	{ id: "pastel", name: "Pastel" },
	{ id: "vivid", name: "Vivid" },
	{ id: "earth", name: "Earth" },
	{ id: "mono", name: "Monochrome" },
	{ id: "contrast", name: "High contrast" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export interface MindMapSettings {
	defaultLayout: Layout;
	spacing: Spacing;
	animation: boolean;
	topicWidth: TopicWidth;
	newMapLocation: NewMapLocation;
	newMapFolder: string;
	theme: ThemeId;
}

// The settings that change how an open map looks. The rest only matter when a
// map is made.
export const DISPLAY_SETTINGS: readonly (keyof MindMapSettings)[] = ["spacing", "animation", "topicWidth", "theme"];

export const DEFAULT_SETTINGS: Readonly<MindMapSettings> = Object.freeze({
	defaultLayout: "balanced",
	spacing: "normal",
	animation: true,
	topicWidth: "normal",
	newMapLocation: "obsidian",
	newMapFolder: "",
	theme: "obsidian",
});

const oneOf = <T>(list: readonly T[], v: unknown, fallback: T): T =>
	(list as readonly unknown[]).includes(v) ? (v as T) : fallback;

// Reads whatever loadData() returned: nothing, an older or newer version's
// data, or garbage. Anything missing or unreadable falls back to its default.
export function loadSettings(raw: unknown): MindMapSettings {
	const d = DEFAULT_SETTINGS;
	const r: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		defaultLayout: oneOf(LAYOUTS, r.defaultLayout, d.defaultLayout),
		spacing: oneOf(Object.keys(SPACINGS) as Spacing[], r.spacing, d.spacing),
		animation: typeof r.animation === "boolean" ? r.animation : d.animation,
		topicWidth: oneOf(Object.keys(TOPIC_WIDTHS) as TopicWidth[], r.topicWidth, d.topicWidth),
		newMapLocation: oneOf(NEW_MAP_LOCATIONS, r.newMapLocation, d.newMapLocation),
		newMapFolder: typeof r.newMapFolder === "string" ? r.newMapFolder.trim() : d.newMapFolder,
		theme: oneOf(
			THEMES.map((t) => t.id),
			r.theme,
			d.theme,
		),
	};
}

// What to save: the settings over whatever was saved before, so a key written
// by a newer version on another device survives a save from this one.
export function settingsData(settings: MindMapSettings, previous: unknown): Record<string, unknown> {
	const prev = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
	return { ...prev, ...settings };
}

// The settings of a plugin, or the defaults when there are none yet (a view
// made before the plugin loaded them, or the smoke test's stand-in plugin).
export function settingsOf(plugin: unknown): MindMapSettings {
	const s = (plugin as { settings?: MindMapSettings } | null | undefined)?.settings;
	return s ?? DEFAULT_SETTINGS;
}

export const spacingValue = (s: Spacing): number => SPACINGS[s] ?? 1;
export const topicWidthPx = (w: TopicWidth): number => TOPIC_WIDTHS[w] ?? TOPIC_WIDTHS.normal;
// The class that selects a theme in styles.css; none for Obsidian's colours.
export const themeClass = (id: ThemeId): string | null => (id === "obsidian" ? null : `mm-theme-${id}`);

// The folder a new map goes in, as a vault path ("" or "/" is the root).
export function newMapFolderPath(
	settings: MindMapSettings,
	where: { current: string | null; obsidianDefault: string },
): string {
	if (settings.newMapLocation === "current" && where.current !== null) return where.current;
	if (settings.newMapLocation === "folder") return settings.newMapFolder.replace(/^\/+|\/+$/g, "");
	return where.obsidianDefault;
}

// A new map's text with the default layout saved in its settings comment.
// Balanced is what a map without one shows, so it adds nothing; nor does it
// touch a note that already has a settings comment.
export function withDefaultLayout(markdown: string, layout: Layout): string {
	if (layout === "balanced" || markdown.includes("%% mindmap-settings")) return markdown;
	const body = markdown.replace(/\s*$/, "");
	return `${body}\n\n%% mindmap-settings\n${JSON.stringify({ layout })}\n%%\n`;
}
