import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/model";
import { outlineKey, outlineRows, plainTopicText, rowIndexFor, stepCursor } from "../src/outline-rows";

const MAP = `# House

- Kitchen
	- Fridge
	- Oven
- Hall

# Garden

- Beds
	- Tomatoes
		- Cherry

# Garage

%% mindmap-settings
{"collapsed":["2.0"]}
%%
`;

const summary = (md: string) =>
	outlineRows(parse(md).root).map((r) => `${"  ".repeat(r.depth)}${r.node.text}${r.central ? " #" : ""}${r.folded ? ` +${r.hidden}` : ""}`);

test("rows list each central topic as a heading with its tree below, in file order", () => {
	assert.deepEqual(summary(MAP), [
		"House #",
		"  Kitchen",
		"    Fridge",
		"    Oven",
		"  Hall",
		"Garden #",
		"  Beds +2",
		"Garage #",
	]);
});

test("rows carry the topic's saved path, so they match the map's own addressing", () => {
	const rows = outlineRows(parse(MAP).root);
	assert.deepEqual(
		rows.map((r) => r.path),
		["", "0", "0.0", "0.1", "1", "2", "2.0", "3"],
	);
});

test("a folded branch keeps its triangle and hides its children; leaves have no triangle", () => {
	const rows = outlineRows(parse(MAP).root);
	const beds = rows.find((r) => r.node.text === "Beds")!;
	assert.equal(beds.folded, true);
	assert.equal(beds.hasChildren, true);
	const kitchen = rows.find((r) => r.node.text === "Kitchen")!;
	assert.equal(kitchen.folded, false);
	assert.equal(kitchen.hasChildren, true);
	const hall = rows.find((r) => r.node.text === "Hall")!;
	assert.equal(hall.hasChildren, false);
	assert.equal(hall.folded, false);
	assert.equal(rows.find((r) => r.node.text === "Garage")!.hasChildren, false);
});

test("a stray collapsed flag on a leaf doesn't count as folded", () => {
	const doc = parse("# A\n\n- b\n");
	doc.root.children[0].collapsed = true;
	assert.equal(outlineRows(doc.root)[1].folded, false);
});

test("central topics written out of order are still listed after the first centre's own topics", () => {
	const doc = parse("# A\n\n- a1\n\n# B\n");
	// Mid-edit the central topic can sit before an own topic; the file never does.
	doc.root.children.reverse();
	assert.deepEqual(
		outlineRows(doc.root).map((r) => `${r.node.text}:${r.path}`),
		["A:", "a1:1", "B:0"],
	);
});

test("the render key changes with text, structure and folds, but not with node identity alone", () => {
	const a = parse(MAP);
	const b = parse(MAP); // fresh node objects and ids, same content
	const key = (doc: ReturnType<typeof parse>, extra = "") => outlineKey(outlineRows(doc.root), extra);
	assert.notEqual(key(a), "");
	assert.equal(key(a), key(b));
	assert.notEqual(key(a), key(a, "read-only"));
	const before = key(a);
	a.root.children[0].text = "Kitchen v2";
	assert.notEqual(key(a), before);
	const before2 = key(b);
	b.root.children[0].collapsed = true;
	assert.notEqual(key(b), before2);
	const before3 = key(b);
	b.root.children[1].children.push({ id: -1, text: "", children: [], collapsed: false });
	assert.notEqual(key(b), before3, "an added empty topic changes the key");
});

test("text with separators can't make two different outlines share a key", () => {
	const one = parse("# A\n\n- x\n\t- y\n");
	const two = parse("# A\n\n- x\n- y\n");
	assert.notEqual(outlineKey(outlineRows(one.root), ""), outlineKey(outlineRows(two.root), ""));
	const tricky = parse("# A\n\n- x\n");
	tricky.root.children[0].text = "x\n1|0|0|y";
	const plain = parse("# A\n\n- x\n\t- y\n");
	assert.notEqual(outlineKey(outlineRows(tricky.root), ""), outlineKey(outlineRows(plain.root), ""));
});

test("rowIndexFor finds the topic, or the nearest listed ancestor when it's folded away", () => {
	const doc = parse(MAP);
	const rows = outlineRows(doc.root);
	const garden = doc.root.children[2];
	const cherry = garden.children[0].children[0].children[0];
	assert.equal(rows[rowIndexFor(rows, doc.root, garden)].node, garden);
	assert.equal(rows[rowIndexFor(rows, doc.root, cherry)].node.text, "Beds");
	assert.equal(rowIndexFor(rows, doc.root, null), -1);
	assert.equal(rowIndexFor(rows, doc.root, { id: -2, text: "gone", children: [], collapsed: false }), -1);
});

test("stepCursor clamps to the list and starts from the ends when nothing is chosen", () => {
	assert.equal(stepCursor(2, 1, 5), 3);
	assert.equal(stepCursor(4, 1, 5), 4);
	assert.equal(stepCursor(0, -1, 5), 0);
	assert.equal(stepCursor(-1, 1, 5), 0);
	assert.equal(stepCursor(-1, -1, 5), 4);
	assert.equal(stepCursor(-1, 1, 0), -1);
	assert.equal(stepCursor(9, -1, 5), 4, "a stale index past the end comes back into range");
});

test("plainTopicText shows inline Markdown as the words a reader sees", () => {
	assert.equal(plainTopicText("Cabinets **$8k**"), "Cabinets $8k");
	assert.equal(plainTopicText("[[Smith Carpentry]]"), "Smith Carpentry");
	assert.equal(plainTopicText("See [[Notes/Plan|the plan]] and [docs](https://x.y)"), "See the plan and docs");
	assert.equal(plainTopicText("`code` and _em_ and ~~old~~ and ==hi=="), "code and em and old and hi");
	assert.equal(plainTopicText("snake_case_name stays"), "snake_case_name stays");
	assert.equal(plainTopicText("   "), "");
});
