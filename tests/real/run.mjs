// End-to-end test in the real Obsidian app, not the stand-in. The stand-in
// (tests/smoke) is fast but only imitates Obsidian, and three real bugs got
// past it: a field that shadowed TextFileView's own (nothing saved), a class
// string Obsidian's createSvg rejects (onOpen aborted, so nothing could be
// edited), and a context-menu listener on the wrong element. This drives the
// actual app, so those can't hide.
//
//   npm run real
//
// Linux only (it runs Obsidian's Linux build, under xvfb-run when there is no
// display). It downloads a pinned Obsidian once into OBSIDIAN_CACHE (default:
// <tmp>/obsidian-real-test), builds a throwaway vault holding just this plugin
// and one map, and uses its own Obsidian settings folder, so it never touches
// a real vault or a real Obsidian profile.
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { launchObsidian, plugin } from "./obsidian.mjs";
import { generateMap } from "../perf/genmap.mjs";

if (process.platform !== "linux") {
	console.log(`skipped - the real-Obsidian test runs on Linux only (this is ${process.platform})`);
	process.exit(0);
}

const MAP = "---\nmindmap-plugin: basic\n---\n\n# Central topic\n\n- First idea\n- Second idea\n";

// A solid-colour PNG with an orange square in it, written by hand so the test
// needs no image library.
function png(w, h) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const inner = x > w / 5 && x < (w * 4) / 5 && y > h / 5 && y < (h * 4) / 5;
			raw.set(inner ? [245, 166, 35] : [74, 144, 217], y * (w * 3 + 1) + 1 + x * 3);
		}
	}
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// --- Launch -------------------------------------------------------------------
// A picture for the image steps: 400 x 300, bigger than a topic may show it.
const { browser, page, stop } = await launchObsidian({
	files: { "Map.md": MAP, "Attachments/plan.png": png(400, 300) },
});
if (!browser) {
	console.log("not ok - Obsidian started");
	process.exit(1);
}

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const key = async (k) => {
	await page.keyboard.press(k);
	await wait(120);
};
// Obsidian saves 2 s after the last change, so file checks wait past that.
const settled = () => wait(2600);
const file = (p = "Map.md") => ev((p) => app.vault.adapter.read(p), p);
const node = (t) => page.locator(".workspace-leaf.mod-active .mm-node", { hasText: t }).first();
const menuItem = (t) => page.locator(".menu .menu-item", { hasText: t }).first();
const expect = (ok, msg) => {
	if (!ok) throw new Error(msg);
};
let failures = 0;
const step = async (name, fn) => {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (e) {
		failures++;
		console.log(`not ok - ${name}\n  ${String(e.message ?? e).split("\n").slice(0, 8).join("\n  ")}`);
		await page.keyboard.press("Escape").catch(() => {});
	}
};

// A fresh profile starts in restricted mode; the user's vaults have community
// plugins on, so turn them on here too.
await step("the plugin loads", async () => {
	if (!(await ev(() => app.plugins.isEnabled()))) {
		await ev(() => app.plugins.setEnable(true));
		await wait(3000);
	}
	expect(await ev(() => !!app.plugins.plugins["mindmap-markdown"]), "plugin not loaded");
	// Turning plugins on in a fresh profile can leave a dialog over the
	// workspace; close it so clicks reach the map.
	for (let i = 0; i < 3 && (await page.locator(".modal-container").count()) > 0; i++) {
		await page.keyboard.press("Escape");
		await wait(300);
	}
	expect((await page.locator(".modal-container").count()) === 0, "a dialog is still open");
});

await step("a map note opens in the map view without errors", async () => {
	await ev(() => app.workspace.openLinkText("Map", "", false));
	await wait(2000);
	expect((await ev(() => app.workspace.getMostRecentLeaf().view.getViewType())) === "mindmap-markdown", "not the map view");
	expect((await page.locator(".workspace-leaf.mod-active .mm-node").count()) === 3, "topics missing");
	expect(errors.length === 0, errors.join("\n"));
});

await step("opening a map leaves the file byte-for-byte unchanged", async () => {
	await settled();
	expect((await file()) === MAP, await file());
});

await step("click selects, Tab adds a child, typing and Enter save it", async () => {
	await node("First idea").click();
	await key("Tab");
	await page.keyboard.type("Typed here");
	await key("Enter");
	await settled();
	expect((await file()).includes("- First idea\n\t- Typed here"), await file());
});

await step("double-click edits a topic", async () => {
	await node("Second idea").dblclick();
	await wait(200);
	await key("End");
	await page.keyboard.type(" (edited)");
	await key("Enter");
	await settled();
	expect((await file()).includes("- Second idea (edited)"), await file());
});

await step("Enter adds a sibling and Ctrl+Z undoes it", async () => {
	await node("Second idea").click();
	await key("Enter");
	await page.keyboard.type("Third idea");
	await key("Enter");
	await settled();
	expect((await file()).includes("- Third idea"), await file());
	await key("Control+z");
	await settled();
	expect(!(await file()).includes("Third idea"), await file());
});

await step("right-click opens Obsidian's menu and a branch colour saves", async () => {
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Green branch").click();
	await settled();
	expect(/"colors":\{"0":"green"\}/.test(await file()), await file());
});

await step("Alt+L then a click draws and saves a relationship line", async () => {
	await node("Second idea").click();
	await key("Alt+KeyL");
	await node("First idea").click();
	await settled();
	expect(/"links":\[\{"from":"1","to":"0"\}\]/.test(await file()), await file());
	expect((await page.locator(".workspace-leaf.mod-active .mm-link").count()) === 1, "no line drawn");
});

await step("right-click on empty background offers a new central topic", async () => {
	const vp = await page.locator(".workspace-leaf.mod-active .mm-viewport").boundingBox();
	await page.mouse.click(vp.x + 30, vp.y + vp.height - 30, { button: "right" });
	await wait(300);
	await menuItem("New central topic").click();
	await wait(400);
	await page.keyboard.type("Garden");
	await key("Enter");
	await settled();
	expect(/\n# Garden\n/.test(await file()), await file());
});

await step("the toolbar actions button opens the topic menu (the phone path)", async () => {
	await node("Garden").click();
	await page.locator(".workspace-leaf.mod-active .mm-toolbar button[aria-label^='Actions']").click();
	await wait(300);
	expect(await menuItem("Add child topic").isVisible(), "menu not shown");
	await key("Escape");
});

await step("Turn into a note creates the note and links the topic", async () => {
	await node("Garden").click({ button: "right" });
	await wait(300);
	await menuItem("Turn into a note").click();
	await settled();
	expect(await ev(() => app.vault.adapter.exists("Garden.md")), "note not created");
	expect(/# \[\[Garden\]\]/.test(await file()), await file());
});

await step("the outline pane opens and mirrors the map", async () => {
	await ev(() => app.commands.executeCommandById("mindmap-markdown:show-outline"));
	await wait(800);
	expect((await page.locator(".mm-outline-row").count()) >= 5, "outline rows missing");
});

await step("switching to Markdown and back works", async () => {
	await ev(() => app.workspace.setActiveLeaf(app.workspace.getLeavesOfType("mindmap-markdown")[0], { focus: true }));
	await ev(() => app.commands.executeCommandById("mindmap-markdown:toggle-view"));
	await wait(800);
	const a = await ev(() => app.workspace.getMostRecentLeaf().view.getViewType());
	await ev(() => app.commands.executeCommandById("mindmap-markdown:toggle-view"));
	await wait(800);
	const b = await ev(() => app.workspace.getMostRecentLeaf().view.getViewType());
	expect(a === "markdown" && b === "mindmap-markdown", `${a} then ${b}`);
});

await step("a map can be made from a note's headings", async () => {
	await ev(async () => {
		await app.vault.create("Plan.md", "# Plan\n## Step one\n## Step two\n");
	});
	await ev(() => app.workspace.openLinkText("Plan", "", false));
	await wait(1000);
	await ev(() => app.commands.executeCommandById("mindmap-markdown:from-headings"));
	await wait(2000);
	expect((await file("Plan map.md")).includes("[[Plan#Step one|Step one]]"), await file("Plan map.md"));
});

// ---- Boundaries and summaries ------------------------------------------------
const active = (sel) => page.locator(`.workspace-leaf.mod-active ${sel}`);
// Obsidian's real Modal: a .modal-container holding the plugin's input.
const answerModal = async (text) => {
	const input = page.locator(".modal-container input.mm-text-input");
	await input.waitFor({ timeout: 3000 });
	await input.fill(text);
	await input.press("Enter");
	await wait(300);
	expect((await page.locator(".modal-container").count()) === 0, "the dialog stayed open");
};

await step("a boundary added from the real menu is drawn and saved, and its label set in the real modal", async () => {
	await ev(() => app.workspace.openLinkText("Map", "", false));
	await wait(1500);
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Add boundary").click();
	await settled();
	expect(/"boundaries":\{"0":""\}/.test(await file()), await file());
	expect((await active(".mm-boundary").count()) === 1, "no boundary drawn");
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Edit boundary label").click();
	await answerModal("Ideas");
	await settled();
	expect(/"boundaries":\{"0":"Ideas"\}/.test(await file()), await file());
	expect((await active(".mm-boundary-label").textContent()) === "Ideas", "label not drawn");
});

await step("a summary over two shift-clicked siblings: real menu and modal, click selects, Delete removes, undo restores", async () => {
	await node("First idea").click();
	await node("Second idea").click({ modifiers: ["Shift"] });
	await node("Second idea").click({ button: "right" });
	await wait(300);
	await menuItem("Add summary").click();
	await answerModal("Both ideas");
	await settled();
	expect(/"summaries":\[\{"from":"0","to":"1","text":"Both ideas"\}\]/.test(await file()), await file());
	expect((await active(".mm-summary").count()) === 1, "no brace drawn");
	await key("Escape");
	await active(".mm-summary-label").click();
	await wait(200);
	expect((await active(".mm-summary.is-selected").count()) === 1, "clicking the label didn't select it");
	await key("Delete");
	await settled();
	expect(!/summaries/.test(await file()), await file());
	await key("Control+z");
	await settled();
	expect(/"summaries":\[\{"from":"0","to":"1","text":"Both ideas"\}\]/.test(await file()), await file());
	await active(".mm-summary-label").click({ button: "right" });
	await wait(300);
	await menuItem("Edit summary").click();
	await answerModal("Two ideas");
	await settled();
	expect(/"text":"Two ideas"/.test(await file()), await file());
});

// ---- Notes and images on topics -------------------------------------------

const shots = join(plugin, ".test-build", "real");
mkdirSync(shots, { recursive: true });
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const popover = () => page.locator(".workspace-leaf.mod-active .mm-note-popover");
// Pairs of topics in the active map whose boxes overlap (a pixel of slack).
const overlaps = () =>
	ev(() => {
		const els = [...document.querySelectorAll(".workspace-leaf.mod-active .mm-node")];
		const r = els.map((e) => [e.textContent, e.getBoundingClientRect()]);
		const out = [];
		for (let i = 0; i < r.length; i++)
			for (let j = i + 1; j < r.length; j++) {
				const [a, A] = r[i];
				const [b, B] = r[j];
				if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) out.push(`${a} / ${b}`);
			}
		return out;
	});
const openMap = async () => {
	await ev(() => app.workspace.openLinkText("Map", "", false));
	await wait(1500);
	expect((await ev(() => app.workspace.getMostRecentLeaf().view.getViewType())) === "mindmap-markdown", "not the map view");
};

await step("Add note… opens a real Modal and the note is saved indented under the bullet", async () => {
	await openMap();
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Add note…").click();
	await page.locator(".modal-container textarea.mm-note-input").waitFor({ timeout: 5000 });
	await page.keyboard.type("Remember **this**");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("See [[Garden]]");
	await key("Control+Enter");
	expect((await page.locator(".modal-container").count()) === 0, "the modal is still open");
	await settled();
	expect((await file()).includes("- First idea\n\tRemember **this**\n\n\tSee [[Garden]]\n"), await file());
	expect((await node("First idea").locator(".mm-note-marker svg").count()) === 1, "no marker with an icon");
	expect((await page.locator(".mm-outline-row .mm-outline-note").count()) === 1, "no note icon in the outline");
	const o = await overlaps();
	expect(o.length === 0, o.join("; "));
});

await step("the note marker opens the note in a popover; links in it work; Escape closes it", async () => {
	await node("First idea").locator(".mm-note-marker").hover();
	await popover().waitFor({ timeout: 3000 });
	expect(/Remember this/.test(await popover().textContent()), await popover().textContent());
	expect((await popover().locator("strong").count()) === 1, "not rendered as Markdown");
	await shot("1-note-popover");
	await key("Escape");
	expect((await popover().count()) === 0, "Escape didn't close it");
	await node("First idea").locator(".mm-note-marker").click();
	await popover().waitFor({ timeout: 3000 });
	await page.mouse.move(5, 5);
	await wait(500);
	expect((await popover().count()) === 1, "a clicked note should stay open");
	await popover().locator("a.internal-link").click();
	await wait(800);
	expect((await ev(() => app.workspace.getActiveFile()?.path)) === "Garden.md", "the link didn't open Garden");
	await openMap();
});

await step("Add image… uses the real suggester; the image renders capped and the map makes room", async () => {
	await node("Second idea").click({ button: "right" });
	await wait(300);
	await menuItem("Add image…").click();
	await page.locator(".prompt-input").waitFor({ timeout: 5000 });
	const offered = await page.locator(".prompt-results .suggestion-item").allTextContents();
	expect(offered.length === 1 && offered[0].includes("plan.png"), offered.join(", "));
	await page.keyboard.type("plan");
	await key("Enter");
	await settled();
	expect((await file()).includes("- Second idea (edited) ![[plan.png]]\n"), await file());
	const img = page.locator(".workspace-leaf.mod-active .mm-node img").first();
	await img.waitFor({ timeout: 5000 });
	await page.waitForFunction(() => document.querySelector(".workspace-leaf.mod-active .mm-node img")?.complete, null, { timeout: 5000 });
	await wait(500);
	const size = await img.evaluate((i) => ({ w: i.clientWidth, h: i.clientHeight, nw: i.naturalWidth }));
	expect(size.nw === 400 && size.w <= 240 && size.h <= 160 && size.h > 100, JSON.stringify(size));
	const o = await overlaps();
	expect(o.length === 0, o.join("; "));
	await shot("2-image-topic");
});

await step("an image in a note shows in the popover", async () => {
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Edit note…").click();
	await page.locator(".modal-container textarea.mm-note-input").waitFor({ timeout: 5000 });
	await key("Control+End");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await page.keyboard.type("![[plan.png]]");
	await page.locator(".modal-container button.mod-cta").click();
	await settled();
	expect((await file()).includes("\tSee [[Garden]]\n\n\t![[plan.png]]\n"), await file());
	await node("First idea").locator(".mm-note-marker").click();
	await page.waitForFunction(() => document.querySelector(".mm-note-popover img")?.complete, null, { timeout: 5000 });
	await wait(300);
	const h = await page.locator(".mm-note-popover img").evaluate((i) => i.clientHeight);
	expect(h > 50 && h <= 240, String(h));
	await shot("3-note-image");
	await page.mouse.click(5, 300);
	await wait(200);
	expect((await popover().count()) === 0, "an outside click didn't close it");
});

await step("Remove note takes the marker away and Ctrl+Z brings it back", async () => {
	await node("First idea").click({ button: "right" });
	await wait(300);
	await menuItem("Remove note").click();
	await settled();
	expect(!(await file()).includes("Remember"), await file());
	expect((await page.locator(".workspace-leaf.mod-active .mm-note-marker").count()) === 0, "marker still shown");
	await node("First idea").click();
	await key("Control+z");
	await settled();
	expect((await file()).includes("\tRemember **this**"), await file());
});

await step("SVG and PNG export embed the topic's image", async () => {
	await ev(() => app.workspace.setActiveLeaf(app.workspace.getLeavesOfType("mindmap-markdown")[0], { focus: true }));
	await ev(() => app.commands.executeCommandById("mindmap-markdown:export-svg"));
	await wait(2000);
	const svgPath = await ev(() => app.vault.getFiles().find((f) => f.extension === "svg" && f.basename.startsWith("Map"))?.path ?? null);
	expect(svgPath, "no SVG written");
	const svg = await file(svgPath);
	expect(/<image href="data:image\/png;base64,/.test(svg), "no embedded image in the SVG");
	await ev(() => app.commands.executeCommandById("mindmap-markdown:export-png"));
	await wait(3000);
	expect(
		await ev(() => app.vault.getFiles().some((f) => f.extension === "png" && f.basename.startsWith("Map"))),
		"no PNG written",
	);
});

// ---- Settings tab ------------------------------------------------------------
// Driven through Obsidian's own settings window and controls, as a person would.
const DATA = ".obsidian/plugins/mindmap-markdown/data.json";
const data = async () => JSON.parse((await ev((p) => app.vault.adapter.read(p).catch(() => "null"), DATA)) ?? "null");
// Obsidian 1.14 opens Settings in a window of its own, so its controls are
// found in whichever page holds the settings modal.
let settingsPage = page;
const tab = (sel) => settingsPage.locator(`.vertical-tab-content ${sel}`);
// Obsidian draws a hidden second <select> beside each dropdown to measure it.
const dropdown = (name) => tab(`.mm-setting-${name} select.dropdown:not(.is-measuring)`);
const openSettings = async () => {
	await ev(() => {
		app.setting.open();
		app.setting.openTabById("mindmap-markdown");
	});
	for (let i = 0; i < 40; i++) {
		for (const p of browser.contexts().flatMap((c) => c.pages())) {
			if ((await p.locator(".vertical-tab-content .mm-setting-spacing").count().catch(() => 0)) > 0) {
				settingsPage = p;
				return;
			}
		}
		await wait(250);
	}
	throw new Error("the plugin's settings tab never appeared");
};
const closeSettings = async () => {
	await ev(() => app.setting.close());
	await wait(400);
};
const settingsShot = (name) => settingsPage.screenshot({ path: join(shots, `${name}.png`) });
const mapView = "app.workspace.getLeavesOfType('mindmap-markdown').map((l) => l.view).find((v) => v.file?.path === 'Map.md')";
// Map-space distance from the centre to a topic, so zoom doesn't matter.
const reach = (text) =>
	ev(
		([t, expr]) => {
			const v = eval(expr);
			const box = [...v.boxes].find(([n]) => n.text.startsWith(t))[1];
			const root = v.boxes.get(v.doc.root);
			return Math.hypot(box.x + box.w / 2 - (root.x + root.w / 2), box.y + box.h / 2 - (root.y + root.h / 2));
		},
		[text, mapView],
	);
const mapNodeStyle = (text, prop) =>
	ev(
		([t, p, expr]) => {
			const v = eval(expr);
			const el = [...v.contentEl.querySelectorAll(".mm-node")].find((e) => e.textContent.startsWith(t));
			return getComputedStyle(el)[p];
		},
		[text, prop, mapView],
	);

await step("the settings tab opens in Obsidian's settings and looks right in light and dark", async () => {
	await openMap();
	await ev(() => app.changeTheme("moonstone"));
	await openSettings();
	await wait(500);
	const names = await tab(".setting-item-name").allTextContents();
	for (const n of ["Default layout for new maps", "Spacing", "Topic width", "Animation", "Colour theme", "New maps go in"]) {
		expect(names.includes(n), `missing "${n}" in ${names.join(", ")}`);
	}
	expect(!(await tab(".mm-setting-folder").isVisible()), "the folder field shows before a folder is chosen");
	expect((await tab(".mm-swatches .mm-swatch").count()) === 8, "no swatch row");
	await settingsShot("4-settings-light");
	await ev(() => app.changeTheme("obsidian"));
	await wait(600);
	expect(await ev(() => document.body.classList.contains("theme-dark")), "not dark");
	await settingsShot("5-settings-dark");
	expect((await data()) === null, "data.json written before anything changed");
});

await step("settings: spacing relayouts the open map and is saved to data.json", async () => {
	const before = await reach("Second idea");
	await dropdown("spacing").selectOption("roomy");
	await wait(800);
	const roomy = await reach("Second idea");
	expect(roomy > before + 10, `${before} -> ${roomy}`);
	await dropdown("spacing").selectOption("compact");
	await wait(800);
	expect((await reach("Second idea")) < before, "compact didn't bring it closer");
	expect((await data())?.spacing === "compact", JSON.stringify(await data()));
});

await step("settings: a colour theme recolours the open map and the preview, in dark and light", async () => {
	// Second idea has no colour of its own; First idea was coloured green above.
	const auto = await mapNodeStyle("Second idea", "borderBottomColor");
	const own = await mapNodeStyle("First idea", "borderBottomColor");
	await dropdown("theme").selectOption("vivid");
	await wait(400);
	expect((await mapNodeStyle("Second idea", "borderBottomColor")) === "rgb(255, 138, 51)", `dark vivid: ${await mapNodeStyle("Second idea", "borderBottomColor")}`);
	expect((await mapNodeStyle("First idea", "borderBottomColor")) === own, "a chosen branch colour changed");
	expect(auto !== "rgb(255, 138, 51)", auto);
	const swatch = await tab(".mm-swatches .mm-c1").evaluate((e) => getComputedStyle(e).backgroundColor);
	expect(swatch === "rgb(255, 138, 51)", `swatch: ${swatch}`);
	await settingsShot("6-settings-vivid-dark");
	await ev(() => app.changeTheme("moonstone"));
	await wait(600);
	expect((await mapNodeStyle("Second idea", "borderBottomColor")) === "rgb(255, 106, 0)", `light vivid: ${await mapNodeStyle("Second idea", "borderBottomColor")}`);
	await settingsShot("7-settings-vivid-light");
	await shot("7-map-vivid-light");
	expect((await data())?.theme === "vivid", JSON.stringify(await data()));
});

await step("settings: topic width changes the open map's topics", async () => {
	await dropdown("width").selectOption("narrow");
	await wait(500);
	expect((await mapNodeStyle("Second idea", "maxWidth")) === "200px", await mapNodeStyle("Second idea", "maxWidth"));
	await dropdown("width").selectOption("wide");
	await wait(500);
	expect((await mapNodeStyle("Second idea", "maxWidth")) === "480px", await mapNodeStyle("Second idea", "maxWidth"));
	expect((await data())?.topicWidth === "wide", JSON.stringify(await data()));
});

await step("settings: the animation toggle turns the glide off", async () => {
	await tab(".mm-setting-animation .checkbox-container").click();
	await wait(300);
	expect((await data())?.animation === false, JSON.stringify(await data()));
	await closeSettings();
	await openMap();
	const frames = () =>
		ev((expr) => [...eval(expr).contentEl.querySelectorAll(".mm-node")].map((n) => n.style.transform), mapView);
	await ev(() => app.commands.executeCommandById("mindmap-markdown:toggle-layout"));
	await wait(30);
	const early = await frames();
	await wait(400);
	expect(JSON.stringify(early) === JSON.stringify(await frames()), "topics still moved after the first frame");
	await ev(() => app.commands.executeCommandById("mindmap-markdown:toggle-layout"));
	await settled();
});

await step("settings: default layout and a chosen folder (with suggestions) apply to a new map", async () => {
	await ev(async () => void (await app.vault.createFolder("Projects")));
	await openSettings();
	await dropdown("layout").selectOption("right");
	await dropdown("location").selectOption("folder");
	await wait(200);
	expect(await tab(".mm-setting-folder").isVisible(), "the folder field didn't appear");
	await tab(".mm-setting-folder input").click();
	await settingsPage.keyboard.type("Proj");
	const suggestion = settingsPage.locator(".suggestion-container .suggestion-item", { hasText: "Projects" }).first();
	await suggestion.waitFor({ timeout: 3000 });
	await suggestion.click();
	await wait(300);
	expect((await tab(".mm-setting-folder input").inputValue()) === "Projects", await tab(".mm-setting-folder input").inputValue());
	const d = await data();
	expect(d?.defaultLayout === "right" && d?.newMapLocation === "folder" && d?.newMapFolder === "Projects", JSON.stringify(d));
	await closeSettings();
	await ev(() => app.commands.executeCommandById("mindmap-markdown:create"));
	await wait(1500);
	const made = await file("Projects/Untitled mind map.md");
	expect(made.includes('%% mindmap-settings\n{"layout":"right"}\n%%'), made);
	const v = await ev(() => {
		const view = app.workspace.getMostRecentLeaf().view;
		return { type: view.getViewType(), path: view.file?.path, layout: view.doc?.settings.layout, cls: view.contentEl.className };
	});
	expect(v.type === "mindmap-markdown" && v.path === "Projects/Untitled mind map.md" && v.layout === "right", JSON.stringify(v));
	expect(v.cls.includes("mm-theme-vivid"), v.cls);
	// The existing map kept its own layout.
	expect(!(await file()).includes('"layout":"right"'), await file());
	await shot("8-new-map-settings");
});

await step("settings: back to the defaults restores the original look", async () => {
	await openSettings();
	for (const [sel, v] of [
		["layout", "balanced"],
		["spacing", "normal"],
		["width", "normal"],
		["theme", "obsidian"],
		["location", "obsidian"],
	]) {
		await dropdown(sel).selectOption(v);
	}
	await tab(".mm-setting-animation .checkbox-container").click();
	await wait(300);
	const d = await data();
	expect(d.spacing === "normal" && d.theme === "obsidian" && d.animation === true, JSON.stringify(d));
	await closeSettings();
	await openMap();
	expect(!(await ev((expr) => eval(expr).contentEl.className, mapView)).includes("mm-theme"), "theme class left behind");
});

await step("settings: a typed folder is saved once typing stops, even if Settings closes straight away", async () => {
	await openSettings();
	await dropdown("location").selectOption("folder");
	await wait(200);
	await tab(".mm-setting-folder input").fill("");
	await tab(".mm-setting-folder input").click();
	await settingsPage.keyboard.type("Typed folder");
	await closeSettings();
	await wait(200);
	const d = await data();
	expect(d?.newMapFolder === "Typed folder", JSON.stringify(d));
	await openSettings();
	await dropdown("location").selectOption("obsidian");
	await closeSettings();
});

await step("settings: a data.json changed on another device is picked up, not written over", async () => {
	const plugin = "app.plugins.plugins['mindmap-markdown']";
	await ev(async ([p, expr]) => {
		const raw = JSON.parse(await app.vault.adapter.read(p));
		await app.vault.adapter.write(p, JSON.stringify({ ...raw, spacing: "roomy" }));
		await eval(expr).onExternalSettingsChange();
	}, [DATA, plugin]);
	expect((await ev((expr) => eval(expr).settings.spacing, plugin)) === "roomy", "the synced spacing wasn't loaded");
	// A later change here keeps the synced value.
	await ev((expr) => eval(expr).updateSettings({ animation: true }), plugin);
	expect((await data())?.spacing === "roomy", JSON.stringify(await data()));
	await ev((expr) => eval(expr).updateSettings({ spacing: "normal" }), plugin);
});

// ---- Large maps ----------------------------------------------------------------

await step("a 1,000-topic map opens, takes a Tab, typing and Enter, saves, and draws every topic in place", async () => {
	const big = generateMap(1000);
	// Return nothing: handing an Obsidian object back across CDP can hang.
	await ev(async (md) => {
		await app.vault.create("Big.md", md);
	}, big.markdown);
	// A map is recognised by its frontmatter, so wait until Obsidian has
	// indexed the new file before opening it.
	await page.waitForFunction(() => !!app.metadataCache.getCache("Big.md")?.frontmatter, null, { timeout: 20000 });
	await ev(() => app.workspace.openLinkText("Big", "", false));
	try {
		await page.waitForFunction(
			() => document.querySelectorAll(".workspace-leaf.mod-active .mm-node").length === 1000,
			null,
			{ timeout: 30000 },
		);
	} catch (e) {
		const why = await ev(() => {
			const v = app.workspace.getMostRecentLeaf()?.view;
			return `view=${v?.getViewType()} file=${v?.file?.path} nodes=${document.querySelectorAll(".workspace-leaf.mod-active .mm-node").length} mapNodes=${v?.nodeEls?.size}`;
		});
		throw new Error(`${e.message}\n${why}`);
	}
	// Edit at 100%, where most of the map is off screen.
	await ev(() => {
		const v = app.workspace.getMostRecentLeaf().view;
		v.zoomBy(1 / v.scale);
		let n = v.doc.root.children[1];
		while (n.children.length) n = n.children[0];
		v.select(n);
		v.viewport.focus();
	});
	await key("Tab");
	await page.keyboard.type("Big map child");
	await key("Enter");
	await settled();
	expect(/\n\t+- Big map child\n/.test(await file("Big.md")), "the new topic wasn't saved");
	// Once idle, every topic's element sits at its laid-out box and is visible.
	const wrong = await ev(() => {
		const v = app.workspace.getMostRecentLeaf().view;
		const out = [];
		for (const [n, b] of v.boxes) {
			const el = v.nodeEls.get(n).el;
			const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
			if (!m || Math.abs(+m[1] - b.x) > 0.5 || Math.abs(+m[2] - b.y) > 0.5 || el.classList.contains("mm-unplaced")) out.push(n.text);
		}
		return out;
	});
	expect(wrong.length === 0, `${wrong.length} topics out of place: ${wrong.slice(0, 5).join(", ")}`);
	await shot("4-large-map");
});

await step("a new topic that lands off screen still takes the typing", async () => {
	// The reviewer's repro: Tab on a branch with 80 children at 100% puts the
	// new child far below the view, where painting is put off.
	const kids = Array.from({ length: 80 }, (_, i) => `\t- Child ${i}\n`).join("");
	await ev(async (md) => {
		await app.vault.create("Long.md", md);
	}, `---\nmindmap-plugin: basic\n---\n\n# Central topic\n\n- Branch A\n${kids}- Branch B\n`);
	await page.waitForFunction(() => !!app.metadataCache.getCache("Long.md")?.frontmatter, null, { timeout: 20000 });
	await ev(() => app.workspace.openLinkText("Long", "", false));
	await page.waitForFunction(
		() => document.querySelectorAll(".workspace-leaf.mod-active .mm-node").length === 83,
		null,
		{ timeout: 30000 },
	);
	await ev(() => {
		const v = app.workspace.getMostRecentLeaf().view;
		v.zoomBy(1 / v.scale);
		v.select(v.doc.root.children[0]);
		v.viewport.focus();
	});
	await key("Tab");
	await page.keyboard.type("Typed text");
	await key("Enter");
	await settled();
	expect(/\t- Child 79\n\t- Typed text\n- Branch B/.test(await file("Long.md")), "the typing was lost");
});

await step("no errors in the console", async () => expect(errors.length === 0, errors.join("\n")));

await browser.close().catch(() => {});
stop();
console.log(failures ? `\n${failures} real-Obsidian step(s) failed` : "\nreal Obsidian passed");
process.exit(failures ? 1 : 0);
