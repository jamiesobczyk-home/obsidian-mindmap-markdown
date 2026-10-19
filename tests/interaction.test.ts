import assert from "node:assert/strict";
import { test } from "node:test";
import type { Box } from "../src/layout";
import { MindNode, parse } from "../src/model";
import {
	collapseSelection,
	easeOut,
	edgePan,
	extendSelection,
	interpolateLayout,
	pruneSelection,
	resolveDrop,
	singleSelection,
	toggleSelection,
} from "../src/interaction";

// Boxes are written out by hand so these tests don't depend on layout.ts and
// so they can describe layouts (like "down") that only exist as geometry.
const box = (x: number, y: number, w: number, h: number, side: string, branch = 0): Box =>
	({ x, y, w, h, side, branch }) as Box;

function rightMap() {
	const doc = parse("# R\n\n- a\n\t- a1\n- b\n- c\n");
	const root = doc.root;
	const [a, b, c] = root.children;
	const a1 = a.children[0];
	const boxes = new Map<MindNode, Box>([
		[root, box(-40, -15, 80, 30, "root", -1)],
		[a, box(96, -60, 60, 28, "right")],
		[b, box(96, -14, 60, 28, "right")],
		[c, box(96, 32, 60, 28, "right")],
		[a1, box(210, -58, 40, 24, "right")],
	]);
	return { root, a, b, c, a1, boxes };
}

test("dropping on the middle of a topic makes it the last child", () => {
	const { root, a, b, boxes } = rightMap();
	const d = resolveDrop(root, boxes, { x: 126, y: 0 }, [a])!;
	assert.equal(d.kind, "child");
	assert.equal(d.parent, b);
	assert.equal(d.index, 0);
	assert.equal(d.line, null);
	const onRoot = resolveDrop(root, boxes, { x: 0, y: -12 }, [a])!;
	assert.equal(onRoot.kind, "child", "the centre only takes children");
	assert.equal(onRoot.parent, root);
	assert.equal(onRoot.index, 3);
});

test("the edge of a topic, or the gap beside it, inserts a sibling with a line in the gap", () => {
	const { root, a, b, c, boxes } = rightMap();
	const top = resolveDrop(root, boxes, { x: 120, y: -12 }, [c])!;
	assert.equal(top.kind, "before");
	assert.equal(top.parent, root);
	assert.equal(top.index, 1);
	assert.deepEqual(top.line, { x1: 96, y1: -23, x2: 156, y2: -23 });
	// Just below a, in the gap: the same slot, reached from the other side.
	const gap = resolveDrop(root, boxes, { x: 120, y: -24 }, [c])!;
	assert.equal(gap.target, a);
	assert.equal(gap.kind, "after");
	assert.equal(gap.index, 1);
	assert.deepEqual(gap.line, top.line);
	// Below the last sibling there is no neighbour, so the line sits just outside.
	const end = resolveDrop(root, boxes, { x: 120, y: 58 }, [a])!;
	assert.equal(end.index, 3);
	assert.ok(end.line!.y1 > 60);
	void b;
});

test("a topic can't be dropped into its own branch", () => {
	const { root, a, b, a1, boxes } = rightMap();
	assert.equal(resolveDrop(root, boxes, { x: 230, y: -46 }, [a]), null);
	assert.equal(resolveDrop(root, boxes, { x: 126, y: -46 }, [b, a]), null);
	assert.equal(resolveDrop(root, boxes, { x: 230, y: -46 }, [b])!.parent, a1);
	assert.equal(resolveDrop(root, boxes, { x: 600, y: 400 }, [b]), null, "empty space is no target");
});

test("on a reversed (left, bottom-to-top) side the visual gap maps to the right index", () => {
	const doc = parse("# R\n\n- a\n- b\n- c\n- d\n");
	const root = doc.root;
	const [a, b, c, d] = root.children;
	// Balanced: a, b down the right; c, d up the left, so d is above c.
	const boxes = new Map<MindNode, Box>([
		[root, box(-40, -15, 80, 30, "root", -1)],
		[a, box(96, -30, 60, 28, "right")],
		[b, box(96, 8, 60, 28, "right")],
		[c, box(-156, 8, 60, 28, "left")],
		[d, box(-156, -30, 60, 28, "left")],
	]);
	const between = resolveDrop(root, boxes, { x: -126, y: 10 }, [a])!;
	assert.equal(between.target, c);
	assert.equal(between.index, 3, "between c and d");
	assert.equal(between.line!.y1, 3);
	const belowC = resolveDrop(root, boxes, { x: -126, y: 34 }, [a])!;
	assert.equal(belowC.index, 2, "visually last on the left is before c in the outline");
	const aboveD = resolveDrop(root, boxes, { x: -126, y: -28 }, [a])!;
	assert.equal(aboveD.index, 4);
	// The right-hand neighbour of c is b, but b is on the other side: no line to it.
	const aboveA = resolveDrop(root, boxes, { x: 120, y: -28 }, [c])!;
	assert.equal(aboveA.index, 0);
});

test("siblings laid out side by side get left/right zones and a vertical line", () => {
	const doc = parse("# R\n\n- a\n- b\n- c\n\t- c1\n");
	const root = doc.root;
	const [a, b, c] = root.children;
	const c1 = c.children[0];
	const boxes = new Map<MindNode, Box>([
		[root, box(-40, 0, 80, 30, "root", -1)],
		[a, box(-150, 80, 80, 28, "down")],
		[b, box(-40, 80, 80, 28, "down")],
		[c, box(70, 80, 80, 28, "down")],
		[c1, box(80, 160, 60, 24, "down")],
	]);
	const d = resolveDrop(root, boxes, { x: -36, y: 94 }, [c1])!;
	assert.equal(d.target, b);
	assert.equal(d.kind, "before");
	assert.equal(d.index, 1);
	assert.deepEqual(d.line, { x1: -55, y1: 80, x2: -55, y2: 108 });
	// An only child still picks its axis from the box side.
	const only = resolveDrop(root, boxes, { x: 136, y: 170 }, [a])!;
	assert.equal(only.kind, "after");
	assert.equal(only.parent, c);
	assert.equal(only.line!.x1, only.line!.x2, "vertical line");
});

test("edgePan speeds up towards the viewport edge and is zero in the middle", () => {
	assert.deepEqual(edgePan({ x: 500, y: 300 }, { w: 1000, h: 600 }), { dx: 0, dy: 0 });
	const nearLeft = edgePan({ x: 5, y: 300 }, { w: 1000, h: 600 });
	const lessNearLeft = edgePan({ x: 30, y: 300 }, { w: 1000, h: 600 });
	assert.ok(nearLeft.dx > lessNearLeft.dx && lessNearLeft.dx > 0, "content moves right to show the left");
	const bottomRight = edgePan({ x: 1200, y: 700 }, { w: 1000, h: 600 }, 40, 12);
	assert.deepEqual(bottomRight, { dx: -12, dy: -12 }, "clamped beyond the edge");
});

test("interpolateLayout moves boxes between layouts and grows new topics from their parent", () => {
	const doc = parse("# R\n\n- a\n\t- new\n");
	const root = doc.root;
	const a = root.children[0];
	const fresh = a.children[0];
	const from = new Map<MindNode, Box>([
		[root, box(0, 0, 10, 10, "root", -1)],
		[a, box(100, 0, 20, 10, "right")],
	]);
	const to = new Map<MindNode, Box>([
		[root, box(0, 0, 10, 10, "root", -1)],
		[a, box(100, 40, 20, 10, "right")],
		[fresh, box(160, 40, 30, 10, "right")],
	]);
	const parentOf = (n: MindNode) => (n === fresh ? a : n === a ? root : null);
	const start = interpolateLayout(from, to, 0, parentOf);
	assert.deepEqual(start.get(a)!.box, from.get(a));
	assert.equal(start.get(fresh)!.opacity, 0);
	assert.deepEqual(
		{ ...start.get(fresh)!.box },
		{ ...to.get(fresh)!, x: 110, y: 5, w: 0, h: 0 },
		"new topics start as a point at their parent's old centre",
	);
	const mid = interpolateLayout(from, to, 0.5, parentOf);
	assert.equal(mid.get(a)!.box.y, 20);
	assert.equal(mid.get(fresh)!.opacity, 0.5);
	assert.equal(mid.get(fresh)!.box.w, 15);
	const end = interpolateLayout(from, to, 1, parentOf);
	for (const [n, b] of to) assert.deepEqual(end.get(n)!.box, b);
	assert.equal(easeOut(0), 0);
	assert.equal(easeOut(1), 1);
	assert.ok(easeOut(0.5) > 0.5, "eases out: fast start, gentle landing");
});

test("selection: toggle, extend, collapse and prune", () => {
	const [a, b, c] = ["a", "b", "c"];
	let s = singleSelection(a);
	s = toggleSelection(s, b);
	assert.equal(s.primary, b);
	assert.deepEqual([...s.set], [a, b]);
	s = toggleSelection(s, b);
	assert.equal(s.primary, a, "removing the primary hands focus to the last remaining");
	assert.deepEqual([...s.set], [a]);
	assert.deepEqual([...toggleSelection(s, a).set], [a], "the last topic can't be toggled off");
	s = extendSelection(extendSelection(s, b), c);
	assert.equal(s.primary, c);
	assert.equal(s.set.size, 3);
	assert.deepEqual([...collapseSelection(s).set], [c]);
	const pruned = pruneSelection(s, (n) => n !== c, "root");
	assert.equal(pruned.primary, b);
	assert.deepEqual([...pruned.set], [a, b]);
	assert.equal(pruneSelection(singleSelection(c), () => false, "root").primary, "root");
});
