import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYOUTS, newMapTemplate, parse, serialize } from "../src/model";
import { headingsToMap } from "../src/notes";
import {
	DEFAULT_SETTINGS,
	THEMES,
	loadSettings,
	newMapFolderPath,
	settingsData,
	settingsOf,
	spacingValue,
	themeClass,
	topicWidthPx,
	withDefaultLayout,
} from "../src/settings";

test("defaults reproduce the behaviour from before settings", () => {
	assert.deepEqual(
		{ ...DEFAULT_SETTINGS },
		{
			defaultLayout: "balanced",
			spacing: "normal",
			animation: true,
			topicWidth: "normal",
			newMapLocation: "obsidian",
			newMapFolder: "",
			theme: "obsidian",
		},
	);
	assert.equal(spacingValue(DEFAULT_SETTINGS.spacing), 1);
	assert.equal(topicWidthPx(DEFAULT_SETTINGS.topicWidth), 320);
	assert.equal(themeClass(DEFAULT_SETTINGS.theme), null);
	assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});

test("missing or garbage data loads as the defaults", () => {
	for (const raw of [undefined, null, "", "text", 42, true, [], ["right"], {}]) {
		assert.deepEqual(loadSettings(raw), { ...DEFAULT_SETTINGS }, JSON.stringify(raw));
	}
});

test("each bad field falls back on its own; good fields are kept", () => {
	const s = loadSettings({
		defaultLayout: "sideways",
		spacing: "roomy",
		animation: "no",
		topicWidth: 480,
		newMapLocation: "folder",
		newMapFolder: "  Maps/Work  ",
		theme: "neon",
	});
	assert.deepEqual(s, {
		...DEFAULT_SETTINGS,
		spacing: "roomy",
		newMapLocation: "folder",
		newMapFolder: "Maps/Work",
	});
	assert.equal(loadSettings({ newMapFolder: 7 }).newMapFolder, "");
	assert.equal(loadSettings({ animation: false }).animation, false);
});

test("a full set of valid data round-trips", () => {
	const all = {
		defaultLayout: "down",
		spacing: "compact",
		animation: false,
		topicWidth: "wide",
		newMapLocation: "current",
		newMapFolder: "Maps",
		theme: "contrast",
	};
	assert.deepEqual(loadSettings(all), all);
	assert.deepEqual(loadSettings(JSON.parse(JSON.stringify(settingsData(loadSettings(all), null)))), all);
	for (const layout of LAYOUTS) assert.equal(loadSettings({ defaultLayout: layout }).defaultLayout, layout);
	for (const t of THEMES) assert.equal(loadSettings({ theme: t.id }).theme, t.id);
});

test("saving keeps keys this version doesn't know, and ignores garbage", () => {
	const s = loadSettings({ spacing: "roomy", futureThing: { a: 1 } });
	assert.deepEqual(settingsData(s, { spacing: "roomy", futureThing: { a: 1 } }), { ...s, futureThing: { a: 1 } });
	assert.deepEqual(settingsData(s, "garbage"), { ...s });
	assert.deepEqual(settingsData(s, [1, 2]), { ...s });
	// The current value wins over the old one.
	assert.equal(settingsData({ ...s, spacing: "compact" }, { spacing: "roomy" }).spacing, "compact");
});

test("settingsOf falls back to the defaults for a plugin without settings", () => {
	assert.equal(settingsOf(undefined), DEFAULT_SETTINGS);
	assert.equal(settingsOf({}), DEFAULT_SETTINGS);
	const s = loadSettings({ theme: "earth" });
	assert.equal(settingsOf({ settings: s }), s);
});

test("value mappings", () => {
	assert.deepEqual(
		(["compact", "normal", "roomy"] as const).map(spacingValue),
		[0.7, 1, 1.4],
	);
	assert.deepEqual(
		(["narrow", "normal", "wide"] as const).map(topicWidthPx),
		[200, 320, 480],
	);
	assert.deepEqual(
		THEMES.map((t) => themeClass(t.id)),
		[null, "mm-theme-pastel", "mm-theme-vivid", "mm-theme-earth", "mm-theme-mono", "mm-theme-contrast"],
	);
	// Every theme class is a single token, safe for classList.add.
	for (const t of THEMES) assert.doesNotMatch(themeClass(t.id) ?? "", /\s/);
});

test("new map folder for each location", () => {
	const where = { current: "Projects/Kitchen", obsidianDefault: "Inbox" };
	const s = (o: object) => loadSettings(o);
	assert.equal(newMapFolderPath(s({}), where), "Inbox");
	assert.equal(newMapFolderPath(s({ newMapLocation: "current" }), where), "Projects/Kitchen");
	// No note open: there is no current folder, so Obsidian's default it is.
	assert.equal(newMapFolderPath(s({ newMapLocation: "current" }), { ...where, current: null }), "Inbox");
	assert.equal(newMapFolderPath(s({ newMapLocation: "folder", newMapFolder: "/Maps/" }), where), "Maps");
	assert.equal(newMapFolderPath(s({ newMapLocation: "folder", newMapFolder: "" }), where), "");
});

test("default layout: balanced adds nothing, others save a settings comment the map reads back unchanged", () => {
	const tpl = newMapTemplate("Central topic");
	assert.equal(withDefaultLayout(tpl, "balanced"), tpl);
	for (const layout of LAYOUTS) {
		const md = withDefaultLayout(tpl, layout);
		const doc = parse(md);
		assert.equal(doc.settings.layout, layout);
		assert.deepEqual(doc.unsupported, []);
		// Opening it never rewrites the note: it is already in saved form.
		assert.equal(serialize(doc), md, layout);
	}
});

test("default layout on a map made from headings", () => {
	const map = headingsToMap("# Plan\n## One\n## Two\n", "Plan", "Plan")!;
	const md = withDefaultLayout(map, "outline");
	assert.equal(parse(md).settings.layout, "outline");
	assert.equal(serialize(parse(md)), md);
});

test("default layout never touches a note that already has a settings comment", () => {
	const md = '# R\n\n- a\n\n%% mindmap-settings\n{"collapsed":["0"]}\n%%\n';
	assert.equal(withDefaultLayout(md, "right"), md);
});

test("default layout on a converted note keeps its text", () => {
	const note = "---\nmindmap-plugin: basic\n---\n\n# Ideas\n\n- one\n- two\n\n\n";
	const md = withDefaultLayout(note, "down");
	assert.ok(md.startsWith("---\nmindmap-plugin: basic\n---\n\n# Ideas\n\n- one\n- two\n"));
	assert.equal(parse(md).settings.layout, "down");
	assert.equal(parse(md).root.children.length, 2);
});
