// The pure helpers behind large-map performance: what's on screen, and
// animating only that. Also checks the benchmark's generated maps are real
// maps, so the numbers measure what users would open.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Box } from "../src/layout";
import { MindNode, countDescendants, parse, serialize } from "../src/model";
import { interpolateLayout, meetsRect, onScreenTopics, visibleMapRect } from "../src/interaction";
// @ts-expect-error: a plain .mjs module shared with the benchmark, without types.
import { generateMap } from "./perf/genmap.mjs";

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h, side: "right", branch: 0 });

test("visibleMapRect turns the viewport into map coordinates, with a margin in screen pixels", () => {
	// Canvas moved 100 right and 50 down, at scale 1: map x 0 sits at screen x 100.
	assert.deepEqual(visibleMapRect({ w: 800, h: 600 }, 100, 50, 1), { x: -100, y: -50, w: 800, h: 600 });
	// At scale 2 the view covers half as much map; the margin shrinks with it.
	assert.deepEqual(visibleMapRect({ w: 800, h: 600 }, 0, 0, 2, 100), { x: -50, y: -50, w: 500, h: 400 });
	// Zoomed out to 0.5 it covers twice as much.
	assert.deepEqual(visibleMapRect({ w: 400, h: 300 }, 10, 20, 0.5), { x: -20, y: -40, w: 800, h: 600 });
});

test("meetsRect counts any overlap but not boxes that only touch", () => {
	const r = { x: 0, y: 0, w: 100, h: 100 };
	assert.ok(meetsRect(box(50, 50, 10, 10), r));
	assert.ok(meetsRect(box(-10, -10, 20, 20), r), "overlapping a corner");
	assert.ok(meetsRect(box(-50, -50, 300, 300), r), "covering it");
	assert.ok(!meetsRect(box(100, 0, 10, 10), r), "touching the right edge");
	assert.ok(!meetsRect(box(0, -10, 10, 10), r), "touching the top edge");
	assert.ok(!meetsRect(box(200, 200, 10, 10), r));
});

test("onScreenTopics keeps topics that start or end on screen, and new ones that arrive there", () => {
	const view = { x: 0, y: 0, w: 100, h: 100 };
	const from = new Map([
		["stays", box(10, 10, 10, 10)],
		["leaves", box(20, 20, 10, 10)],
		["arrives", box(500, 500, 10, 10)],
		["away", box(500, 0, 10, 10)],
	]);
	const to = new Map([
		["stays", box(15, 15, 10, 10)],
		["leaves", box(800, 20, 10, 10)],
		["arrives", box(50, 50, 10, 10)],
		["away", box(600, 0, 10, 10)],
		["new here", box(30, 30, 10, 10)],
		["new away", box(900, 900, 10, 10)],
	]);
	assert.deepEqual([...onScreenTopics(from, to, view)].sort(), ["arrives", "leaves", "new here", "stays"]);
});

test("interpolateLayout with only glides those topics and puts the rest at their final boxes", () => {
	const from = new Map([
		["a", box(0, 0, 10, 10)],
		["b", box(0, 100, 10, 10)],
	]);
	const to = new Map([
		["a", box(100, 0, 10, 10)],
		["b", box(100, 100, 10, 10)],
		["c", box(200, 0, 10, 10)],
	]);
	const half = interpolateLayout(from, to, 0.5, () => null, new Set(["a", "c"]));
	assert.equal(half.get("a")!.box.x, 50);
	assert.deepEqual(half.get("b"), { box: to.get("b"), opacity: 1 }, "b jumps");
	assert.equal(half.get("c")!.opacity, 0.5, "a new topic still fades in");
	// Without only, every topic glides, as before.
	assert.equal(interpolateLayout(from, to, 0.5, () => null).get("b")!.box.x, 50);
});

test("the benchmark's generated maps open as editable maps of the stated size and survive a save", () => {
	for (const n of [200, 1000, 3000]) {
		const g = generateMap(n);
		const doc = parse(g.markdown);
		assert.deepEqual(doc.unsupported, [], `${n}: lines the map can't hold`);
		assert.equal(1 + countDescendants(doc.root), n);
		assert.ok(g.maxDepth >= 3 && g.maxDepth <= 6, `${n}: depth ${g.maxDepth}`);
		assert.ok(doc.links.length > 0 && doc.summaries.length > 0, `${n}: links and summaries`);
		const boundaries: MindNode[] = [];
		const walk = (m: MindNode): void => {
			if (m.boundary !== undefined) boundaries.push(m);
			m.children.forEach(walk);
		};
		walk(doc.root);
		assert.ok(boundaries.length > 0, `${n}: boundaries`);
		const again = parse(serialize(doc));
		assert.equal(serialize(again), serialize(doc), `${n}: save is stable`);
		assert.equal(1 + countDescendants(again.root), n);
	}
});
