import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, serialize } from "../src/model";
import { inDocumentOrder, insertSibling, isAncestor, move, moveAll, remove, removeAll, reorder, topmost } from "../src/ops";

const tree = () => parse("# R\n\n- a\n\t- a1\n\t- a2\n- b\n- c\n");
const texts = (n: { children: { text: string }[] }) => n.children.map((c) => c.text);

test("move reparents a branch with its children", () => {
	const doc = tree();
	const [a, b] = doc.root.children;
	assert.equal(move(doc.root, a, b, 0), true);
	assert.deepEqual(texts(doc.root), ["b", "c"]);
	assert.deepEqual(texts(b), ["a"]);
	assert.deepEqual(texts(b.children[0]), ["a1", "a2"]);
});

test("move refuses to put a node inside its own branch, or to move the root", () => {
	const doc = tree();
	const a = doc.root.children[0];
	assert.equal(move(doc.root, a, a.children[0], 0), false);
	assert.equal(move(doc.root, a, a, 0), false);
	assert.equal(move(doc.root, doc.root, a, 0), false);
	assert.deepEqual(texts(doc.root), ["a", "b", "c"]);
});

test("moving down among the same siblings uses before-move positions", () => {
	const doc = tree();
	const a = doc.root.children[0];
	assert.equal(move(doc.root, a, doc.root, 3), true);
	assert.deepEqual(texts(doc.root), ["b", "c", "a"]);
	assert.equal(move(doc.root, a, doc.root, 3), false, "dropping where it already is changes nothing");
});

test("move into a collapsed topic unfolds it", () => {
	const doc = tree();
	const [a, b] = doc.root.children;
	a.collapsed = true;
	move(doc.root, b, a, 0);
	assert.equal(a.collapsed, false);
});

test("remove selects next, previous, then parent", () => {
	const doc = tree();
	const [a, b, c] = doc.root.children;
	assert.equal(remove(doc.root, b), c);
	assert.equal(remove(doc.root, c), a);
	assert.equal(remove(doc.root, a), doc.root);
	assert.equal(remove(doc.root, doc.root), null);
});

test("insertSibling and reorder", () => {
	const doc = tree();
	const [a, , c] = doc.root.children;
	const x = parse("# x").root;
	assert.equal(insertSibling(doc.root, a, x, true), true);
	assert.deepEqual(texts(doc.root), ["x", "a", "b", "c"]);
	assert.equal(reorder(doc.root, c, 1), false);
	assert.equal(reorder(doc.root, c, -1), true);
	assert.deepEqual(texts(doc.root), ["x", "a", "c", "b"]);
});

test("topmost drops nodes inside another selected branch", () => {
	const doc = tree();
	const a = doc.root.children[0];
	assert.deepEqual(topmost([a.children[0], a, doc.root.children[2]]).map((n) => n.text), ["a", "c"]);
	assert.equal(isAncestor(a, a.children[1]), true);
});

test("branch colours round-trip and follow their topic through a move", () => {
	const src = '# R\n\n- a\n- b\n\n%% mindmap-settings\n{"colors":{"1":"green"}}\n%%\n';
	const doc = parse(src);
	assert.equal(doc.root.children[1].color, "green");
	assert.equal(serialize(doc), src);
	move(doc.root, doc.root.children[1], doc.root, 0);
	assert.match(serialize(doc), /"colors":\{"0":"green"\}/);
});

test("unknown layouts and colours are ignored, known new layouts are kept", () => {
	assert.equal(parse('# R\n\n%% mindmap-settings\n{"layout":"spiral"}\n%%\n').settings.layout, "balanced");
	assert.equal(parse('# R\n\n%% mindmap-settings\n{"layout":"down"}\n%%\n').settings.layout, "down");
	assert.equal(parse('# R\n\n- a\n\n%% mindmap-settings\n{"colors":{"0":"chartreuse"}}\n%%\n').root.children[0].color, undefined);
});

test("moveAll moves several branches together, keeping their order", () => {
	const doc = tree();
	const [a, b, c] = doc.root.children;
	assert.equal(moveAll(doc.root, [a, c], b, b.children.length), true);
	assert.deepEqual(texts(doc.root), ["b"]);
	assert.deepEqual(texts(b), ["a", "c"]);
	assert.deepEqual(texts(a), ["a1", "a2"], "branches travel whole");
});

test("moveAll inserts before the first unmoved topic at the index", () => {
	const doc = tree();
	const [a, b, c] = doc.root.children;
	const [a1, a2] = a.children;
	// Drop a2 and c into the gap before b.
	assert.equal(moveAll(doc.root, [a2, c], doc.root, 1), true);
	assert.deepEqual(texts(doc.root), ["a", "a2", "c", "b"]);
	assert.deepEqual(texts(a), ["a1"]);
	// Dropping a2 into the gap after itself changes nothing.
	assert.equal(moveAll(doc.root, [doc.root.children[1]], doc.root, 2), false);
	assert.equal(a1.text, "a1");
	assert.equal(b.text, "b");
});

test("moveAll refuses the root or a drop inside a moved branch, leaving the tree alone", () => {
	const doc = tree();
	const [a, b] = doc.root.children;
	assert.equal(moveAll(doc.root, [b, a], a.children[0], 0), false);
	assert.equal(moveAll(doc.root, [doc.root], b, 0), false);
	assert.equal(moveAll(doc.root, [], b, 0), false);
	assert.deepEqual(texts(doc.root), ["a", "b", "c"]);
	assert.deepEqual(texts(a), ["a1", "a2"]);
});

test("inDocumentOrder sorts by position in the outline", () => {
	const doc = tree();
	const [a, b, c] = doc.root.children;
	assert.deepEqual(inDocumentOrder(doc.root, [c, a.children[1], b, a]).map((n) => n.text), ["a", "a2", "b", "c"]);
});

test("removeAll deletes the topmost topics and picks a surviving topic to select", () => {
	const doc = tree();
	const [a, b, c] = doc.root.children;
	assert.equal(removeAll(doc.root, [a.children[0], a, c]), b);
	assert.deepEqual(texts(doc.root), ["b"]);
	assert.equal(removeAll(doc.root, [doc.root]), null, "the root is never removed");
	assert.equal(removeAll(doc.root, [b]), doc.root);
});
