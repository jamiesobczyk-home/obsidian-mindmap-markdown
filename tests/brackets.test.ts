import assert from "node:assert/strict";
import { test } from "node:test";
import { toSVG } from "../src/export";
import {
	BOUNDARY_LABEL_H,
	BOUNDARY_PAD,
	BRACE_DEPTH,
	BRACE_GAP,
	Box,
	Extent,
	bounds,
	bracePath,
	decorations,
	layoutTree,
} from "../src/layout";
import { LAYOUTS, Layout, MindNode, parse } from "../src/model";
import { addSummary } from "../src/ops";

const size = () => ({ w: 80, h: 24 });
const lay = (src: string, layout: Layout = "right") => {
	const doc = parse(src);
	doc.settings.layout = layout;
	const boxes = layoutTree(doc.root, size, layout);
	return { doc, boxes };
};
const decor = (src: string, layout: Layout = "right") => {
	const { doc, boxes } = lay(src, layout);
	return { doc, boxes, ...decorations(doc.root, doc.root, boxes, doc.summaries) };
};
const contains = (outer: { x: number; y: number; w: number; h: number }, b: Box | Extent, margin = 0) => {
	const e = "minX" in b ? b : { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
	return (
		outer.x <= e.minX - margin &&
		outer.y <= e.minY - margin &&
		outer.x + outer.w >= e.maxX + margin &&
		outer.y + outer.h >= e.maxY + margin
	);
};
const branchBoxes = (n: MindNode, boxes: Map<MindNode, Box>): Box[] => {
	const b = boxes.get(n);
	return b ? [b, ...n.children.flatMap((c) => branchBoxes(c, boxes))] : [];
};
const settings = (json: object) => `\n%% mindmap-settings\n${JSON.stringify(json)}\n%%\n`;

// ---- Boundaries --------------------------------------------------------------

const TREE = "# R\n\n- a\n\t- a1\n\t\t- a1x\n\t- a2\n- b\n\t- b1\n";

test("a boundary wraps the topic's whole branch, padded, and nothing else", () => {
	const { doc, boxes, boundaries } = decor(TREE + settings({ boundaries: { "0": "" } }));
	const a = doc.root.children[0];
	assert.equal(boundaries.length, 1);
	const r = boundaries[0];
	assert.equal(r.node, a);
	const ext = bounds(branchBoxes(a, boxes));
	assert.deepEqual([r.x, r.y, r.x + r.w, r.y + r.h], [ext.minX - BOUNDARY_PAD, ext.minY - BOUNDARY_PAD, ext.maxX + BOUNDARY_PAD, ext.maxY + BOUNDARY_PAD]);
	for (const n of [doc.root, doc.root.children[1], doc.root.children[1].children[0]]) {
		const b = boxes.get(n)!;
		const inside = r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h;
		assert.ok(!inside, `${n.text} is outside the boundary`);
	}
});

test("a labelled boundary leaves a band at the top for its label, at the top-left", () => {
	const { doc, boxes, boundaries } = decor(TREE + settings({ boundaries: { "0": "Phase one" } }));
	const r = boundaries[0];
	const ext = bounds(branchBoxes(doc.root.children[0], boxes));
	assert.equal(r.y, ext.minY - BOUNDARY_PAD - BOUNDARY_LABEL_H);
	assert.equal(r.labelX, r.x + BOUNDARY_PAD);
	assert.ok(r.labelY > r.y && r.labelY < ext.minY, "label sits in the band above the topics");
});

test("a long label widens its boundary", () => {
	const label = "A very long boundary label that is much wider than the topic";
	const { boundaries } = decor("# R\n\n- a\n" + settings({ boundaries: { "0": label } }));
	assert.ok(boundaries[0].w >= label.length * 7 + 2 * BOUNDARY_PAD);
});

test("nested boundaries don't touch: the outer one pads around the inner one", () => {
	const { doc, boundaries } = decor(TREE + settings({ boundaries: { "0": "outer", "0.0": "inner", "0.0.0": "" } }));
	assert.equal(boundaries.length, 3);
	const [outer, inner, innermost] = boundaries;
	assert.equal(outer.node, doc.root.children[0], "outermost first so inner ones draw on top");
	assert.equal(innermost.node.text, "a1x");
	assert.ok(contains(outer, { minX: inner.x, minY: inner.y, maxX: inner.x + inner.w, maxY: inner.y + inner.h }, BOUNDARY_PAD));
	assert.ok(contains(inner, { minX: innermost.x, minY: innermost.y, maxX: innermost.x + innermost.w, maxY: innermost.y + innermost.h }, BOUNDARY_PAD));
});

test("a folded branch's boundary wraps only what's visible, plus its count badge", () => {
	const { doc, boxes, boundaries } = decor(TREE + settings({ collapsed: ["0"], boundaries: { "0": "" } }));
	const a = boxes.get(doc.root.children[0])!;
	const r = boundaries[0];
	assert.equal(r.x, a.x - BOUNDARY_PAD);
	assert.ok(r.x + r.w >= a.x + a.w + 30, "room for the badge");
	assert.equal(r.h, a.h + 2 * BOUNDARY_PAD);
});

test("boundaries inside a folded branch, or outside the focused one, aren't drawn", () => {
	const { boundaries } = decor(TREE + settings({ collapsed: ["0"], boundaries: { "0.0": "x" } }));
	assert.equal(boundaries.length, 0);
	const doc = parse(TREE + settings({ boundaries: { "1": "b", "0.0": "a1" } }));
	const a = doc.root.children[0];
	const boxes = layoutTree(a, size, "right");
	const focused = decorations(doc.root, a, boxes, doc.summaries);
	assert.deepEqual(focused.boundaries.map((r) => r.node.text), ["a1"]);
});

test("boundaries work in every layout and on further central topics", () => {
	for (const layout of LAYOUTS) {
		const src = TREE + "\n# G\n\n- g1\n\t- g2\n" + settings({ layout, boundaries: { "0": "", "2": "garden", "1.0": "" } });
		const { doc, boxes, boundaries } = decor(src, layout);
		assert.equal(boundaries.length, 3, layout);
		for (const r of boundaries) {
			for (const b of branchBoxes(r.node, boxes)) assert.ok(contains(r, b, BOUNDARY_PAD - 0.01), `${layout}: ${r.node.text}`);
		}
		const garden = boundaries.find((r) => r.node.text === "G")!;
		const main = boxes.get(doc.root)!;
		assert.ok(!contains(garden, main), `${layout}: the central topic's boundary leaves the first centre out`);
	}
});

test("the map's own root never gets a boundary", () => {
	const { doc, boxes } = lay("# R\n\n- a\n");
	doc.root.boundary = "whole";
	assert.equal(decorations(doc.root, doc.root, boxes, []).boundaries.length, 0);
});

// ---- Brace geometry ----------------------------------------------------------

const EXT: Extent = { minX: 100, minY: 0, maxX: 300, maxY: 120 };
const coords = (d: string) => {
	const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
	const pts: { x: number; y: number }[] = [];
	for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
	return pts;
};

test("bracePath on the right: from top to bottom past the extent, tip at the middle, label after it", () => {
	const g = bracePath(EXT, "right");
	const pts = coords(g.d);
	assert.deepEqual(pts[0], { x: 300 + BRACE_GAP, y: 0 });
	assert.deepEqual(pts[pts.length - 1], { x: 300 + BRACE_GAP, y: 120 });
	const tip = pts.reduce((a, b) => (b.x > a.x ? b : a));
	assert.deepEqual(tip, { x: 300 + BRACE_GAP + BRACE_DEPTH, y: 60 });
	assert.ok(pts.every((p) => p.x >= 300 + BRACE_GAP && p.y >= 0 && p.y <= 120));
	assert.ok(g.labelX > tip.x);
	assert.equal(g.labelY, 60);
	assert.equal(g.anchor, "start");
	assert.match(g.d, /^M [\d. -]+( (Q|L) [\d., -]+)+$/);
});

test("bracePath on the left mirrors the right", () => {
	const g = bracePath(EXT, "left");
	const pts = coords(g.d);
	assert.deepEqual(pts[0], { x: 100 - BRACE_GAP, y: 0 });
	const tip = pts.reduce((a, b) => (b.x < a.x ? b : a));
	assert.deepEqual(tip, { x: 100 - BRACE_GAP - BRACE_DEPTH, y: 60 });
	assert.ok(g.labelX < tip.x);
	assert.equal(g.anchor, "end");
});

test("bracePath below, for the org chart: runs left to right under the extent, label centred beneath", () => {
	const g = bracePath(EXT, "down");
	const pts = coords(g.d);
	assert.deepEqual(pts[0], { x: 100, y: 120 + BRACE_GAP });
	assert.deepEqual(pts[pts.length - 1], { x: 300, y: 120 + BRACE_GAP });
	const tip = pts.reduce((a, b) => (b.y > a.y ? b : a));
	assert.deepEqual(tip, { x: 200, y: 120 + BRACE_GAP + BRACE_DEPTH });
	assert.equal(g.labelX, 200);
	assert.ok(g.labelY > tip.y);
	assert.equal(g.anchor, "middle");
});

test("a brace over a very short span still keeps its curls inside the span", () => {
	const g = bracePath({ minX: 0, minY: 0, maxX: 10, maxY: 8 }, "right");
	assert.ok(coords(g.d).every((p) => p.y >= 0 && p.y <= 8));
});

// ---- Summaries in the layout -----------------------------------------------------

const RUN = "# R\n\n- a\n\t- a1\n\t\t- deep and very long topic text\n- b\n- c\n- d\n";

test("a summary brace sits past the furthest descendant of its run, on the outer side", () => {
	for (const layout of LAYOUTS) {
		const { doc, boxes } = lay(RUN, layout);
		const [a, b, , d] = doc.root.children;
		addSummary(doc, [a, b], "First two");
		const { braces } = decorations(doc.root, doc.root, boxes, doc.summaries);
		assert.equal(braces.length, 1, layout);
		const run = bounds([...branchBoxes(a, boxes), ...branchBoxes(b, boxes)]);
		const pts = coords(braces[0].d);
		const side = boxes.get(a)!.side;
		if (side === "down") {
			assert.ok(pts.every((p) => p.y >= run.maxY + BRACE_GAP - 0.1), layout);
			assert.ok(braces[0].labelY > run.maxY + BRACE_GAP + BRACE_DEPTH);
		} else if (side === "left") {
			assert.ok(pts.every((p) => p.x <= run.minX - BRACE_GAP + 0.1), layout);
		} else {
			assert.ok(pts.every((p) => p.x >= run.maxX + BRACE_GAP - 0.1), layout);
			assert.ok(braces[0].labelX > run.maxX + BRACE_GAP + BRACE_DEPTH, layout);
		}
		assert.equal(braces[0].color, a);
		void d;
	}
});

test("left-side summaries face left in the balanced layout", () => {
	const { doc, boxes } = lay("# R\n\n- a\n- b\n- c\n- d\n", "balanced");
	const [, , c, d] = doc.root.children;
	assert.equal(boxes.get(c)!.side, "left");
	addSummary(doc, [c, d], "Left pair");
	const [brace] = decorations(doc.root, doc.root, boxes, doc.summaries).braces;
	assert.equal(brace.anchor, "end");
	assert.ok(brace.labelX < Math.min(boxes.get(c)!.x, boxes.get(d)!.x));
});

test("a summary whose ends are no longer siblings, or are folded away, draws nothing", () => {
	const { doc, boxes } = lay("# R\n\n- a\n\t- a1\n- b\n");
	const [a, b] = doc.root.children;
	doc.summaries.push({ from: a.children[0], to: b, text: "split" });
	doc.summaries.push({ from: b, to: a, text: "backwards" });
	assert.deepEqual(decorations(doc.root, doc.root, boxes, doc.summaries).braces, []);
	const folded = lay("# R\n\n- a\n\t- a1\n\t- a2\n" + settings({ collapsed: ["0"] }));
	const [x1, x2] = folded.doc.root.children[0].children;
	addSummary(folded.doc, [x1, x2], "hidden");
	assert.deepEqual(decorations(folded.doc.root, folded.doc.root, folded.boxes, folded.doc.summaries).braces, []);
});

test("a boundary takes in the braces inside it, and a brace clears the boundaries in its run", () => {
	const { doc, boxes } = lay("# R\n\n- p\n\t- x\n\t\t- x1\n\t- y\n" + settings({ boundaries: { "0": "", "0.0": "" } }));
	const p = doc.root.children[0];
	const [x, y] = p.children;
	addSummary(doc, [x, y], "Both");
	const { boundaries, braces } = decorations(doc.root, doc.root, boxes, doc.summaries);
	const outer = boundaries.find((r) => r.node === p)!;
	const inner = boundaries.find((r) => r.node === x)!;
	const pts = coords(braces[0].d);
	assert.ok(pts.every((q) => q.x >= inner.x + inner.w + BRACE_GAP - 0.1), "brace beyond the inner boundary");
	assert.ok(outer.x + outer.w > braces[0].labelX + "Both".length * 7, "outer boundary holds the label");
});

// ---- Export --------------------------------------------------------------------

test("SVG export draws boundaries behind the topics and braces with their text, inside the frame", () => {
	const { doc, boxes } = lay(TREE + settings({ boundaries: { "0": "Phase <one>" } }), "right");
	addSummary(doc, doc.root.children, "Everything & more");
	const svg = toSVG(doc, boxes);
	assert.match(svg, /<rect class="boundary" [^>]*rx="10"[^>]*fill-opacity="0\.0\d+"/);
	assert.match(svg, /<text class="boundary-label"[^>]*>Phase &lt;one&gt;<\/text>/);
	assert.match(svg, /<path class="summary" d="M /);
	assert.match(svg, /<text class="summary-label"[^>]*font-style="italic"[^>]*>Everything &amp; more<\/text>/);
	assert.ok(svg.indexOf('class="boundary"') < svg.indexOf('class="label"'), "boundary drawn first");
	const [vx, vy, vw, vh] = svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
	const { boundaries, braces } = decorations(doc.root, doc.root, boxes, doc.summaries);
	for (const r of boundaries) assert.ok(r.x >= vx && r.y >= vy && r.x + r.w <= vx + vw && r.y + r.h <= vy + vh);
	const labelEnd = braces[0].labelX + "Everything & more".length * 7;
	assert.ok(labelEnd <= vx + vw, "the frame takes in the summary label");
	assert.doesNotMatch(svg, /undefined|NaN/);
});

test("SVG export without boundaries or summaries draws none", () => {
	const { doc, boxes } = lay(TREE);
	const svg = toSVG(doc, boxes);
	assert.doesNotMatch(svg, /boundary|summary/);
});

test("decoration extents cover boundaries and summary labels, for fit to window", async () => {
	const { decorationExtents, decorations, layoutTree, bounds } = await import("../src/layout");
	const { parse } = await import("../src/model");
	const doc = parse('# R\n\n- a\n- b\n\n%% mindmap-settings\n{"boundaries":{"0":"Phase"},"summaries":[{"from":"0","to":"1","text":"A long summary label"}]}\n%%\n');
	const boxes = layoutTree(doc.root, () => ({ w: 80, h: 24 }), "right");
	const shapes = decorations(doc.root, doc.root, boxes, doc.summaries);
	const all = bounds([...boxes.values(), ...decorationExtents(shapes)]);
	const topics = bounds(boxes.values());
	assert.ok(all.maxX > topics.maxX + 50, "the summary label extends the frame to the right");
	assert.ok(all.minY < topics.minY, "the boundary's label band extends it upward");
});
