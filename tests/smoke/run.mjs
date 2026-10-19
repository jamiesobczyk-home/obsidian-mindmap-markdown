// Browser smoke test: bundles the real view against obsidian-shim.js, drives
// it in headless Chromium and checks what it saves. Screenshots land in
// .test-build/smoke/ so a change can be looked at, not just asserted.
//
//   npm run smoke            (set PLAYWRIGHT_MODULE if playwright isn't resolvable)
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { generateMap } from "../perf/genmap.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(root, ".test-build/smoke");
mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: [resolve(root, "tests/smoke/entry.ts")],
	bundle: true,
	format: "iife",
	outfile: resolve(out, "bundle.js"),
	alias: { obsidian: resolve(root, "tests/smoke/obsidian-shim.js") },
	logLevel: "warning",
});

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(
	() => import("/opt/node-tools/node_modules/playwright/index.mjs"),
);
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(pathToFileURL(resolve(root, "tests/smoke/index.html")).href);
await page.waitForTimeout(300);

const key = async (k) => {
	await page.keyboard.press(k);
	await page.waitForTimeout(60);
};
const saved = () => page.evaluate(() => window.saved ?? "");
const selected = () => page.textContent(".mm-node.is-selected");
const shot = (name) => page.screenshot({ path: resolve(out, `${name}.png`) });
let failures = 0;
const step = async (name, fn) => {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} catch (e) {
		failures++;
		console.log(`not ok - ${name}\n  ${String(e.message ?? e).split("\n").join("\n  ")}`);
	}
};

// Fail fast if the view didn't open cleanly: every later step would only time
// out. (A throw in onOpen once left maps drawn but impossible to edit.)
if (errors.length > 0 || !(await page.$(".mm-toolbar")) || (await page.locator(".mm-node").count()) === 0) {
	console.log(`not ok - the view opens without errors\n  ${errors.join("\n  ") || "toolbar or topics missing"}`);
	await browser.close();
	process.exit(1);
}
console.log("ok - the view opens without errors");

await shot("1-initial");

await step("arrow keys move between topics", async () => {
	await page.click(".mm-node.is-root");
	await key("ArrowRight");
	assert.match(await selected(), /Budget|Contractors/);
});

await step("Tab, typing, Enter add topics and save them", async () => {
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Tab");
	await page.keyboard.type("Permits");
	await key("Enter");
	await key("Enter");
	await page.keyboard.type("Inspection");
	await key("Enter");
	assert.match(await saved(), /\t- Appliances\n\t- Permits\n\t- Inspection\n- Contractors/);
});

await step("Space folds a branch and the fold is saved", async () => {
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Space");
	assert.equal(await page.textContent(".mm-node.is-collapsed .mm-badge"), "5");
	assert.match(await saved(), /"collapsed":\["0"\]/);
	await shot("2-folded");
});

await step("undo walks back fold, sibling, child", async () => {
	for (let i = 0; i < 3; i++) await key("Control+z");
	assert.doesNotMatch(await saved(), /Permits|collapsed/);
});

await step("Escape on a new empty topic removes it", async () => {
	const before = await saved();
	await key("Tab");
	await key("Escape");
	assert.equal(await saved(), before);
});

await step("Alt+Down reorders", async () => {
	await page.click(".mm-node.is-branch >> text=Contractors");
	await key("Alt+ArrowDown");
	assert.match(await saved(), /- Timeline[\s\S]*- Contractors/);
	await key("Control+z");
});

await step("layout switch saves and renders", async () => {
	await page.click(".mm-toolbar button[aria-label*='layout']");
	await page.waitForTimeout(150);
	assert.match(await saved(), /"layout":"right"/);
	await shot("3-right");
});

await step("a note with loose text after the list opens read-only and saves unchanged", async () => {
	const src = "# R\n\n- a\n\nA paragraph\n";
	await page.evaluate((s) => window.view.setData(s, true), src);
	await page.waitForTimeout(150);
	assert.match(await page.textContent(".mm-banner"), /Line 5/);
	await key("Tab");
	assert.equal(await page.evaluate(() => window.view.getViewData()), src);
});

// ---- Phase 3: direct manipulation ----------------------------------------

const reset = async () => {
	await page.evaluate(() => {
		window.saved = undefined;
		window.view.setData(window.initial, true);
	});
	await page.waitForTimeout(350);
};
const nodeBox = async (text) => {
	const b = await page.locator(".mm-node", { hasText: text }).last().boundingBox();
	assert.ok(b, `no topic "${text}" on screen`);
	return b;
};
// Press on a topic, then glide the mouse to (x, y) without releasing.
const dragTo = async (text, x, y) => {
	const a = await nodeBox(text);
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2 + 6, { steps: 2 });
	await page.mouse.move(x, y, { steps: 8 });
	await page.waitForTimeout(50);
};
const drop = async () => {
	await page.mouse.up();
	await page.waitForTimeout(350);
};

await step("drag Electrician onto Budget makes it Budget's last child", async () => {
	await reset();
	const b = await nodeBox("Budget");
	await dragTo("Electrician", b.x + b.width / 2, b.y + b.height / 2);
	assert.equal(await page.textContent(".mm-node.is-drop-target .mm-label"), "Budget");
	assert.equal(await page.locator(".mm-ghost").count(), 1);
	await shot("4-drag-onto");
	await drop();
	const md = await saved();
	assert.match(md, /- Budget\n\t- Cabinets \*\*\$8k\*\*\n\t- Counters\n\t- Appliances\n\t- Electrician\n- Contractors\n\t- \[\[Smith Carpentry\]\]\n- Timeline/);
	assert.equal(await page.locator(".mm-ghost, .mm-drop-line, .is-drop-target, .is-dragging").count(), 0);
});

await step("the move is one undo step, and redo puts it back", async () => {
	await key("Control+z");
	assert.match(await saved(), /- Contractors\n\t- \[\[Smith Carpentry\]\]\n\t- Electrician\n- Timeline/);
	await key("Control+Shift+z");
	assert.match(await saved(), /\t- Appliances\n\t- Electrician\n- Contractors/);
});

await step("dropping in the gap above a sibling reorders", async () => {
	await reset();
	const demo = await nodeBox("Demo in March");
	await dragTo("Install in May", demo.x + demo.width / 2, demo.y + 3);
	assert.ok(await page.isVisible(".mm-drop-line"), "insertion line shows");
	assert.equal(await page.locator(".mm-node.is-drop-target").count(), 0, "no topic highlighted for a gap drop");
	await shot("5-drag-gap");
	await drop();
	assert.match(await saved(), /- Timeline\n\t- Install in May\n\t- Demo in March\n/);
});

await step("a click without movement still selects, and no drop happens", async () => {
	await page.click(".mm-node >> text=Counters");
	assert.equal(await selected(), "Counters");
	assert.equal(await page.locator(".mm-ghost").count(), 0);
});

await step("Escape cancels a drag", async () => {
	await reset();
	const b = await nodeBox("Budget");
	await dragTo("Electrician", b.x + b.width / 2, b.y + b.height / 2);
	await key("Escape");
	await drop();
	assert.equal(await saved(), "", "nothing saved");
	assert.equal(await page.locator(".mm-ghost, .mm-drop-line").count(), 0);
});

await step("a topic can't be dropped into its own branch", async () => {
	const c = await nodeBox("Cabinets");
	await dragTo("Budget", c.x + c.width / 2, c.y + c.height / 2);
	assert.equal(await page.locator(".mm-node.is-drop-target").count(), 0);
	await drop();
	assert.equal(await saved(), "");
});

await step("Shift-click multi-selects; Delete removes both as one undo step", async () => {
	await reset();
	await page.click(".mm-node >> text=Counters");
	await page.click(".mm-node >> text=Open shelving", { modifiers: ["Shift"] });
	assert.equal(await page.locator(".mm-node.is-multi").count(), 2);
	await shot("6-multi");
	await key("Delete");
	const md = await saved();
	assert.doesNotMatch(md, /Counters|Open shelving/);
	assert.match(md, /Under-cabinet lighting/);
	await key("Control+z");
	assert.match(await saved(), /\t- Counters\n[\s\S]*\t- Open shelving\n/);
});

await step("Escape clears a multi-selection to the primary topic", async () => {
	await page.click(".mm-node >> text=Counters");
	await page.click(".mm-node >> text=Appliances", { modifiers: ["Control"] });
	await key("Escape");
	assert.equal(await page.locator(".mm-node.is-multi").count(), 0);
	assert.equal(await selected(), "Appliances");
});

await step("dragging one of several selected topics moves them all, in order", async () => {
	await page.click(".mm-node >> text=Appliances");
	await page.click(".mm-node >> text=Counters", { modifiers: ["Control"] });
	const d = await nodeBox("Design ideas");
	await dragTo("Appliances", d.x + d.width / 2, d.y + d.height / 2);
	assert.equal(await page.textContent(".mm-ghost-count"), "2");
	await drop();
	assert.match(await saved(), /- Budget\n\t- Cabinets \*\*\$8k\*\*\n- Contractors/);
	assert.match(await saved(), /\t- Under-cabinet lighting\n\t- Counters\n\t- Appliances\n/);
	await key("Control+z");
	assert.match(await saved(), /\t- Counters\n\t- Appliances\n- Contractors/);
});

await step("Shift+arrow extends the selection and Space folds all of it", async () => {
	await reset();
	await page.click(".mm-node >> text=Budget");
	await key("Shift+ArrowDown");
	assert.equal(await page.locator(".mm-node.is-multi").count(), 2);
	await key("Space");
	assert.equal(await page.locator(".mm-node.is-collapsed").count(), 2);
	await key("Control+z");
	assert.equal(await page.locator(".mm-node.is-collapsed").count(), 0);
});

await step("Alt+F focuses a branch; edits land in the real tree; Escape returns", async () => {
	await reset();
	await page.click(".mm-node >> text=Budget");
	await key("Alt+f");
	assert.ok(await page.isVisible(".mm-focusbar"));
	assert.equal(await page.textContent(".mm-node.is-root .mm-label"), "Budget");
	assert.equal(await page.locator(".mm-node").count(), 4, "only Budget's branch shows");
	assert.equal(await saved(), "", "focus is not saved");
	await key("Tab");
	await page.keyboard.type("Quote");
	await key("Enter");
	await page.waitForTimeout(250);
	await shot("7-focus");
	assert.match(await saved(), /\t- Appliances\n\t- Quote\n- Contractors/);
	assert.doesNotMatch(await saved(), /focus/i);
	await key("Escape");
	await page.waitForTimeout(250);
	assert.ok(!(await page.isVisible(".mm-focusbar")));
	assert.ok((await page.locator(".mm-node").count()) > 10, "whole map is back");
});

await step("focus via the toolbar, and the breadcrumb button returns", async () => {
	await page.click(".mm-node >> text=Timeline");
	await page.click(".mm-toolbar button[aria-label^='Focus']");
	await page.waitForTimeout(250);
	assert.equal(await page.textContent(".mm-node.is-root .mm-label"), "Timeline");
	await page.click(".mm-focusbar >> text=Back to whole map");
	await page.waitForTimeout(250);
	assert.equal(await page.textContent(".mm-node.is-root .mm-label"), "Kitchen remodel");
	assert.equal(await selected(), "Timeline");
});

await step("relayout animates, and lines track topics mid-glide", async () => {
	await reset();
	await page.click(".mm-toolbar button[aria-label*='layout']");
	await page.waitForTimeout(60);
	await shot("8-mid-animation");
	const mid = await page.evaluate(() => document.querySelector(".mm-node.is-branch").style.transform);
	await page.waitForTimeout(300);
	const end = await page.evaluate(() => document.querySelector(".mm-node.is-branch").style.transform);
	assert.notEqual(mid, end, "positions were interpolated");
});

await step("with reduced motion the relayout is instant and correct", async () => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await reset();
	const final = async () =>
		page.evaluate(() => [...document.querySelectorAll(".mm-node")].map((n) => n.style.transform + n.style.opacity));
	await page.click(".mm-toolbar button[aria-label*='layout']");
	await page.waitForTimeout(30);
	const early = await final();
	await page.waitForTimeout(300);
	assert.deepEqual(early, await final(), "nothing moves after the first frame");
	assert.ok(early.every((t) => !t.includes("scale") && /translate/.test(t)));
	assert.match(await saved(), /"layout":"right"/);
	await shot("9-reduced-motion");
	await page.emulateMedia({ reducedMotion: "no-preference" });
});

await step("dragging near the viewport edge pans the map", async () => {
	await reset();
	const before = await page.evaluate(() => document.querySelector(".mm-canvas").style.transform);
	await dragTo("Electrician", 1095, 320);
	await page.waitForTimeout(300);
	const during = await page.evaluate(() => document.querySelector(".mm-canvas").style.transform);
	await key("Escape");
	await drop();
	assert.notEqual(during, before);
	const tx = (t) => Number(/translate\((-?[\d.]+)px/.exec(t)[1]);
	assert.ok(tx(during) < tx(before), "map moved left to show more on the right");
});

await step("touch: a long press drags, a quick swipe on a topic pans", async () => {
	await reset();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
	const touch = (type, x, y) =>
		cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
	const centreOf = (b) => [b.x + b.width / 2, b.y + b.height / 2];

	// Swipe: moves straight away, so the map pans and nothing is dragged.
	const [ex, ey] = centreOf(await nodeBox("Electrician"));
	await touch("touchStart", ex, ey);
	for (let i = 1; i <= 5; i++) await touch("touchMove", ex - i * 12, ey);
	await touch("touchEnd");
	await page.waitForTimeout(100);
	const [ex2] = centreOf(await nodeBox("Electrician"));
	assert.ok(Math.abs(ex2 - (ex - 60)) < 3, `map panned with the finger (${ex} -> ${ex2})`);
	assert.equal(await saved(), "");

	// Long press, then move onto Budget and lift.
	const [sx, sy] = centreOf(await nodeBox("Electrician"));
	const [bx, by] = centreOf(await nodeBox("Budget"));
	await touch("touchStart", sx, sy);
	await page.waitForTimeout(450);
	for (let i = 1; i <= 8; i++) await touch("touchMove", sx + ((bx - sx) * i) / 8, sy + ((by - sy) * i) / 8);
	assert.equal(await page.textContent(".mm-node.is-drop-target .mm-label"), "Budget");
	await touch("touchEnd");
	await page.waitForTimeout(300);
	assert.match(await saved(), /\t- Appliances\n\t- Electrician\n- Contractors/);
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
	await cdp.detach();
});

await step("layout button cycles to down and outline", async () => {
	await page.evaluate((s) => window.view.setData(s, true), await page.evaluate(() => window.initial));
	await page.waitForTimeout(150);
	await page.click(".mm-node.is-branch >> text=Contractors");
	await key("Space");
	const layoutIs = async (name) => {
		for (let i = 0; i < 4 && !(await saved()).includes(`"layout":"${name}"`); i++) {
			await page.click(".mm-toolbar button[aria-label*='layout']");
			await page.waitForTimeout(150);
		}
		assert.match(await saved(), new RegExp(`"layout":"${name}"`));
	};
	await layoutIs("down");
	await shot("4-down");
	await layoutIs("outline");
	await shot("5-outline");
});

await step("exportSnapshot feeds toSVG", async () => {
	// export.ts isn't in the view bundle, so load it on its own as a global.
	await esbuild.build({
		entryPoints: [resolve(root, "src/export.ts")],
		bundle: true,
		format: "iife",
		globalName: "MMExport",
		outfile: resolve(out, "export.js"),
		logLevel: "warning",
	});
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.addScriptTag({ path: resolve(out, "export.js") });
	const svg = await page.evaluate(() => {
		const snap = window.view.exportSnapshot();
		return MMExport.toSVG(snap.doc, snap.boxes, snap.style);
	});
	assert.match(svg, /^<svg [^>]*viewBox="/);
	assert.equal((svg.match(/<path /g) ?? []).length, 13);
	assert.match(svg, />Smith Carpentry</);
	assert.doesNotMatch(svg, /undefined|NaN/);
});

await step("colouring a branch from the topic menu saves and recolours its topics", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node.is-branch >> text=Timeline", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Pink branch").click());
	await page.waitForTimeout(300);
	assert.match(await saved(), /"colors":\{"2":"pink"\}/);
	assert.equal(await page.locator(".mm-node.mm-color-pink").count(), 3, "Timeline and both its topics");
	await shot("6-colour");
	await key("Control+z");
	assert.doesNotMatch(await saved(), /colors/);
});

await step("opening and folding nothing leaves the note byte-identical", async () => {
	const src = "# C#\n* one\n*   two\n\n* three  \n";
	await page.evaluate((s) => window.view.setData(s, true), src);
	await page.waitForTimeout(150);
	assert.equal(await page.evaluate(() => window.view.getViewData()), src);
});

await step("an external change clears undo, so undo can't erase it", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Space");
	const synced = (await page.evaluate(() => window.initial)).replace("- Timeline", "- From the phone\n- Timeline");
	await page.evaluate((s) => window.view.setData(s, false), synced);
	await page.waitForTimeout(150);
	await key("Control+z");
	assert.match(await page.evaluate(() => window.view.getViewData()), /From the phone/);
});

await step("a topic being typed survives an external reload", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node.is-branch >> text=Timeline");
	await key("F2");
	await page.keyboard.press("End");
	await page.keyboard.type(" v2");
	const synced = (await page.evaluate(() => window.initial)).replace("Open shelving", "Open shelving (phone)");
	await page.evaluate((s) => window.view.setData(s, false), synced);
	await page.waitForTimeout(150);
	const out = await page.evaluate(() => window.view.getViewData());
	assert.match(out, /- Timeline v2/);
	assert.match(out, /Open shelving \(phone\)/);
});

await step("relationship line: create from the topic menu, label, survive reload, undo", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node >> text=Electrician", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title.startsWith("Link to")).click());
	assert.ok(await page.isVisible(".mm-hint"));
	await page.click(".mm-node >> text=Demo in March");
	await page.waitForTimeout(250);
	assert.match(await saved(), /"links":\[\{"from":"1\.1","to":"2\.0"\}\]/);
	assert.equal(await page.locator(".mm-link").count(), 1);
	assert.equal(await page.isVisible(".mm-hint"), false);
	await key("Enter");
	await page.evaluate(() => {
		const input = window.lastModal.contentEl.querySelector("input");
		input.value = "needs wiring first";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	await page.waitForTimeout(250);
	assert.match(await saved(), /"label":"needs wiring first"/);
	assert.equal(await page.textContent(".mm-link-label"), "needs wiring first");
	await shot("7-link");
	await page.evaluate(() => window.view.setData(window.saved, true));
	await page.waitForTimeout(200);
	assert.equal(await page.locator(".mm-link").count(), 1, "reloads from the file");
	await page.click(".mm-node.is-branch >> text=Contractors");
	await key("Delete");
	await page.waitForTimeout(250);
	assert.doesNotMatch(await saved(), /links/, "deleting a topic drops its link");
	await key("Control+z");
	await page.waitForTimeout(250);
	assert.match(await saved(), /"links":\[\{"from":"1\.1","to":"2\.0","label":"needs wiring first"\}\]/, "undo restores it");
});

await step("relationship line: keyboard create, select by click, Delete removes, folded end attaches to the fold", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node >> text=Counters");
	await key("Alt+KeyL");
	await key("ArrowLeft");
	await key("Enter");
	await page.waitForTimeout(250);
	assert.match(await saved(), /"links":\[\{"from":"0\.1","to":"0"\}\]/);
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Space");
	await page.waitForTimeout(250);
	assert.equal(await page.locator(".mm-link").count(), 0, "both ends fold into the same topic, so no line");
	await key("Space");
	await page.waitForTimeout(250);
	const box = await page.locator(".mm-link-hit").boundingBox();
	const pt = await page.evaluate(() => {
		const p = document.querySelector(".mm-link-hit");
		const m = p.getPointAtLength(p.getTotalLength() / 2);
		const r = p.ownerSVGElement.getScreenCTM();
		return { x: m.x * r.a + r.e, y: m.y * r.d + r.f };
	});
	assert.ok(box);
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(100);
	assert.equal(await page.locator(".mm-link.is-selected").count(), 1);
	await key("Delete");
	await page.waitForTimeout(250);
	assert.doesNotMatch(await saved(), /links/);
});

await step("central topics: add from the background menu, grow a tree, split a topic off, undo", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	const edgesBefore = await page.locator(".mm-edge").count();
	// Clear any earlier menu so this only passes if the background itself opens one.
	await page.evaluate(() => (window.lastMenu = null));
	await page.mouse.click(1000, 80, { button: "right" });
	assert.equal(await page.evaluate(() => window.lastMenu?.items.map((i) => i.title).join()), "New central topic");
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "New central topic").click());
	await page.waitForTimeout(250);
	await page.keyboard.type("Garden");
	await key("Enter");
	await page.waitForTimeout(250);
	assert.match(await saved(), /\n# Garden\n$/);
	await key("Tab");
	await page.keyboard.type("Beds");
	await key("Enter");
	await page.waitForTimeout(250);
	assert.match(await saved(), /\n# Garden\n\n- Beds\n$/);
	assert.equal(await page.locator(".mm-node.is-root").count(), 2, "Garden is drawn as a centre");
	assert.equal(await page.locator(".mm-edge").count(), edgesBefore + 1, "only Garden→Beds is new; no line House→Garden");
	await page.click(".mm-node.is-branch >> text=Timeline", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title.startsWith("Make it a separate")).click());
	await page.waitForTimeout(300);
	const out = await saved();
	assert.match(out, /# Garden\n\n- Beds\n\n# Timeline\n\n- Demo in March\n- Install in May\n$/);
	assert.doesNotMatch(out.split("# Garden")[0], /Timeline/);
	await shot("8-centrals");
	await page.evaluate(() => window.view.setData(window.saved, true));
	await page.waitForTimeout(200);
	assert.equal(await page.locator(".mm-node.is-root").count(), 3, "reloads three centres");
	await page.click(".mm-node.is-root >> text=Timeline");
	await key("Enter");
	await page.keyboard.type("Budget 2027");
	await key("Enter");
	await page.waitForTimeout(250);
	assert.match(await saved(), /# Timeline\n\n- Demo in March\n- Install in May\n\n# Budget 2027\n$/, "Enter beside a centre makes another centre");
	await key("Control+z");
	await page.waitForTimeout(250);
	assert.doesNotMatch(await saved(), /Budget 2027/);
});

await step("phone path: the actions button offers delete, fold and link menus without right-click", async () => {
	const src = "# A\n\n- x\n\n# B\n\n- y\n\t- y1\n";
	await page.evaluate((s) => window.view.setData(s, true), src);
	await page.waitForTimeout(200);
	await page.click(".mm-node.is-root >> text=B");
	await page.click(".mm-toolbar button[aria-label^='Actions']");
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Fold branch").click());
	await page.waitForTimeout(250);
	assert.equal(await page.textContent(".mm-node.is-root.is-collapsed .mm-badge"), "2", "a folded centre shows its count");
	await page.click(".mm-node.is-root.is-collapsed .mm-badge");
	await page.waitForTimeout(250);
	assert.equal(await page.locator(".mm-node.is-collapsed").count(), 0, "tapping the badge unfolds it");
	await page.click(".mm-node >> text=y1");
	await page.click(".mm-toolbar button[aria-label^='Actions']");
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Delete topic").click());
	await page.waitForTimeout(250);
	assert.doesNotMatch(await saved(), /y1/);
});

await step("turn a topic into a note: creates it beside the map, links the topic, then offers to open it", async () => {
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(150);
	await page.click(".mm-node >> text=Electrician", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Turn into a note").click());
	await page.waitForTimeout(300);
	assert.match(await saved(), /\t- \[\[Electrician\]\]\n/);
	const note = await page.evaluate(() => window.vaultFiles.get("Electrician.md")?.content);
	assert.equal(note, "# Electrician\n\nFrom [[Kitchen remodel]]\n");
	await page.click(".mm-node >> text=Electrician", { button: "right" });
	const titles = await page.evaluate(() => window.lastMenu.items.map((i) => i.title));
	assert.ok(titles.includes("Open linked note") && !titles.includes("Turn into a note"));
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Open linked note").click());
	assert.equal(await page.evaluate(() => window.openedLink), "Electrician");
	// A second topic with the same name links to the existing note instead of making another.
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Tab");
	await page.keyboard.type("Electrician");
	await key("Enter");
	await page.waitForTimeout(250);
	await page.click(".mm-node >> text=Electrician >> nth=1", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Turn into a note").click());
	await page.waitForTimeout(300);
	assert.equal(await page.evaluate(() => window.vaultFiles.size), 1);
	assert.equal((await saved()).match(/\[\[Electrician\]\]/g).length, 2);
});

// ---- Outline pane ----------------------------------------------------------

const frame = () => page.waitForTimeout(80);
const rowTexts = () => page.$$eval("#outline-leaf .mm-outline-row .mm-outline-text", (els) => els.map((e) => e.textContent));
const outlineSelected = () => page.textContent("#outline-leaf .mm-outline-row.is-selected .mm-outline-text");
const row = (text) => page.locator("#outline-leaf .mm-outline-row", { has: page.locator(".mm-outline-text", { hasText: new RegExp(`^${text.replace(/[$*+?.()[\]\\^{}|]/g, "\\$&")}$`) }) });

await step("outline: opens beside the map and lists every topic under its centre", async () => {
	await page.evaluate(() => {
		window.saved = undefined;
		window.view.setData(window.initial, true);
	});
	await page.waitForTimeout(200);
	await page.evaluate(() => window.openOutline());
	await frame();
	const texts = await rowTexts();
	assert.equal(texts.length, 14);
	assert.deepEqual(texts.slice(0, 5), ["Kitchen remodel", "Budget", "Cabinets $8k", "Counters", "Appliances"]);
	assert.ok(texts.includes("Smith Carpentry"), "wiki-links show as their text");
	assert.equal(await page.locator("#outline-leaf .mm-outline-row.is-central").count(), 1);
	assert.equal(await row("Kitchen remodel").locator(".collapse-icon").count(), 0, "the first centre can't be folded");
	assert.equal(await page.locator("#outline-leaf .collapse-icon").count(), 4, "each branch with topics has a triangle");
	assert.equal(await row("Counters").getAttribute("aria-level"), "3");
	assert.equal(await outlineSelected(), "Kitchen remodel", "the map's selection is highlighted");
	await shot("10-outline");
});

await step("outline: clicking a row selects that topic in the map", async () => {
	await row("Electrician").click();
	await frame();
	assert.equal(await selected(), "Electrician");
	assert.equal(await outlineSelected(), "Electrician");
	assert.equal(await saved(), "", "selecting saves nothing");
});

await step("outline: selecting in the map highlights the row", async () => {
	await page.click(".mm-node >> text=Counters");
	await frame();
	assert.equal(await outlineSelected(), "Counters");
});

await step("outline: clicking a topic outside a focused branch leaves the focus", async () => {
	await page.click(".mm-node >> text=Budget");
	await key("Alt+f");
	await page.waitForTimeout(250);
	assert.ok(await page.isVisible(".mm-focusbar"));
	assert.equal((await rowTexts()).length, 14, "the outline still lists the whole map");
	await row("Electrician").click();
	await page.waitForTimeout(250);
	assert.ok(!(await page.isVisible(".mm-focusbar")));
	assert.equal(await selected(), "Electrician");
	assert.equal(await saved(), "");
	await page.click(".mm-node >> text=Counters");
	await frame();
});

await step("outline: Up/Down move the outline's cursor, Enter selects in the map", async () => {
	await page.focus("#outline-leaf .mm-outline-list");
	await key("ArrowDown");
	await frame();
	assert.equal(await page.textContent("#outline-leaf .mm-outline-row.is-cursor .mm-outline-text"), "Appliances");
	assert.equal(await selected(), "Counters", "the map waits for Enter");
	await key("ArrowUp");
	await key("ArrowUp");
	await key("Enter");
	await frame();
	assert.equal(await selected(), "Cabinets $8k");
	assert.equal(await outlineSelected(), "Cabinets $8k");
	assert.equal(await page.locator("#outline-leaf .mm-outline-row.is-cursor").count(), 0);
});

await step("outline: F2 renames through the map, saved as one undo step", async () => {
	await key("ArrowDown");
	await key("ArrowDown");
	await key("F2");
	assert.equal(await page.inputValue("#outline-leaf .mm-outline-input"), "Appliances");
	await page.keyboard.type("Appliances & fixtures");
	await key("Enter");
	await frame();
	assert.match(await saved(), /\t- Counters\n\t- Appliances & fixtures\n- Contractors/);
	assert.equal(await page.locator("#outline-leaf .mm-outline-input").count(), 0);
	assert.ok((await rowTexts()).includes("Appliances & fixtures"));
	assert.equal(await page.locator(".mm-node", { hasText: "Appliances & fixtures" }).count(), 1, "the map shows it");
	await page.focus(".mm-viewport");
	await key("Control+z");
	await frame();
	assert.match(await saved(), /\t- Counters\n\t- Appliances\n- Contractors/);
	assert.ok((await rowTexts()).includes("Appliances"), "undo shows in the outline");
});

await step("outline: double-click renames in place; Escape cancels", async () => {
	await row("Demo in March").dblclick();
	assert.equal(await page.locator("#outline-leaf .mm-outline-input").count(), 1);
	await page.keyboard.type("Never mind");
	await key("Escape");
	await frame();
	assert.equal(await page.locator("#outline-leaf .mm-outline-input").count(), 0);
	assert.ok((await rowTexts()).includes("Demo in March"));
	assert.doesNotMatch(await saved(), /Never mind/);
	await row("Demo in March").dblclick();
	await page.keyboard.type("Demo in April");
	await page.click("#outline-leaf .mm-outline-caption"); // blur keeps the edit, as in the map
	await frame();
	assert.match(await saved(), /- Timeline\n\t- Demo in April\n/);
});

await step("outline: the triangle folds the branch in the map, and the fold is saved", async () => {
	await row("Budget").locator(".mm-outline-fold").click();
	await page.waitForTimeout(250);
	assert.match(await saved(), /"collapsed":\["0"\]/);
	assert.equal(await page.textContent(".mm-node.is-collapsed .mm-badge"), "3");
	assert.equal((await rowTexts()).length, 11, "Budget's three topics are hidden");
	assert.equal(await row("Budget").locator(".mm-outline-count").textContent(), "3");
	assert.equal(await row("Budget").getAttribute("aria-expanded"), "false");
	await shot("11-outline-folded");
	await row("Budget").locator(".mm-outline-fold").click();
	await page.waitForTimeout(250);
	assert.doesNotMatch(await saved(), /collapsed/);
	assert.equal((await rowTexts()).length, 14);
});

await step("outline: edits in the map show up, including a new topic, a delete and an external reload", async () => {
	await page.click(".mm-node.is-branch >> text=Timeline");
	await key("Tab");
	await page.keyboard.type("Permits");
	await key("Enter");
	await frame();
	const texts = await rowTexts();
	assert.equal(texts[texts.indexOf("Install in May") + 1], "Permits");
	assert.equal(await row("Permits").getAttribute("aria-level"), "3");
	assert.equal(await outlineSelected(), "Permits");
	await key("Delete");
	await frame();
	assert.ok(!(await rowTexts()).includes("Permits"));
	const synced = (await page.evaluate(() => window.initial)).replace("- Timeline", "- From the phone\n- Timeline");
	await page.evaluate((s) => window.view.setData(s, false), synced);
	await page.waitForTimeout(200);
	assert.ok((await rowTexts()).includes("From the phone"));
});

await step("outline: several centres each get a heading row, and the scroll position survives a redraw", async () => {
	const many = ["# House", "", ...Array.from({ length: 40 }, (_, i) => `- Room ${i + 1}`), "", "# Garden", "", "- Beds", "\t- Tomatoes", ""].join("\n");
	await page.evaluate((s) => window.view.setData(s, true), many);
	await page.waitForTimeout(200);
	assert.deepEqual(
		await page.$$eval("#outline-leaf .mm-outline-row.is-central .mm-outline-text", (els) => els.map((e) => e.textContent)),
		["House", "Garden"],
	);
	const scroller = "#outline-leaf .view-content";
	await page.$eval(scroller, (el) => (el.scrollTop = 300));
	await page.evaluate(() => {
		const v = window.view;
		v.renameTopic(v.doc.root.children[20], "Room twenty-one");
	});
	await frame();
	assert.ok((await rowTexts()).includes("Room twenty-one"));
	assert.equal(await page.$eval(scroller, (el) => el.scrollTop), 300);
	await row("Tomatoes").click();
	await frame();
	assert.equal(await selected(), "Tomatoes");
	await shot("12-outline-centrals");
});

await step("outline: a read-only map still lists and navigates, but can't be renamed or folded", async () => {
	const src = "# R\n\n- a\n\t- b\n\nA paragraph\n";
	await page.evaluate((s) => window.view.setData(s, true), src);
	await page.waitForTimeout(200);
	assert.deepEqual(await rowTexts(), ["R", "a", "b"]);
	assert.equal(await page.textContent("#outline-leaf .mm-outline-badge"), "Read-only");
	await row("a").locator(".mm-outline-fold").click();
	await row("b").dblclick();
	await page.focus("#outline-leaf .mm-outline-list");
	await key("F2");
	await frame();
	assert.equal(await page.locator("#outline-leaf .mm-outline-input").count(), 0);
	assert.equal((await rowTexts()).length, 3, "nothing folded");
	assert.equal(await page.evaluate(() => window.view.getViewData()), src);
	assert.equal(await selected(), "b", "navigation still works");
});

await step("outline: shows an empty state with no map open, and picks the map up again", async () => {
	await page.evaluate(() => window.setActiveMap(false));
	await frame();
	assert.ok(await page.isVisible("#outline-leaf .mm-outline-empty"));
	assert.equal(await page.textContent("#outline-leaf .mm-outline-empty"), "Open a mind map to see its outline");
	assert.equal(await page.locator("#outline-leaf .mm-outline-row:visible").count(), 0);
	await shot("13-outline-empty");
	await page.evaluate(() => window.setActiveMap(true));
	await frame();
	assert.ok(!(await page.isVisible("#outline-leaf .mm-outline-empty")));
	assert.deepEqual(await rowTexts(), ["R", "a", "b"]);
	await page.evaluate(() => window.view.clear());
	await frame();
	assert.ok(await page.isVisible("#outline-leaf .mm-outline-empty"), "a map whose file is unloaded counts as none");
	await page.evaluate(() => window.view.setData(window.initial, true));
	await page.waitForTimeout(200);
	assert.equal((await rowTexts()).length, 14);
});

// ---- Boundaries and summaries ------------------------------------------------

const submitModal = (text) =>
	page.evaluate((t) => {
		const input = window.lastModal.contentEl.querySelector("input");
		input.value = t;
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	}, text);
const menuClick = (title) => page.evaluate((t) => window.lastMenu.items.find((i) => i.title === t).click(), title);
const menuTitles = () => page.evaluate(() => window.lastMenu.items.map((i) => i.title));

await step("boundary: add from the topic menu, label it, remove it, each one undo step", async () => {
	await page.evaluate(() => {
		window.saved = undefined;
		window.view.setData(window.initial, true);
	});
	await page.waitForTimeout(200);
	await page.click(".mm-node.is-branch >> text=Budget", { button: "right" });
	assert.ok((await menuTitles()).includes("Add boundary"));
	await menuClick("Add boundary");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"boundaries":\{"0":""\}/);
	assert.equal(await page.locator(".mm-boundary").count(), 1);
	// The boundary wraps Budget and all three of its topics.
	const rect = await page.locator(".mm-boundary").boundingBox();
	for (const t of ["Budget", "Cabinets", "Counters", "Appliances"]) {
		const b = await nodeBox(t);
		assert.ok(b.x > rect.x && b.y > rect.y && b.x + b.width < rect.x + rect.width && b.y + b.height < rect.y + rect.height, `${t} inside`);
	}
	await page.click(".mm-node.is-branch >> text=Budget", { button: "right" });
	const titles = await menuTitles();
	assert.ok(titles.includes("Edit boundary label") && titles.includes("Remove boundary") && !titles.includes("Add boundary"));
	await menuClick("Edit boundary label");
	await submitModal("Money");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"boundaries":\{"0":"Money"\}/);
	assert.equal(await page.textContent(".mm-boundary-label"), "Money");
	// A nested boundary, then fold Budget: the inner one goes, the outer one shrinks.
	await page.click(".mm-node >> text=Counters", { button: "right" });
	await menuClick("Add boundary");
	await page.waitForTimeout(300);
	assert.equal(await page.locator(".mm-boundary").count(), 2);
	await shot("14-boundaries");
	await key("Control+z");
	await page.waitForTimeout(250);
	assert.match(await saved(), /"boundaries":\{"0":"Money"\}/);
	await page.click(".mm-node.is-branch >> text=Budget");
	await key("Space");
	await page.waitForTimeout(300);
	const folded = await page.locator(".mm-boundary").boundingBox();
	assert.ok(folded.height < rect.height, "the boundary shrinks to the folded topic");
	await key("Space");
	await page.waitForTimeout(250);
	await page.click(".mm-node.is-branch >> text=Budget", { button: "right" });
	await menuClick("Remove boundary");
	await page.waitForTimeout(300);
	assert.doesNotMatch(await saved(), /boundaries/);
	assert.equal(await page.locator(".mm-boundary").count(), 0);
	await key("Control+z");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"boundaries":\{"0":"Money"\}/, "undo brings it back");
	assert.equal(await page.locator(".mm-boundary").count(), 1);
});

await step("summary: multi-select siblings, add from the menu, click selects, Delete removes, undo restores", async () => {
	await page.evaluate(() => {
		window.saved = undefined;
		window.view.setData(window.initial, true);
	});
	await page.waitForTimeout(200);
	await page.click(".mm-node >> text=Cabinets");
	await page.click(".mm-node >> text=Appliances", { modifiers: ["Shift"] });
	await page.click(".mm-node >> text=Appliances", { button: "right" });
	assert.ok((await menuTitles()).includes("Add summary…"));
	await menuClick("Add summary…");
	await submitModal("Fit-out costs");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"summaries":\[\{"from":"0\.0","to":"0\.2","text":"Fit-out costs"\}\]/);
	assert.equal(await page.locator(".mm-summary").count(), 1);
	assert.equal(await page.textContent(".mm-summary-label"), "Fit-out costs");
	// The brace is beyond Budget's topics on the outer side.
	const brace = await page.locator(".mm-summary").boundingBox();
	for (const t of ["Cabinets", "Counters", "Appliances"]) {
		const b = await nodeBox(t);
		assert.ok(brace.x >= b.x + b.width, `brace right of ${t}`);
	}
	await shot("15-summary");
	// A new summary is selected; Escape lets go, a click on the label picks it again.
	await key("Escape");
	assert.equal(await page.locator(".mm-summary.is-selected").count(), 0);
	await page.click(".mm-summary-label");
	assert.equal(await page.locator(".mm-summary.is-selected").count(), 1);
	await key("Enter");
	await submitModal("Fit-out");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"text":"Fit-out"\}/);
	// Click the brace itself.
	await key("Escape");
	const pt = await page.evaluate(() => {
		const p = document.querySelector(".mm-summary-hit");
		const m = p.getPointAtLength(p.getTotalLength() / 4);
		const r = p.ownerSVGElement.getScreenCTM();
		return { x: m.x * r.a + r.e, y: m.y * r.d + r.f };
	});
	await page.mouse.click(pt.x, pt.y);
	await page.waitForTimeout(100);
	assert.equal(await page.locator(".mm-summary.is-selected").count(), 1, "clicking the brace selects it");
	await key("Delete");
	await page.waitForTimeout(300);
	assert.doesNotMatch(await saved(), /summaries/);
	assert.equal(await page.locator(".mm-summary").count(), 0);
	await key("Control+z");
	await page.waitForTimeout(300);
	assert.match(await saved(), /"summaries":\[\{"from":"0\.0","to":"0\.2","text":"Fit-out"\}\]/);
	assert.equal(await page.locator(".mm-summary").count(), 1);
	// Right-click menu on the brace.
	await page.click(".mm-summary-label", { button: "right" });
	assert.deepEqual(await menuTitles(), ["Edit summary", "Remove summary"]);
	await menuClick("Remove summary");
	await page.waitForTimeout(300);
	assert.doesNotMatch(await saved(), /summaries/);
	await key("Control+z");
	await page.waitForTimeout(300);
});

await step("summary: drawn in every layout, and nothing drawn once its ends aren't siblings", async () => {
	for (let i = 0; i < 4; i++) {
		assert.equal(await page.locator(".mm-summary").count(), 1, `layout ${i}`);
		await page.click(".mm-toolbar button[aria-label*='layout']");
		await page.waitForTimeout(300);
		if (i === 1) await shot("16-summary-down");
	}
	// Move Appliances under Counters: the summary's ends now have different parents.
	await page.click(".mm-node >> text=Appliances");
	const c = await nodeBox("Counters");
	await dragTo("Appliances", c.x + c.width / 2, c.y + c.height / 2);
	await drop();
	assert.match(await saved(), /\t- Counters\n\t\t- Appliances/);
	assert.equal(await page.locator(".mm-summary").count(), 0);
	await key("Control+z");
	await page.waitForTimeout(300);
	assert.equal(await page.locator(".mm-summary").count(), 1);
});

await step("export: SVG includes boundaries and summaries from the view", async () => {
	await page.evaluate(() => window.view.setData(window.initial.replace("- Design ideas", "- Design ideas") + '\n%% mindmap-settings\n{"boundaries":{"1":"People"},"summaries":[{"from":"0","to":"1","text":"Spend"}]}\n%%\n', true));
	await page.waitForTimeout(200);
	assert.equal(await page.locator(".mm-boundary").count(), 1);
	assert.equal(await page.locator(".mm-summary").count(), 1);
	const svg = await page.evaluate(() => {
		const snap = window.view.exportSnapshot();
		return MMExport.toSVG(snap.doc, snap.boxes, snap.style);
	});
	assert.match(svg, /class="boundary"/);
	assert.match(svg, />People</);
	assert.match(svg, /class="summary-label"[^>]*>Spend</);
	await shot("17-both");
});

// ---- Notes and images on topics -------------------------------------------

const topic = (text) => page.locator(".mm-node", { has: page.locator(".mm-label", { hasText: text }) }).last();
const popover = () => page.locator(".mm-note-popover");
// Every pair of topics on screen, checked for overlap (a pixel of slack).
const overlaps = () =>
	page.$$eval(".mm-node:not(.mm-ghost)", (els) => {
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

await step("notes: Add note… from the menu saves it indented under the bullet, with a marker and an outline icon", async () => {
	await reset();
	await topic("Counters").click({ button: "right" });
	const titles = await page.evaluate(() => window.lastMenu.items.map((i) => i.title));
	assert.ok(titles.includes("Add note…") && titles.includes("Add image…") && !titles.includes("Remove note"), titles.join());
	await menuClick("Add note…");
	await page.waitForSelector(".modal-container textarea.mm-note-input");
	assert.equal(await page.textContent(".modal-container .modal-title"), "Add note");
	await page.fill(".modal-container textarea", "Granite or **quartz**\n\nSee [[Stone yard]]");
	await page.press(".modal-container textarea", "Control+Enter");
	await frame();
	assert.equal(await page.locator(".modal-container").count(), 0, "the modal closed");
	assert.match(await saved(), /\t- Counters\n\t\tGranite or \*\*quartz\*\*\n\n\t\tSee \[\[Stone yard\]\]\n\t- Appliances/);
	assert.equal(await topic("Counters").locator(".mm-note-marker").count(), 1);
	assert.equal(await page.locator(".mm-note-marker").count(), 1, "only that topic has a marker");
	assert.equal(await row("Counters").locator(".mm-outline-note").count(), 1, "the outline row shows a note icon");
	assert.equal(await page.locator("#outline-leaf .mm-outline-note").count(), 1);
	assert.deepEqual(await overlaps(), []);
});

await step("notes: hovering the marker shows the note; a click pins it; links work; Escape and outside clicks close it", async () => {
	await topic("Counters").locator(".mm-note-marker").hover();
	await popover().waitFor();
	assert.match(await popover().textContent(), /Granite or quartz/);
	assert.equal(await popover().locator("strong").textContent(), "quartz", "rendered as Markdown");
	await shot("14-note-popover");
	await page.mouse.move(20, 600);
	await page.waitForTimeout(450);
	assert.equal(await popover().count(), 0, "leaving the marker hides it");
	await topic("Timeline").click();
	await topic("Counters").locator(".mm-note-marker").click();
	await page.mouse.move(20, 600);
	await page.waitForTimeout(450);
	assert.equal(await popover().count(), 1, "a clicked note stays open");
	assert.equal(await selected(), "Timeline", "clicking the marker doesn't select the topic");
	await popover().locator("a.internal-link").click();
	assert.equal(await page.evaluate(() => window.openedLink), "Stone yard");
	assert.equal(await popover().count(), 1);
	await page.focus(".mm-viewport");
	await key("Escape");
	assert.equal(await popover().count(), 0, "Escape closes it");
	await topic("Counters").locator(".mm-note-marker").click();
	await popover().waitFor();
	await topic("Counters").locator(".mm-note-marker").click();
	assert.equal(await popover().count(), 0, "a second click closes it (the phone path)");
	await topic("Counters").locator(".mm-note-marker").click();
	await popover().waitFor();
	await page.mouse.click(30, 600);
	assert.equal(await popover().count(), 0, "a click elsewhere closes it");
	await topic("Counters").locator(".mm-note-marker").click();
	await popover().waitFor();
	await topic("Timeline").click();
	await key("Tab");
	await key("Escape");
	assert.equal(await popover().count(), 0, "a change to the map closes it");
});

await step("notes: Alt+N edits; Escape cancels; an empty note is removed; undo brings it back", async () => {
	await topic("Counters").click();
	const before = await saved();
	await key("Alt+KeyN");
	await page.waitForSelector(".modal-container textarea");
	assert.equal(await page.textContent(".modal-container .modal-title"), "Edit note");
	assert.equal(await page.inputValue(".modal-container textarea"), "Granite or **quartz**\n\nSee [[Stone yard]]");
	await page.fill(".modal-container textarea", "changed my mind");
	await page.press(".modal-container textarea", "Escape");
	await frame();
	assert.equal(await page.locator(".modal-container").count(), 0);
	assert.equal(await saved(), before, "Escape keeps the old note");
	await page.focus(".mm-viewport");
	await key("Alt+KeyN");
	await page.fill(".modal-container textarea", "  \n ");
	await page.click(".modal-container button.mod-cta");
	await frame();
	assert.doesNotMatch(await saved(), /Granite/);
	assert.equal(await page.locator(".mm-note-marker").count(), 0);
	assert.equal(await page.locator("#outline-leaf .mm-outline-note").count(), 0);
	await page.focus(".mm-viewport");
	await key("Control+z");
	await frame();
	assert.equal(await saved(), before, "undo restores the note in one step");
	assert.equal(await topic("Counters").locator(".mm-note-marker").count(), 1);
	await topic("Counters").click({ button: "right" });
	await menuClick("Remove note");
	await frame();
	assert.doesNotMatch(await saved(), /Granite/);
	await page.focus(".mm-viewport");
	await key("Control+z");
	await frame();
	assert.equal(await saved(), before);
	// The central topic's note is the paragraph under its heading.
	await page.evaluate(() => window.view.setTopicNote(window.view.doc.root, "The whole plan."));
	await frame();
	assert.match(await saved(), /# Kitchen remodel\n\nThe whole plan\.\n\n- Budget/);
	assert.equal(await page.locator(".mm-node.is-root .mm-note-marker").count(), 1);
	assert.deepEqual(await overlaps(), []);
});

await step("images: Add image… lists only the vault's images, embeds the pick, and the map relayouts when it loads", async () => {
	await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 400;
		c.height = 300;
		const g = c.getContext("2d");
		g.fillStyle = "#4a90d9";
		g.fillRect(0, 0, 400, 300);
		g.fillStyle = "#f5a623";
		g.fillRect(40, 40, 320, 220);
		window.imageUrls = { "Attachments/plan.png": c.toDataURL("image/png") };
		const TFile = window.vaultFiles.values().next().value?.file.constructor;
		const mk = (p) => window.vaultFiles.set(p, { file: new TFile(p), content: "" });
		mk("Attachments/plan.png");
		mk("Attachments/brief.pdf");
	});
	await topic("Appliances").click({ button: "right" });
	await menuClick("Add image…");
	await page.waitForSelector(".modal-container .prompt-input");
	const items = await page.$$eval(".modal-container .suggestion-item", (els) => els.map((e) => e.textContent));
	assert.deepEqual(items, ["Attachments/plan.png"], "markdown notes and PDFs aren't offered");
	const before = await topic("Appliances").boundingBox();
	await page.keyboard.type("plan");
	await key("Enter");
	assert.equal(await page.locator(".modal-container").count(), 0);
	assert.match(await saved(), /\t- Appliances !\[\[plan\.png\]\]\n- Contractors/);
	await page.waitForSelector(".mm-node .mm-label img");
	await page.waitForTimeout(400);
	const img = await page.$eval(".mm-node .mm-label img", (i) => ({ w: i.clientWidth, h: i.clientHeight, nw: i.naturalWidth }));
	assert.equal(img.nw, 400, "the picture loaded");
	assert.ok(img.w <= 240 && img.h <= 160 && img.h > 100, JSON.stringify(img));
	const after = await topic("Appliances").boundingBox();
	assert.ok(after.height > before.height + 100, `the topic grew: ${before.height} -> ${after.height}`);
	assert.deepEqual(await overlaps(), [], "topics moved apart after the image loaded");
	await shot("15-image-topic");
	await page.focus(".mm-viewport");
	await key("Control+z");
	await frame();
	assert.match(await saved(), /\t- Appliances\n- Contractors/);
});

await step("images: an image in a note shows, capped, in the popover", async () => {
	await page.evaluate(() => window.view.setTopicNote(window.view.doc.root.children[0], "Floor plan:\n\n![[Attachments/plan.png]]"));
	await page.waitForTimeout(150);
	await topic("Budget").locator(".mm-note-marker").click();
	await page.waitForSelector(".mm-note-popover img");
	await page.waitForTimeout(150);
	const box = await page.$eval(".mm-note-popover", (p) => {
		const i = p.querySelector("img");
		const pr = p.getBoundingClientRect();
		const ir = i.getBoundingClientRect();
		const vr = document.querySelector(".mm-view").getBoundingClientRect();
		return { ih: ir.height, inside: ir.right <= pr.right + 1, inView: pr.left >= vr.left && pr.right <= vr.right && pr.top >= vr.top && pr.bottom <= vr.bottom + 1 };
	});
	assert.ok(box.ih > 50 && box.ih <= 240 && box.inside && box.inView, JSON.stringify(box));
	await shot("16-note-image");
	await page.mouse.click(30, 600);
});

// ---- Settings (src/settings.ts) -------------------------------------------
// The stand-in plugin has no settings, so the view uses the defaults; these
// steps give it some and call the hook the plugin calls on every open map.
const useSettings = (change) =>
	page.evaluate((c) => {
		const v = window.view;
		v.plugin.settings = {
			defaultLayout: "balanced", spacing: "normal", animation: true, topicWidth: "normal",
			newMapLocation: "obsidian", newMapFolder: "", theme: "obsidian", ...(v.plugin.settings ?? {}), ...c,
		};
		v.applyMapSettings();
	}, change);
// Map-space distance from the centre to a topic, so zoom and fit don't matter.
const reach = (text) =>
	page.evaluate((t) => {
		const v = window.view;
		const box = [...v.boxes].find(([n]) => n.text === t)[1];
		const root = v.boxes.get(v.doc.root);
		return Math.hypot(box.x + box.w / 2 - (root.x + root.w / 2), box.y + box.h / 2 - (root.y + root.h / 2));
	}, text);
const borderOf = (text) => topic(text).evaluate((e) => getComputedStyle(e).borderBottomColor);

await step("settings: spacing moves topics apart or together, live", async () => {
	await reset();
	await useSettings({ animation: false });
	const normal = await reach("Counters");
	await useSettings({ spacing: "roomy" });
	await page.waitForTimeout(100);
	const roomy = await reach("Counters");
	await useSettings({ spacing: "compact" });
	await page.waitForTimeout(100);
	const compact = await reach("Counters");
	assert.ok(roomy > normal + 20 && compact < normal - 10, `${compact} < ${normal} < ${roomy}`);
	await shot("17-compact");
	await useSettings({ spacing: "normal", animation: true });
});

await step("settings: animation off means no glide", async () => {
	await reset();
	await useSettings({ animation: false });
	const final = async () =>
		page.evaluate(() => [...document.querySelectorAll(".mm-node")].map((n) => n.style.transform + n.style.opacity));
	await page.click(".mm-toolbar button[aria-label*='layout']");
	await page.waitForTimeout(30);
	const early = await final();
	await page.waitForTimeout(300);
	assert.deepEqual(early, await final(), "nothing moves after the first frame");
	await useSettings({ animation: true });
	await reset();
	await page.click(".mm-toolbar button[aria-label*='layout']");
	await page.waitForTimeout(60);
	const mid = await final();
	await page.waitForTimeout(300);
	assert.notDeepEqual(mid, await final(), "with animation back on, it glides again");
});

await step("settings: a colour theme recolours automatic branches, in light and dark, and export follows", async () => {
	await reset();
	assert.equal(await borderOf("Budget"), "rgb(8, 109, 221)", "Obsidian's blue by default");
	await useSettings({ theme: "vivid" });
	assert.ok(await page.$(".mm-view.mm-theme-vivid"));
	assert.equal(await borderOf("Budget"), "rgb(0, 102, 255)");
	assert.equal(await borderOf("Contractors"), "rgb(255, 106, 0)");
	await page.evaluate(() => document.body.classList.add("theme-dark"));
	assert.equal(await borderOf("Budget"), "rgb(61, 139, 255)", "dark value");
	await page.evaluate(() => document.body.classList.remove("theme-dark"));
	// Lines take the theme too.
	const edge = await page.$eval(".mm-edge.mm-c0", (e) => getComputedStyle(e).stroke);
	assert.equal(edge, "rgb(0, 102, 255)");
	// A colour picked for a branch still wins.
	await page.click(".mm-node.is-branch >> text=Timeline", { button: "right" });
	await page.evaluate(() => window.lastMenu.items.find((i) => i.title === "Pink branch").click());
	await page.waitForTimeout(300);
	assert.equal(await borderOf("Timeline"), "rgb(213, 57, 132)", "Obsidian's pink, not the theme's");
	// Export reads the resolved colours off the topics.
	const svg = await page.evaluate(() => {
		const snap = window.view.exportSnapshot();
		return MMExport.toSVG(snap.doc, snap.boxes, snap.style);
	});
	assert.match(svg, /rgb\(0, 102, 255\)/);
	assert.match(svg, /rgb\(213, 57, 132\)/);
	assert.doesNotMatch(svg, /rgb\(8, 109, 221\)/);
	await shot("18-theme-vivid");
	// Monochrome is shades of the accent; every theme changes branch 0.
	for (const theme of ["pastel", "earth", "mono", "contrast"]) {
		await useSettings({ theme });
		const c = await borderOf("Budget");
		assert.ok(c !== "rgb(8, 109, 221)" && c !== "rgb(0, 102, 255)", `${theme}: ${c}`);
	}
	await useSettings({ theme: "obsidian" });
	assert.equal(await page.$("[class*='mm-theme-']"), null, "the class is gone again");
	assert.equal(await borderOf("Budget"), "rgb(8, 109, 221)");
});

await step("settings: topic width caps how wide a topic grows before wrapping", async () => {
	const long = "A long topic that keeps going well past two hundred pixels and then some more words to wrap";
	await page.evaluate((t) => window.view.setData(`# R\n\n- ${t}\n- b\n`, true), long);
	await page.waitForTimeout(350);
	// The cap is on the text; padding and border come on top of it.
	const width = () => topic("A long topic").evaluate((e) => e.offsetWidth);
	const normal = await width();
	assert.equal(await topic("A long topic").evaluate((e) => getComputedStyle(e).maxWidth), "320px");
	await useSettings({ topicWidth: "narrow" });
	await page.waitForTimeout(350);
	assert.equal(await width(), normal - 120);
	const box = await page.evaluate(() => [...window.view.boxes].find(([n]) => n.text.startsWith("A long"))[1].w);
	assert.equal(box, normal - 120, "relaid out with the new size");
	await shot("19-narrow");
	await useSettings({ topicWidth: "wide" });
	await page.waitForTimeout(350);
	assert.equal(await width(), normal + 160);
	await useSettings({ topicWidth: "normal" });
	await reset();
});

// ---- Large maps ---------------------------------------------------------------

// Topics whose element isn't where the layout put them. onlyOnScreen limits
// it to those in view (the rest may still be waiting to be moved).
const misplaced = (onlyOnScreen) =>
	page.evaluate((onlyOnScreen) => {
		const v = window.view;
		const vw = v.viewport.clientWidth;
		const vh = v.viewport.clientHeight;
		const out = [];
		for (const [n, b] of v.boxes) {
			const sx = b.x * v.scale + v.tx;
			const sy = b.y * v.scale + v.ty;
			const seen = sx < vw && sx + b.w * v.scale > 0 && sy < vh && sy + b.h * v.scale > 0;
			if (onlyOnScreen && !seen) continue;
			const el = v.nodeEls.get(n).el;
			const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
			if (!m || Math.abs(+m[1] - b.x) > 0.5 || Math.abs(+m[2] - b.y) > 0.5 || el.classList.contains("mm-unplaced")) out.push(n.text);
		}
		const blankEdges = [...v.edgeEls.values()].filter((e) => !e.getAttribute("d")).length;
		return { out: out.slice(0, 5), count: out.length, blankEdges };
	}, onlyOnScreen);
const settle = async () => {
	for (let i = 0; i < 50 && (await misplaced(false)).count + (await misplaced(false)).blankEdges > 0; i++) {
		await page.waitForTimeout(100);
	}
};

await step("large map: 1,000 topics open; Tab, typing and Enter save; what's on screen is always in place", async () => {
	const big = generateMap(1000);
	await page.evaluate((s) => {
		window.saved = undefined;
		window.view.setData(s, true);
	}, big.markdown);
	await page.waitForTimeout(500);
	assert.equal(await page.locator(".mm-node").count(), 1000);
	await settle();
	assert.deepEqual(await misplaced(false), { out: [], count: 0, blankEdges: 0 }, "after opening");
	// At 100% most of the map is off screen, so moves there are put off.
	await page.evaluate(() => {
		const v = window.view;
		v.zoomBy(1 / v.scale);
		let n = v.doc.root.children[1];
		while (n.children.length) n = n.children[0];
		v.select(n);
		v.viewport.focus();
	});
	await key("Tab");
	await page.keyboard.type("Big map child");
	await key("Enter");
	assert.match(await saved(), /\t- Big map child\n/);
	await page.waitForTimeout(300); // the glide
	const now = await misplaced(true);
	assert.equal(now.count, 0, `on screen but not in place: ${now.out.join(", ")}`);
	// Pan to the far side of the map: those topics are in place by the next frame.
	await page.evaluate(() => {
		const v = window.view;
		const far = [...v.boxes.values()].reduce((a, b) => (b.y > a.y ? b : a));
		v.tx = v.viewport.clientWidth / 2 - far.x;
		v.ty = v.viewport.clientHeight / 2 - far.y;
		v.applyTransform();
	});
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
	const panned = await misplaced(true);
	assert.equal(panned.count, 0, `after panning: ${panned.out.join(", ")}`);
	await settle();
	assert.deepEqual(await misplaced(false), { out: [], count: 0, blankEdges: 0 }, "once idle, everything");
	await shot("17-large-map");
	// Undo takes the new topic away again.
	await page.focus(".mm-viewport");
	await key("Control+z");
	assert.doesNotMatch(await saved(), /Big map child/);
});

await step("a new topic that lands off screen still takes the typing", async () => {
	// Tab on a branch with 80 children at 100%: the new last child is far below
	// the view, where painting is put off. It must still be editable at once.
	const kids = Array.from({ length: 80 }, (_, i) => `\t- Child ${i}\n`).join("");
	await page.evaluate((s) => {
		window.saved = undefined;
		window.view.setData(s, true);
	}, `# Central topic\n\n- Branch A\n${kids}- Branch B\n`);
	await page.waitForTimeout(300);
	await page.evaluate(() => {
		const v = window.view;
		v.zoomBy(1 / v.scale);
		v.select(v.doc.root.children[0]);
		v.viewport.focus();
	});
	await key("Tab");
	await page.keyboard.type("Typed text");
	await key("Enter");
	assert.match(await saved(), /\t- Child 79\n\t- Typed text\n- Branch B/);
});

await step("no errors in the page", async () => assert.deepEqual(errors, []));

await browser.close();
console.log(failures ? `\n${failures} smoke step(s) failed` : "\nsmoke passed");
process.exit(failures ? 1 : 0);
