import assert from "node:assert/strict";
import { test } from "node:test";
import { balancedSplit, layoutTree } from "../src/layout";
import { newMapTemplate, parse, serialize } from "../src/model";

const MAP = `---
mindmap-plugin: basic
tags: [planning]
---

# Kitchen remodel

- Budget
	- Cabinets
	- Counters
- Contractors
	- [[Smith Carpentry]]
- Timeline

%% mindmap-settings
{"layout":"right","collapsed":["0"],"future":1}
%%
`;

test("a canonical map round-trips byte for byte", () => {
	assert.equal(serialize(parse(MAP)), MAP);
});

test("the template round-trips", () => {
	const t = newMapTemplate("Central topic");
	assert.equal(serialize(parse(t)), t);
});

test("parses the tree, settings and collapsed state", () => {
	const doc = parse(MAP);
	assert.equal(doc.root.text, "Kitchen remodel");
	assert.deepEqual(
		doc.root.children.map((c) => c.text),
		["Budget", "Contractors", "Timeline"],
	);
	assert.equal(doc.root.children[1].children[0].text, "[[Smith Carpentry]]");
	assert.equal(doc.settings.layout, "right");
	assert.equal(doc.root.children[0].collapsed, true);
	assert.deepEqual(doc.settings.extra, { future: 1 });
	assert.equal(doc.unsupported.length, 0);
});

test("keeps the note's indent and bullet style", () => {
	const src = "# Root\n\n* a\n    * b\n        * c\n";
	assert.equal(serialize(parse(src)), src);
});

test("handles ragged indentation by nesting under the nearest shallower item", () => {
	const doc = parse("# R\n- a\n   - b\n  - c\n- d\n");
	assert.deepEqual(doc.root.children[0].children.map((c) => c.text), ["b", "c"]);
	assert.equal(doc.root.children[1].text, "d");
});

test("flags content the map can't represent instead of dropping it", () => {
	const doc = parse("# Root\n\nSome paragraph.\n\n- a\n\n## Later\n");
	// The paragraph before the list is the centre's note now; the heading after
	// the list still can't be shown.
	assert.equal(doc.root.note, "Some paragraph.");
	assert.deepEqual(
		doc.unsupported.map((u) => u.line),
		[7],
	);
});

test("a note with no heading uses the file name and keeps its list", () => {
	const doc = parse("- a\n- b\n", "Ideas");
	assert.equal(doc.root.text, "Ideas");
	assert.equal(doc.root.children.length, 2);
	assert.equal(serialize(doc), "# Ideas\n\n- a\n- b\n");
});

test("empty frontmatter survives", () => {
	const src = "---\n---\n\n# R\n";
	assert.equal(serialize(parse(src)), src);
});

test("edited text with line breaks is saved on one line", () => {
	const doc = parse("# R\n\n- a\n");
	doc.root.children[0].text = "two\nlines";
	assert.equal(serialize(doc), "# R\n\n- two lines\n");
});

test("a broken settings block makes the note read-only rather than losing lines", () => {
	const doc = parse("# R\n\n- a\n\n%% mindmap-settings\n{not json\n- b\n%%\n");
	assert.equal(doc.root.children.length, 1);
	assert.deepEqual(doc.unsupported.map((u) => u.line), [5]);
});

test("a second settings block is flagged, not silently replaced", () => {
	const block = '%% mindmap-settings\n{"layout":"right"}\n%%\n';
	assert.equal(parse(`# R\n\n${block}\n${block}`).unsupported.length, 1);
});

test("a heading ending in # keeps it unless a space sets off a closing run", () => {
	assert.equal(parse("# C#\n").root.text, "C#");
	assert.equal(parse("# Issue #\n").root.text, "Issue");
	assert.equal(parse("# Issue ##  \n").root.text, "Issue");
	assert.equal(serialize(parse("# C#\n")), "# C#\n");
});

test("balanced split keeps the two sides close in height", () => {
	assert.equal(balancedSplit([10, 10, 10, 10]), 2);
	assert.equal(balancedSplit([50, 10, 10, 10, 10]), 1);
	assert.equal(balancedSplit([10]), 1);
	assert.equal(balancedSplit([]), 0);
});

test("layout puts children beside their parent without overlap", () => {
	const doc = parse("# R\n\n- a\n\t- a1\n\t- a2\n- b\n- c\n- d\n");
	const boxes = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "balanced");
	const root = boxes.get(doc.root)!;
	assert.equal(root.x + root.w / 2, 0);
	const [a, b, c, d] = doc.root.children.map((n) => boxes.get(n)!);
	assert.equal(a.side, "right");
	assert.equal(d.side, "left");
	assert.ok(a.x > root.x + root.w && d.x + d.w < root.x);
	const a1 = boxes.get(doc.root.children[0].children[0])!;
	const a2 = boxes.get(doc.root.children[0].children[1])!;
	assert.ok(a2.y >= a1.y + a1.h, "siblings must not overlap");
	assert.ok(a1.x > a.x + a.w, "children sit outward of their parent");
	void b;
	void c;
});

test("collapsed branches hide their children from layout", () => {
	const doc = parse("# R\n\n- a\n\t- a1\n");
	doc.root.children[0].collapsed = true;
	const boxes = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "right");
	assert.equal(boxes.has(doc.root.children[0].children[0]), false);
});

test("the left side reads bottom to top so the map runs clockwise", () => {
	const doc = parse("# R\n\n- a\n- b\n- c\n- d\n");
	const boxes = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "balanced");
	const [, , c, d] = doc.root.children.map((n) => boxes.get(n)!);
	assert.equal(c.side, "left");
	assert.ok(d.y < c.y, "the last child sits at the top of the left side");
	assert.equal(c.branch, 2);
	assert.equal(d.branch, 3);
});

test("arrow navigation picks the nearest topic in that direction", async () => {
	const { nearestInDirection } = await import("../src/layout");
	const doc = parse("# R\n\n- a\n\t- a1\n\t- a2\n- b\n");
	const boxes = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "right");
	const [a, b] = doc.root.children;
	assert.equal(nearestInDirection(boxes, doc.root, "right"), a);
	assert.equal(nearestInDirection(boxes, a, "left"), doc.root);
	assert.equal(nearestInDirection(boxes, a, "down"), b);
	assert.ok(a.children.includes(nearestInDirection(boxes, a, "right")!));
	assert.equal(nearestInDirection(boxes, doc.root, "left"), null);
});
