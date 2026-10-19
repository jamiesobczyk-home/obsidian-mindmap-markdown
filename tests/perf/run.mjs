// Performance benchmark in the real Obsidian app, on generated maps of about
// 200, 1,000 and 3,000 topics, with and without 4x CPU throttling (roughly a
// mid-range phone), plus one run under Obsidian's mobile emulation.
//
//   npm run perf                      (PERF_LABEL=before|after names the JSON)
//   PERF_SIZES=1000 npm run perf      (only some sizes)
//   PERF_COMPARE=.test-build/perf/before.json npm run perf
//   PERF_BUILD=/some/other/build npm run perf   (benchmark another main.js)
//
// Every time is in milliseconds, measured inside the page with
// performance.now(). "To next frame" runs from the keydown reaching the page
// until the first frame painted after the map's relayout. Frame columns come
// from requestAnimationFrame intervals: a long frame is one over 50 ms.
// Results print as a table and are saved to .test-build/perf/<label>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchObsidian, plugin } from "../real/obsidian.mjs";
import { generateMap } from "./genmap.mjs";

if (process.platform !== "linux") {
	console.log(`skipped - the benchmark runs the real Obsidian on Linux only (this is ${process.platform})`);
	process.exit(0);
}

const SIZES = (process.env.PERF_SIZES ?? "200,1000,3000").split(",").map(Number);
const LABEL = process.env.PERF_LABEL ?? "latest";
const MOBILE = process.env.PERF_MOBILE !== "0";
const REPS = Number(process.env.PERF_REPS ?? 3);
const maps = Object.fromEntries(SIZES.map((n) => [n, generateMap(n)]));
const files = { "Blank.md": "Nothing here.\n" };
for (const n of SIZES) files[`Map ${n}.md`] = maps[n].markdown;

// Each configuration runs in a freshly launched Obsidian. Obsidian 1.14.4
// sometimes crashes under this harness (a segfault, with or without this
// plugin's changes), so a crashed configuration is retried in a new one.
let browser, page, stop, cdp;
const errors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);
const throttle = (rate) => cdp.send("Emulation.setCPUThrottlingRate", { rate });

async function start(mobile) {
	({ browser, page, stop } = await launchObsidian({ files, build: process.env.PERF_BUILD || undefined }));
	if (!browser) throw new Error("Obsidian didn't start");
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	cdp = await page.context().newCDPSession(page);
	await enablePlugin();
	if (mobile) {
		// Obsidian's own phone emulation; it reloads the window.
		await ev(() => app.emulateMobile(true));
		await wait(3000);
		await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60000 });
		await wait(2000);
		await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
		await wait(1000);
		await enablePlugin();
	}
	await installKit();
}

async function finish() {
	await browser?.close().catch(() => {});
	stop?.();
	browser = page = stop = cdp = undefined;
}

async function enablePlugin() {
	if (!(await ev(() => app.plugins.isEnabled()))) {
		await ev(() => app.plugins.setEnable(true));
		await wait(3000);
	}
	for (let i = 0; i < 3 && (await page.locator(".modal-container").count()) > 0; i++) {
		await page.keyboard.press("Escape");
		await wait(300);
	}
	if (!(await ev(() => !!app.plugins.plugins["mindmap-markdown"]))) throw new Error("plugin not loaded");
}

// The in-page measuring kit. It patches the open view's relayout() to note
// when one ran, and records frame times.
async function installKit() {
	await ev(() => {
		const kit = {
			t0: 0,
			end: 0,
			frames: [],
			recording: false,
			view() {
				const v = app.workspace.getMostRecentLeaf()?.view;
				return v?.getViewType() === "mindmap-markdown" ? v : null;
			},
			patch() {
				const v = kit.view();
				if (!v || v.__kitPatched) return v;
				const orig = v.relayout;
				v.relayout = function (...a) {
					const r = orig.apply(this, a);
					kit.relayoutRan();
					return r;
				};
				v.__kitPatched = true;
				return v;
			},
			relayoutRan() {
				if (!kit.t0 || kit.end || kit.pending) return;
				kit.pending = true;
				requestAnimationFrame(() =>
					setTimeout(() => {
						kit.pending = false;
						if (!kit.end) kit.end = performance.now();
					}, 0),
				);
			},
			// Arms for the next keydown anywhere in the window.
			arm() {
				kit.patch();
				kit.t0 = 0;
				kit.end = 0;
				kit.pending = false;
				window.addEventListener("keydown", () => (kit.t0 = performance.now()), { capture: true, once: true });
				kit.startFrames();
			},
			async result(timeout = 20000) {
				const t = performance.now();
				while (!kit.end && performance.now() - t < timeout) await new Promise((r) => setTimeout(r, 20));
				return kit.end ? kit.end - kit.t0 : null;
			},
			startFrames() {
				kit.frames = [];
				kit.recording = true;
				const loop = () => {
					if (!kit.recording) return;
					kit.frames.push(performance.now());
					requestAnimationFrame(loop);
				};
				requestAnimationFrame(loop);
			},
			// Frame intervals; with after, only those starting after it (so the
			// frame that carried the key handler isn't counted as animation).
			stopFrames(after = 0) {
				kit.recording = false;
				const d = [];
				for (let i = 1; i < kit.frames.length; i++) {
					if (kit.frames[i - 1] >= after) d.push(kit.frames[i] - kit.frames[i - 1]);
				}
				return d;
			},
		};
		window.__kit = kit;
	});
}

const stats = (d) => {
	if (!d.length) return { max: 0, p95: 0, long: 0, n: 0 };
	const s = [...d].sort((a, b) => a - b);
	return {
		max: Math.round(s[s.length - 1]),
		p95: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]),
		long: d.filter((x) => x > 50).length,
		n: d.length,
	};
};
const median = (xs) => {
	const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
	return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null;
};

// Presses a key; returns ms to the frame after the relayout, and the frame
// intervals over the next `settle` ms after that.
async function timedKey(key, settle = 600) {
	await ev(() => __kit.arm());
	await page.keyboard.press(key);
	const ms = await ev(() => __kit.result());
	await wait(settle);
	const frames = await ev(() => __kit.stopFrames(__kit.end));
	return { ms: ms === null ? null : Math.round(ms), frames };
}

async function openMap(n) {
	return ev(async (path) => {
		const leaf = app.workspace.getMostRecentLeaf();
		await leaf.openFile(app.vault.getAbstractFileByPath("Blank.md"));
		await new Promise((r) => setTimeout(r, 300));
		const t0 = performance.now();
		await app.workspace.openLinkText(path, "", false);
		// The first frame painted once the map has placed its topics.
		const end = await new Promise((resolve) => {
			const tick = () => {
				const v = app.workspace.getMostRecentLeaf()?.view;
				if (v?.getViewType() === "mindmap-markdown" && v.shown?.size > 0) setTimeout(() => resolve(performance.now()), 0);
				else if (performance.now() - t0 > 60000) resolve(null);
				else requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		return end === null ? null : end - t0;
	}, `Map ${n}`);
}

// Selects a topic by outline path and gives the map the keyboard.
async function selectPath(path) {
	await ev((path) => {
		const v = __kit.patch();
		let n = v.doc.root;
		for (const i of path) n = n.children[i];
		v.select(n);
		v.viewport.focus();
	}, path);
	await wait(300);
}

// The editing actions, each REPS times: (b) typing starts an edit (F2 is
// Obsidian's rename), more keys, Enter; (c) Tab adds a child, Escape drops
// it; (d) Space folds and unfolds the biggest top-level branch.
async function actions(n, leafPath, reps = REPS) {
	const editStart = [], typeChar = [], commit = [], tab = [], cancel = [], fold = [], unfold = [];
	const animFrames = [];
	for (let i = 0; i < reps; i++) {
		await selectPath(leafPath);
		editStart.push((await timedKey("x", 300)).ms);
		for (const ch of "abc") typeChar.push((await timedKey(ch, 150)).ms);
		const c = await timedKey("Enter");
		commit.push(c.ms);
		animFrames.push(...c.frames);
		await wait(300);
		await selectPath(leafPath.slice(0, -1));
		const t = await timedKey("Tab");
		tab.push(t.ms);
		animFrames.push(...t.frames);
		cancel.push((await timedKey("Escape")).ms);
		await selectPath([maps[n].bigBranch]);
		const f = await timedKey("Space", 700);
		fold.push(f.ms);
		animFrames.push(...f.frames);
		const u = await timedKey("Space", 700);
		unfold.push(u.ms);
		animFrames.push(...u.frames);
	}
	return {
		editStart: median(editStart),
		typeChar: median(typeChar),
		commit: median(commit),
		tab: median(tab),
		cancel: median(cancel),
		fold: median(fold),
		unfold: median(unfold),
		anim: stats(animFrames),
	};
}

async function bench(n, rate, mode) {
	const r = { size: n, topics: maps[n].topics, throttle: rate, mode };
	await throttle(1);
	const opens = [];
	for (let i = 0; i < REPS; i++) {
		await throttle(rate);
		opens.push(await openMap(n));
		await throttle(1);
		await wait(500);
	}
	r.open = median(opens);
	r.nodes = await ev(() => document.querySelectorAll(".workspace-leaf.mod-active .mm-node").length);
	await throttle(rate);
	await wait(300);
	// A leaf deep in the middle of the biggest branch.
	const leafPath = await ev((big) => {
		let n = __kit.view().doc.root.children[big];
		const path = [big];
		while (n.children.length) {
			const i = Math.floor(n.children.length / 2);
			path.push(i);
			n = n.children[i];
		}
		return path;
	}, maps[n].bigBranch);
	// Everything twice: zoomed to fit (the whole map, so most topics are on
	// screen: the worst case) and at 100%, the zoom people edit at.
	r.fit = await actions(n, leafPath);
	await ev(() => {
		const v = __kit.view();
		v.zoomBy(1 / v.scale);
	});
	r.full = await actions(n, leafPath);
	// With the outline pane open too, which mirrors every change.
	await ev(() => app.commands.executeCommandById("mindmap-markdown:show-outline"));
	await wait(1500);
	await ev(() => app.workspace.setActiveLeaf(app.workspace.getLeavesOfType("mindmap-markdown")[0], { focus: true }));
	await wait(300);
	r.outline = await actions(n, leafPath, 1);
	await ev(() => app.workspace.getLeavesOfType("mindmap-markdown-outline").forEach((l) => l.detach()));
	await wait(300);
	await ev(() => __kit.view().fit());
	await wait(300);

	// (f) Pan and zoom.
	const vp = await page.locator(".workspace-leaf.mod-active .mm-viewport").boundingBox();
	await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
	await ev(() => __kit.startFrames());
	for (let i = 0; i < 40; i++) {
		await page.mouse.wheel(i % 20 < 10 ? 25 : -25, i % 20 < 10 ? 30 : -30);
		await wait(16);
	}
	await wait(200);
	r.pan = stats(await ev(() => __kit.stopFrames()));
	await page.keyboard.down("Control");
	await ev(() => __kit.startFrames());
	for (let i = 0; i < 40; i++) {
		await page.mouse.wheel(0, i % 20 < 10 ? -20 : 20);
		await wait(16);
	}
	await wait(200);
	await page.keyboard.up("Control");
	r.zoom = stats(await ev(() => __kit.stopFrames()));

	// (g) Serialising for a save.
	r.serialize = await ev(() => {
		const v = __kit.view();
		const was = v.mapEdited;
		v.mapEdited = true;
		const t0 = performance.now();
		for (let i = 0; i < 5; i++) v.getViewData();
		const ms = (performance.now() - t0) / 5;
		v.mapEdited = was;
		return Math.round(ms * 10) / 10;
	});
	await throttle(1);
	// Forget the benchmark's undo steps; its edits stay in the file.
	await ev(() => __kit.view().undoStack.length = 0);
	return r;
}

const results = [];
const configs = [];
for (const n of SIZES) for (const rate of [1, 4]) configs.push({ n, rate, mode: "desktop" });
if (MOBILE && SIZES.includes(1000)) configs.push({ n: 1000, rate: 4, mode: "mobile" });
for (const c of configs) {
	for (let attempt = 1; ; attempt++) {
		try {
			await start(c.mode === "mobile");
			const r = await bench(c.n, c.rate, c.mode);
			results.push(r);
			console.log(JSON.stringify(r));
			await finish();
			break;
		} catch (e) {
			await finish();
			const msg = String(e.message ?? e).split("\n")[0];
			if (attempt < 3) {
				console.log(`# ${c.n} ${c.mode} ${c.rate}x: ${msg}; retrying in a new Obsidian`);
				continue;
			}
			console.log(`not ok - ${c.n} ${c.mode} ${c.rate}x\n  ${String(e.stack ?? e)}`);
			process.exitCode = 1;
			break;
		}
	}
}

const out = join(plugin, ".test-build", "perf");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${LABEL}.json`), JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2));

const actionCols = (k) => [
	["edit", (r) => r[k]?.editStart],
	["key", (r) => r[k]?.typeChar],
	["Enter", (r) => r[k]?.commit],
	["Tab", (r) => r[k]?.tab],
	["Esc", (r) => r[k]?.cancel],
	["fold", (r) => r[k]?.fold],
	["unfold", (r) => r[k]?.unfold],
	["anim max/long", (r) => r[k] && `${r[k].anim.max}/${r[k].anim.long}`],
];
const head = [
	["topics", (r) => r.topics],
	["mode", (r) => `${r.mode}${r.throttle > 1 ? ` ${r.throttle}x` : ""}`],
];
const tables = [
	["open, pan, zoom, save", [
		...head,
		["open", (r) => r.open],
		["pan p95/max", (r) => `${r.pan.p95}/${r.pan.max}`],
		["zoom p95/max", (r) => `${r.zoom.p95}/${r.zoom.max}`],
		["save", (r) => r.serialize],
	]],
	["editing, zoomed to fit (the whole map on screen)", [...head, ...actionCols("fit")]],
	["editing at 100% zoom", [...head, ...actionCols("full")]],
	["editing at 100% zoom with the outline pane open", [...head, ...actionCols("outline")]],
];
const table = (rows, title, cols) => {
	const cells = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => String(c[1](r) ?? "—")))];
	const w = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
	console.log(`\n${title}`);
	for (const row of cells) console.log(row.map((c, i) => c.padStart(w[i])).join("  "));
};
const before = process.env.PERF_COMPARE && existsSync(process.env.PERF_COMPARE)
	? JSON.parse(readFileSync(process.env.PERF_COMPARE, "utf8")).results
	: null;
console.log("\nms; anim = frame intervals after the first frame: worst / count over 50 ms");
for (const [title, cols] of tables) {
	if (before) table(before, `${title}: before (${process.env.PERF_COMPARE})`, cols);
	table(results, `${title}: ${LABEL}`, cols);
}
if (errors.length) console.log(`\nconsole errors:\n  ${errors.join("\n  ")}`);
process.exit(process.exitCode ?? 0);
