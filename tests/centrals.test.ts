import assert from "node:assert/strict";
import { test } from "node:test";
import { bounds, layoutTree } from "../src/layout";
import { centralsOf, isCentral, newNode, parse, serialize } from "../src/model";
import { detachAsCentral, insertChild, move } from "../src/ops";

const MAP = `# House

- Kitchen
	- Fridge

# Garden

- Beds
	- Tomatoes

# Garage

%% mindmap-settings
{"collapsed":["1"],"links":[{"from":"0.0","to":"1.0.0"}]}
%%
`;

test("each level-1 heading is a central topic, and the file round-trips", () => {
	const doc = parse(MAP);
	assert.equal(doc.unsupported.length, 0);
	assert.equal(doc.root.text, "House");
	assert.deepEqual(centralsOf(doc.root).map((c) => c.text), ["Garden", "Garage"]);
	assert.deepEqual(doc.root.children.filter((c) => !isCentral(doc.root, c)).map((c) => c.text), ["Kitchen"]);
	assert.equal(centralsOf(doc.root)[0].children[0].children[0].text, "Tomatoes");
	assert.equal(serialize(doc), MAP);
});

test("a map with one heading saves exactly as before", () => {
	const src = "# R\n\n- a\n\t- b\n";
	assert.equal(serialize(parse(src)), src);
});

test("settings paths count central topics after the first heading's own topics", () => {
	const doc = parse(MAP);
	const garden = centralsOf(doc.root)[0];
	assert.equal(garden.collapsed, true, '"1" is Garden: the first heading has one topic, Kitchen, at 0');
	assert.equal(doc.links[0].to.text, "Tomatoes");
});

test("a topic added to the first centre after the others still saves under it", () => {
	const doc = parse(MAP);
	insertChild(doc.root, newNode("Hall"));
	const out = serialize(doc);
	assert.match(out, /# House\n\n- Kitchen\n\t- Fridge\n- Hall\n\n# Garden/);
	assert.equal(serialize(parse(out)), out);
	assert.match(out, /"collapsed":\["2"\]/, "Garden's path moves up by one");
	assert.match(out, /"to":"2\.0\.0"/);
});

test("moving a central topic under another topic makes it an ordinary topic", () => {
	const doc = parse(MAP);
	const garage = centralsOf(doc.root)[1];
	move(doc.root, garage, doc.root.children[0], 0);
	assert.equal(isCentral(doc.root, garage), false);
	assert.match(serialize(doc), /- Kitchen\n\t- Garage\n\t- Fridge/);
});

test("detachAsCentral turns a topic into its own central topic", () => {
	const doc = parse("# R\n\n- a\n\t- a1\n- b\n");
	const a = doc.root.children[0];
	assert.equal(detachAsCentral(doc.root, a), true);
	assert.equal(serialize(doc), "# R\n\n- b\n\n# a\n\n- a1\n");
	assert.equal(detachAsCentral(doc.root, a), false, "already central");
	assert.equal(detachAsCentral(doc.root, doc.root), false);
});

test("a second-level heading before the list is part of the centre's note; after it, read-only", () => {
	const doc = parse("# R\n\n## Sub\n");
	assert.equal(doc.unsupported.length, 0);
	assert.equal(doc.root.note, "## Sub");
	assert.equal(serialize(doc), "# R\n\n## Sub\n");
	assert.equal(parse("# R\n\n- a\n\n## Sub\n").unsupported.length, 1);
});

test("layout places central topics beside the main tree without overlap", () => {
	const doc = parse(MAP);
	const garden = centralsOf(doc.root)[0];
	garden.collapsed = false;
	const boxes = layoutTree(doc.root, () => ({ w: 100, h: 30 }), "balanced");
	const all = [...boxes.entries()];
	for (let i = 0; i < all.length; i++)
		for (let j = i + 1; j < all.length; j++) {
			const [, a] = all[i];
			const [, b] = all[j];
			const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
			assert.ok(!overlap, `${all[i][0].text} overlaps ${all[j][0].text}`);
		}
	assert.equal(boxes.get(garden)!.side, "root", "central topics are drawn as centres");
	const inMain = new Set([doc.root]);
	const add = (n: typeof doc.root): void => (inMain.add(n), n.children.forEach(add));
	doc.root.children.filter((c) => !isCentral(doc.root, c)).forEach(add);
	const main = bounds([...boxes].filter(([n]) => inMain.has(n)).map(([, b]) => b));
	assert.ok(boxes.get(garden)!.x > main.maxX, "Garden sits to the right of the main tree");
	assert.ok(boxes.get(centralsOf(doc.root)[1])!.x > boxes.get(garden)!.x, "Garage after Garden");
});

test("exports treat each central topic as its own heading and tree", async () => {
	const { toMarkdownOutline, toSVG } = await import("../src/export");
	const doc = parse(MAP);
	assert.equal(toMarkdownOutline(doc), "# House\n\n- Kitchen\n\t- Fridge\n\n# Garden\n\n- Beds\n\t- Tomatoes\n\n# Garage\n");
	const svg = toSVG(doc, layoutTree(doc.root, () => ({ w: 80, h: 24 }), "balanced"));
	// House→Kitchen, Kitchen→Fridge; Garden is folded; no line from House to Garden or Garage.
	assert.equal((svg.match(/<path d=/g) ?? []).length, 2);
	assert.equal((svg.match(/rx="12"/g) ?? []).length, 3, "three centres drawn as centres");
});

test("reordering central topics keeps them central; dropping between them makes one", () => {
	const doc = parse("# A\n\n- x\n\n# B\n\n- y\n\n# C\n\n- z\n");
	const [x, b, c] = doc.root.children;
	move(doc.root, c, doc.root, doc.root.children.indexOf(b));
	assert.equal(serialize(doc), "# A\n\n- x\n\n# C\n\n- z\n\n# B\n\n- y\n");
	move(doc.root, b.children[0], doc.root, doc.root.children.indexOf(b));
	assert.equal(isCentral(doc.root, doc.root.children.find((n) => n.text === "y")!), true, "between C and B");
	move(doc.root, c, doc.root, 0);
	assert.equal(isCentral(doc.root, c), false, "next to an own topic, it joins A's list");
	void x;
});
