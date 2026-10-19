import assert from "node:assert/strict";
import { test } from "node:test";
import { Box, edgePath, layoutTree, nearestInDirection } from "../src/layout";
import { LAYOUTS, Layout, MindNode, newNode, parse } from "../src/model";

// Small seeded generator so "random" trees are the same on every run.
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function randomTree(seed: number): { root: MindNode; sizes: Map<MindNode, { w: number; h: number }> } {
	const r = rng(seed);
	const sizes = new Map<MindNode, { w: number; h: number }>();
	const make = (depth: number): MindNode => {
		const n = newNode(`n${depth}`);
		sizes.set(n, { w: 30 + Math.floor(r() * 200), h: 20 + Math.floor(r() * 40) });
		const kids = depth === 0 ? 2 + Math.floor(r() * 5) : depth < 4 ? Math.floor(r() * 4) : 0;
		for (let i = 0; i < kids; i++) n.children.push(make(depth + 1));
		if (n.children.length > 0 && depth > 0 && r() < 0.15) n.collapsed = true;
		return n;
	};
	return { root: make(0), sizes };
}

const overlaps = (a: Box, b: Box) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Visible nodes with their depth and parent, in document order.
function walk(root: MindNode): { n: MindNode; depth: number; parent: MindNode | null }[] {
	const out: { n: MindNode; depth: number; parent: MindNode | null }[] = [];
	const go = (n: MindNode, depth: number, parent: MindNode | null) => {
		out.push({ n, depth, parent });
		if (!n.collapsed) for (const c of n.children) go(c, depth + 1, n);
	};
	go(root, 0, null);
	return out;
}

const SIZE = () => ({ w: 100, h: 30 });

for (const layout of LAYOUTS) {
	test(`${layout}: no two boxes overlap in random trees`, () => {
		for (let seed = 1; seed <= 40; seed++) {
			const { root, sizes } = randomTree(seed);
			const boxes = [...layoutTree(root, (n) => sizes.get(n)!, layout).values()];
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					assert.ok(!overlaps(boxes[i], boxes[j]), `seed ${seed}: boxes ${i} and ${j} overlap`);
				}
			}
		}
	});

	test(`${layout}: collapsed children are left out and every visible node is placed`, () => {
		const doc = parse("# R\n\n- a\n\t- a1\n\t\t- a11\n- b\n\t- b1\n");
		doc.root.children[0].collapsed = true;
		const boxes = layoutTree(doc.root, SIZE, layout);
		assert.equal(boxes.has(doc.root.children[0].children[0]), false);
		assert.equal(boxes.has(doc.root.children[0].children[0].children[0]), false);
		assert.equal(boxes.size, 4);
	});

	test(`${layout}: branch is the top-level child index`, () => {
		const doc = parse("# R\n\n- a\n\t- a1\n- b\n- c\n\t- c1\n\t\t- c11\n- d\n");
		const boxes = layoutTree(doc.root, SIZE, layout);
		assert.equal(boxes.get(doc.root)!.branch, -1);
		doc.root.children.forEach((c, i) => {
			for (const { n } of walk(c)) assert.equal(boxes.get(n)!.branch, i);
		});
	});

	test(`${layout}: every edge starts on the parent and ends on the child`, () => {
		for (let seed = 1; seed <= 10; seed++) {
			const { root, sizes } = randomTree(seed);
			const boxes = layoutTree(root, (n) => sizes.get(n)!, layout);
			for (const { n, depth, parent } of walk(root)) {
				if (!parent) continue;
				const p = boxes.get(parent)!;
				const c = boxes.get(n)!;
				const nums = edgePath(p, c, depth - 1).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
				assert.ok(onBox(p, nums[0], nums[1]), `${layout} seed ${seed}: edge start off parent`);
				const [ex, ey] = nums.slice(-2);
				assert.ok(onBox(c, ex, ey), `${layout} seed ${seed}: edge end off child`);
			}
		}
	});
}

// On the box or its edge, with a pixel of slack for rounding.
const onBox = (b: Box, x: number, y: number) =>
	x >= b.x - 1 && x <= b.x + b.w + 1 && y >= b.y - 1 && y <= b.y + b.h + 1;

test("down: root on top, each level below the last, parents centred over children", () => {
	for (let seed = 1; seed <= 20; seed++) {
		const { root, sizes } = randomTree(seed);
		const boxes = layoutTree(root, (n) => sizes.get(n)!, "down");
		const r = boxes.get(root)!;
		assert.equal(r.x + r.w / 2, 0);
		for (const { n, parent } of walk(root)) {
			const b = boxes.get(n)!;
			if (parent) {
				assert.equal(b.side, "down");
				assert.ok(b.y > boxes.get(parent)!.y + boxes.get(parent)!.h, "child sits below its parent");
			}
			const kids = n.collapsed ? [] : n.children.map((c) => boxes.get(c)!);
			if (kids.length === 0) continue;
			const left = kids[0].x;
			const right = kids[kids.length - 1].x + kids[kids.length - 1].w;
			assert.ok(Math.abs((left + right) / 2 - (b.x + b.w / 2)) < 1e-6, `seed ${seed}: parent not centred`);
			for (let i = 1; i < kids.length; i++) assert.ok(kids[i].x > kids[i - 1].x + kids[i - 1].w, "siblings run left to right");
		}
	}
});

test("outline: one row per visible node in order, indented by depth", () => {
	for (let seed = 1; seed <= 20; seed++) {
		const { root, sizes } = randomTree(seed);
		const boxes = layoutTree(root, (n) => sizes.get(n)!, "outline");
		const rows = walk(root);
		const r = boxes.get(root)!;
		let prev: Box | null = null;
		const step = rows.length > 1 ? boxes.get(rows[1].n)!.x - r.x : 0;
		for (const { n, depth } of rows) {
			const b = boxes.get(n)!;
			if (prev) assert.ok(b.y >= prev.y + prev.h, `seed ${seed}: rows must run strictly downward`);
			assert.ok(Math.abs(b.x - (r.x + depth * step)) < 1e-6, `seed ${seed}: indent should follow depth`);
			if (depth > 0) assert.equal(b.side, "outline");
			prev = b;
		}
		if (rows.length > 1) assert.ok(step > 0);
	}
});

test("left and right edges are unchanged", () => {
	const p: Box = { x: 0, y: 0, w: 100, h: 30, side: "root", branch: -1 };
	const rc: Box = { x: 156, y: 40, w: 80, h: 20, side: "right", branch: 0 };
	const lc: Box = { x: -136, y: 40, w: 80, h: 20, side: "left", branch: 1 };
	assert.equal(edgePath(p, rc, 0), "M 100 15 C 128 15, 128 50, 156 50");
	assert.equal(edgePath(p, lc, 0), "M 0 15 C -28 15, -28 50, -56 50");
	assert.equal(edgePath(rc, { ...rc, x: 292, y: 80 }, 2), "M 236 60 C 264 60, 264 100, 292 100");
});

const nav = (layout: Layout) => {
	const doc = parse("# R\n\n- a\n\t- a1\n\t- a2\n- b\n\t- b1\n");
	const boxes = layoutTree(doc.root, SIZE, layout);
	const [a, b] = doc.root.children;
	return { root: doc.root, a, b, a1: a.children[0], a2: a.children[1], b1: b.children[0], boxes };
};

// In both layouts the arrows keep the mind-map meaning they have in the
// right-facing layout: one axis moves between parent and child, the other
// between siblings.
test("down: up and down move between levels, left and right along a row", () => {
	const { root, a, b, a1, a2, boxes } = nav("down");
	assert.equal(nearestInDirection(boxes, a, "up"), root);
	assert.equal(nearestInDirection(boxes, a1, "up"), a);
	assert.ok([a1, a2].includes(nearestInDirection(boxes, a, "down")!));
	assert.equal(nearestInDirection(boxes, a, "right"), b);
	assert.equal(nearestInDirection(boxes, b, "left"), a);
	assert.equal(nearestInDirection(boxes, a1, "right"), a2);
	assert.equal(nearestInDirection(boxes, root, "up"), null);
});

test("outline: right steps into a child, left back out, up and down between siblings", () => {
	const { root, a, b, a1, a2, boxes } = nav("outline");
	assert.equal(nearestInDirection(boxes, root, "down"), a);
	assert.equal(nearestInDirection(boxes, a, "right"), a1);
	assert.equal(nearestInDirection(boxes, a1, "left"), a);
	assert.equal(nearestInDirection(boxes, a1, "down"), a2);
	assert.equal(nearestInDirection(boxes, a, "down"), b);
	assert.equal(nearestInDirection(boxes, b, "up"), a);
	assert.equal(nearestInDirection(boxes, root, "up"), null);
});

test("arrow navigation prefers relatives over nearer cousins", () => {
	const doc = parse("# R\n\n- a\n\t- a1\n\t- a2\n- b\n\t- b1\n");
	const [a, b] = doc.root.children;
	const related = (n: typeof a, parent: typeof a | null) => [
		...(parent ? [parent, ...parent.children] : []),
		...n.children,
	];
	const down = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "down");
	assert.ok([a, b].includes(nearestInDirection(down, doc.root, "down", related(doc.root, null))!));
	const outline = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "outline");
	assert.equal(nearestInDirection(outline, b, "right", related(b, doc.root)), b.children[0]);
});
