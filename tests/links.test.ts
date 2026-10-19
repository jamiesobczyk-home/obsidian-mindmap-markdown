import assert from "node:assert/strict";
import { test } from "node:test";
import { linkPath } from "../src/layout";
import { linksToRecords, parse, recordsToLinks, serialize } from "../src/model";
import { addLink, move, removeAll, removeLink } from "../src/ops";

const MAP = `# House

- Kitchen
	- New fridge
- Budget
	- Appliances

%% mindmap-settings
{"links":[{"from":"0.0","to":"1.0","label":"costs"}]}
%%
`;

test("links round-trip byte for byte", () => {
	assert.equal(serialize(parse(MAP)), MAP);
});

test("links resolve to the topics they join", () => {
	const doc = parse(MAP);
	assert.equal(doc.links.length, 1);
	assert.equal(doc.links[0].from.text, "New fridge");
	assert.equal(doc.links[0].to.text, "Appliances");
	assert.equal(doc.links[0].label, "costs");
});

test("a link follows its topics when they move", () => {
	const doc = parse(MAP);
	const [kitchen, budget] = doc.root.children;
	move(doc.root, budget, doc.root, 0);
	assert.match(serialize(doc), /"from":"1\.0","to":"0\.0"/);
	move(doc.root, kitchen.children[0], budget, 0);
	assert.match(serialize(doc), /"from":"0\.0","to":"0\.1"/);
});

test("deleting a topic drops its links, and only its links", () => {
	const doc = parse(MAP);
	const fridge = doc.root.children[0].children[0];
	assert.equal(addLink(doc, doc.root.children[0], doc.root.children[1]), true);
	removeAll(doc.root, [fridge]);
	const out = serialize(doc);
	assert.doesNotMatch(out, /costs/);
	assert.match(out, /"links":\[\{"from":"0","to":"1"\}\]/);
});

test("addLink refuses self-links and exact duplicates; removeLink removes", () => {
	const doc = parse(MAP);
	const [k, b] = doc.root.children;
	assert.equal(addLink(doc, k, k), false);
	assert.equal(addLink(doc, k, b, "x"), true);
	assert.equal(addLink(doc, k, b), false, "same direction twice");
	assert.equal(addLink(doc, b, k), true, "the reverse is a different link");
	assert.equal(removeLink(doc, doc.links[1]), true);
	assert.equal(doc.links.length, 2);
});

test("the root can be a link end", () => {
	const doc = parse("# R\n\n- a\n");
	addLink(doc, doc.root.children[0], doc.root, "back to the centre");
	const out = serialize(doc);
	assert.match(out, /"from":"0","to":""/);
	const again = parse(out);
	assert.equal(again.links[0].to, again.root);
});

test("links that don't resolve are kept verbatim rather than lost", () => {
	const src = '# R\n\n- a\n\n%% mindmap-settings\n{"links":[{"from":"0","to":"7.3"},"junk"]}\n%%\n';
	const doc = parse(src);
	assert.equal(doc.links.length, 0);
	assert.equal(doc.unsupported.length, 0);
	assert.equal(serialize(doc), src);
});

test("records convert both ways, for undo snapshots", () => {
	const doc = parse(MAP);
	const recs = linksToRecords(doc.root, doc.links);
	assert.deepEqual(recs, [{ from: "0.0", to: "1.0", label: "costs" }]);
	const again = recordsToLinks(doc.root, recs);
	assert.equal(again[0].from, doc.links[0].from);
});

test("linkPath runs between the facing edges of two boxes and labels the middle", () => {
	const a = { x: 0, y: 0, w: 100, h: 30, side: "right" as const, branch: 0 };
	const b = { x: 300, y: 200, w: 100, h: 30, side: "right" as const, branch: 1 };
	const p = linkPath(a, b);
	const nums = p.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
	const [sx, sy] = nums;
	const [ex, ey] = nums.slice(-2);
	const onEdge = (x: number, y: number, box: typeof a) =>
		x >= box.x - 0.5 && x <= box.x + box.w + 0.5 && y >= box.y - 0.5 && y <= box.y + box.h + 0.5 &&
		(Math.abs(x - box.x) < 0.5 || Math.abs(x - box.x - box.w) < 0.5 || Math.abs(y - box.y) < 0.5 || Math.abs(y - box.y - box.h) < 0.5);
	assert.ok(onEdge(sx, sy, a), "starts on the source box edge");
	assert.ok(onEdge(ex, ey, b), "ends on the target box edge");
	assert.ok(p.labelX > 100 && p.labelX < 300 && p.labelY > 15 && p.labelY < 215);
	assert.ok(!/NaN/.test(p.d));
});

test("linkPath copes with boxes that overlap or touch", () => {
	const a = { x: 0, y: 0, w: 100, h: 30, side: "right" as const, branch: 0 };
	assert.ok(!/NaN/.test(linkPath(a, { ...a, x: 50 }).d));
	assert.ok(!/NaN/.test(linkPath(a, a).d));
});
